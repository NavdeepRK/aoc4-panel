/**
 * MCA session heartbeat — keeps the server-side session alive while the service runs.
 *
 * MCA uses short-lived server-side sessions (~4 hr inactivity TTL).  If no request
 * hits MCA within that window the session is invalidated server-side even though the
 * cookies on disk still look valid.
 *
 * This module fires a lightweight authenticated GET to MCA's application-history API
 * every PING_INTERVAL_MS milliseconds.  Each ping resets MCA's inactivity clock.
 * If MCA returns new Set-Cookie headers we write them back to storage-state.json so
 * the on-disk cookies always reflect the latest values.
 *
 * Call `startHeartbeat()` once at server startup.  Call `stopHeartbeat()` on shutdown.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';

const SS_PATH = './storage-state.json';
const PING_INTERVAL_MS = 20 * 60 * 1000; // every 20 minutes
const MCA_PING_HOST = 'www.mca.gov.in';
const MCA_PING_PATH = '/bin/mca/application-history?page=1&pageSize=1';

type StoredCookie = {
  name: string;
  value: string;
  expires: number;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

type StorageState = {
  cookies?: StoredCookie[];
  origins?: unknown[];
};

function log(msg: string): void {
  process.stdout.write(`[heartbeat] ${msg}\n`);
}

/** Read storage-state.json, return null if missing/invalid. */
function readState(): StorageState | null {
  try {
    if (!fs.existsSync(SS_PATH)) return null;
    return JSON.parse(fs.readFileSync(SS_PATH, 'utf8')) as StorageState;
  } catch {
    return null;
  }
}

/** Build Cookie header string from stored MCA cookies (non-expired only). */
function buildCookieHeader(state: StorageState): string {
  const now = Date.now() / 1000;
  return (state.cookies ?? [])
    .filter(c => c.domain?.includes('mca.gov.in'))
    .filter(c => c.expires === -1 || c.expires > now)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Parse a Set-Cookie header value into a partial StoredCookie.
 * Only extracts name, value, expires, path.
 */
function parseSetCookie(raw: string, domain: string): Partial<StoredCookie> | null {
  const parts = raw.split(';').map(s => s.trim());
  const [nameVal, ...attrs] = parts;
  const eq = nameVal.indexOf('=');
  if (eq < 0) return null;
  const name = nameVal.slice(0, eq).trim();
  const value = nameVal.slice(eq + 1).trim();
  let expires = -1;
  let path = '/';
  let httpOnly = false;
  let secure = false;
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower.startsWith('expires=')) {
      const d = new Date(attr.slice(8));
      if (!isNaN(d.getTime())) expires = d.getTime() / 1000;
    } else if (lower.startsWith('max-age=')) {
      const age = parseInt(attr.slice(8), 10);
      if (!isNaN(age)) expires = Date.now() / 1000 + age;
    } else if (lower.startsWith('path=')) {
      path = attr.slice(5).trim();
    } else if (lower === 'httponly') {
      httpOnly = true;
    } else if (lower === 'secure') {
      secure = true;
    }
  }
  return { name, value, expires, domain, path, httpOnly, secure };
}

/**
 * Merge updated cookies back into storage-state.json.
 * Only updates cookies whose name already exists for that domain (no new cookies added).
 */
function mergeAndSaveCookies(newCookies: Partial<StoredCookie>[]): void {
  const state = readState();
  if (!state) return;
  let changed = false;
  for (const nc of newCookies) {
    if (!nc.name || !nc.value) continue;
    const idx = (state.cookies ?? []).findIndex(
      c => c.name === nc.name && c.domain === nc.domain,
    );
    if (idx >= 0) {
      const existing = state.cookies![idx];
      // Only update value + expires — keep other fields stable
      if (existing.value !== nc.value || (nc.expires && nc.expires !== existing.expires)) {
        state.cookies![idx] = { ...existing, value: nc.value, expires: nc.expires ?? existing.expires };
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(SS_PATH, JSON.stringify(state, null, 2), 'utf8');
    log('updated storage-state.json with refreshed cookie values');
  }
}

/** Single heartbeat ping — returns { ok, statusCode, reason }. */
export function pingMca(): Promise<{ ok: boolean; statusCode?: number; reason: string }> {
  return new Promise(resolve => {
    const state = readState();
    if (!state) {
      resolve({ ok: false, reason: 'storage-state.json not found' });
      return;
    }
    const cookieHeader = buildCookieHeader(state);
    if (!cookieHeader) {
      resolve({ ok: false, reason: 'no valid MCA cookies — re-login required' });
      return;
    }

    const options: https.RequestOptions = {
      hostname: MCA_PING_HOST,
      path: MCA_PING_PATH,
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.mca.gov.in/mcafoportal/viewCompanyMasterData.do',
      },
      timeout: 15_000,
    };

    const req = https.request(options, (res: http.IncomingMessage) => {
      // Drain body (required or connection hangs)
      res.resume();

      // Collect any Set-Cookie headers to refresh our stored cookies
      const setCookieHeaders = res.headers['set-cookie'] ?? [];
      if (setCookieHeaders.length > 0) {
        const parsed = setCookieHeaders
          .map(h => parseSetCookie(h, 'www.mca.gov.in'))
          .filter((c): c is Partial<StoredCookie> => c !== null);
        if (parsed.length > 0) mergeAndSaveCookies(parsed);
      }

      const sc = res.statusCode ?? 0;
      // 200 or 304 = session alive. 302 to login page = expired.
      if (sc === 200 || sc === 304 || sc === 201) {
        resolve({ ok: true, statusCode: sc, reason: 'session alive' });
      } else if (sc === 302 || sc === 301) {
        const loc = String(res.headers['location'] ?? '');
        const expired = loc.includes('login') || loc.includes('Login');
        resolve({
          ok: !expired,
          statusCode: sc,
          reason: expired ? `redirected to login — session expired (${loc})` : `redirect to ${loc}`,
        });
      } else if (sc === 403 || sc === 401) {
        // MCA Akamai CDN sometimes 403s raw HTTPS requests even with valid session.
        // Treat as "session probably alive but CDN blocked the probe" — don't alarm.
        resolve({ ok: true, statusCode: sc, reason: 'CDN returned 403 — treating as session alive (Akamai blocks direct probes)' });
      } else {
        resolve({ ok: false, statusCode: sc, reason: `unexpected status ${sc}` });
      }
    });

    req.on('error', (e: Error) => {
      resolve({ ok: false, reason: `network error: ${e.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'request timed out' });
    });

    req.end();
  });
}

let _timer: NodeJS.Timeout | null = null;
let _consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_WARN = 2;

async function _beat(): Promise<void> {
  const result = await pingMca();
  if (result.ok) {
    _consecutiveFailures = 0;
    log(`ping ok (${result.statusCode}) — ${result.reason}`);
  } else {
    _consecutiveFailures++;
    const prefix = _consecutiveFailures >= MAX_FAILURES_BEFORE_WARN ? '⚠️  ' : '';
    log(`${prefix}ping failed (${result.statusCode ?? 'no status'}) — ${result.reason} [failures: ${_consecutiveFailures}]`);
    if (_consecutiveFailures >= MAX_FAILURES_BEFORE_WARN) {
      process.stderr.write(
        `[heartbeat] ⚠️  MCA session appears expired after ${_consecutiveFailures} failed pings — run: npm run login\n`,
      );
    }
  }
}

/** Start the background heartbeat. Safe to call multiple times (idempotent). */
export function startHeartbeat(): void {
  if (_timer) return; // already running
  log(`started — will ping MCA every ${PING_INTERVAL_MS / 60_000} min to keep session alive`);

  // Ping immediately on start so we know session state right away
  void _beat();

  _timer = setInterval(() => { void _beat(); }, PING_INTERVAL_MS);
  // Don't block process exit
  if (_timer.unref) _timer.unref();
}

/** Stop the heartbeat. Called on graceful shutdown. */
export function stopHeartbeat(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    log('stopped');
  }
}
