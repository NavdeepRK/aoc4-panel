/**
 * Public company-info lookup that wraps MCA's `inc12-withoutassociation` endpoint.
 *
 * Why this exists:
 * - The /bin/commongetapi endpoint returns the full 61-field company profile (PAN,
 *   addresses, capital, status flags, NIC codes, directors count, ROC, etc.) for any CIN.
 * - It's a "without association" call — works even when the logged-in user has no
 *   relationship to the company. Confirmed live on 2026-05-01 (returned data with
 *   `loggedInUserDetailsBasic` reporting "No Active Session").
 * - But the request requires `window.encrypt()` (AES key from `clientlibs-encrptdecrypt.min.js`)
 *   AND a CSRF token from the form's `#csrfToken` hidden input. Both are only available
 *   inside a live AEM form page — not reproducible from raw Node.
 *
 * Implementation: a lazy-singleton Playwright browser that loads the AOC-4 form once,
 * keeps it warm, and answers requests by running fetch() inside the page context.
 *
 * Concurrency: a serializing queue (mutex) so we never have two `page.evaluate` calls
 * stepping on each other. For higher throughput, replace with a pool of pages.
 *
 * Idle eviction: the browser closes after `IDLE_TIMEOUT_MS` of no requests, so we don't
 * keep a Chromium process alive forever. Next call relaunches lazily.
 */

import * as fs from 'node:fs';
import type { Browser, Page } from 'playwright';
import { launch } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';

const IDLE_TIMEOUT_MS = 5 * 60_000;        // close browser after 5 min idle
const REQUEST_TIMEOUT_MS = 20_000;          // single MCA request budget
const STORAGE_STATE_PATH = './storage-state.json';

type LookupSession = { browser: Browser; page: Page; idleTimer?: NodeJS.Timeout };
let session: LookupSession | null = null;
let initPromise: Promise<LookupSession> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function ensureSession(): Promise<LookupSession> {
  if (session) {
    resetIdleTimer();
    return session;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      // The MCA portal redirects unauthenticated direct-URL access to /home or /login.
      // The `inc12-withoutassociation` API itself is permissive but the AEM form load
      // is gated. Without storage-state, the form won't load and `window.encrypt` won't be
      // initialized.
      throw new Error('storage-state.json missing — run `npm run login` first');
    }
    const { browser, page } = await launch();
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    await page.waitForFunction(
      () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function'
        && !!document.querySelector('#csrfToken'),
      { timeout: 30_000 },
    );
    process.stderr.write('[company-lookup] session warm — AOC-4 form loaded, encrypt() ready\n');
    const s: LookupSession = { browser, page };
    session = s;
    resetIdleTimer();
    return s;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function resetIdleTimer(): void {
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => void disposeSession(), IDLE_TIMEOUT_MS);
}

async function disposeSession(): Promise<void> {
  const s = session;
  session = null;
  if (!s) return;
  process.stderr.write('[company-lookup] idle — closing browser\n');
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try { await s.browser.close(); } catch { /* already gone */ }
}

/** Serialize per-page calls so no two `page.evaluate` calls overlap. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  // Allow the queue to advance even if `fn` rejects — but don't let rejections propagate
  // and break future calls.
  queue = next.catch(() => {});
  return next;
}

export interface CompanyInfo {
  CIN: string;
  company: string;
  companyStatus: string;
  classOfCompany: string;
  smallCompanyFlag: 'Y' | 'N' | string;
  shareCapitalFlag: 'Y' | 'N' | string;
  dateOfIncorporation: string;
  authorisedcapital: number;
  /** sic — server returns "paidupCaptail" not "paidUpCapital" */
  paidupCaptail: number;
  PAN: string;
  emailAddress: string;
  numberOfDirectors: number;
  numberOfMembers: number | null;
  ROCName: string;
  ROCCode: string;
  inc20AFlag: 'Y' | 'N' | null;
  inc24Flag: 'C' | 'P' | string | null;
  companiesINC22Flag: 'Y' | 'N' | null;
  managementDisputeFlag: 'Y' | 'N' | null;
  vanishFlag: 'Y' | 'N' | null;
  whetherListedOrNot: 'Y' | 'N' | null;
  NICCode1: number;
  NICCode1Desc: string;
  listed: 'Y' | 'N';
  agmDate: string | null;
  /** Allow forward-compat extras */
  [key: string]: unknown;
}

export interface FetchCompanyInfoResult {
  ok: boolean;
  cin: string;
  /** Only populated when ok=true. */
  company?: CompanyInfo;
  /** When ok=false, what went wrong. */
  error?: string;
}

const CIN_REGEX = /^[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;

export async function fetchCompanyInfoByCin(rawCin: string): Promise<FetchCompanyInfoResult> {
  const cin = String(rawCin || '').toUpperCase().trim();
  if (!CIN_REGEX.test(cin)) {
    return { ok: false, cin, error: 'invalid CIN format' };
  }

  return serialize(async () => {
    const s = await ensureSession();
    const result = await s.page.evaluate(async ({ cin: c, timeoutMs }) => {
      const winT = window as unknown as { encrypt?: (s: string) => string };
      if (typeof winT.encrypt !== 'function') return { ok: false as const, error: 'encrypt() not available' };
      const csrfTokenEl = document.querySelector('#csrfToken') as HTMLInputElement | null;
      const csrfToken = csrfTokenEl?.value;
      if (!csrfToken) return { ok: false as const, error: 'CSRF token not found' };

      const form = new FormData();
      form.append('data', winT.encrypt(JSON.stringify({ CIN: c })));
      form.append('endpointID', 'inc12-withoutassociation');
      form.append('csrfToken', winT.encrypt(csrfToken));
      form.append('csrfDecode', 'false');

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch('/bin/commongetapi', { method: 'POST', credentials: 'include', body: form, signal: ctrl.signal });
        if (!r.ok) return { ok: false as const, error: `HTTP ${r.status}` };
        const text = await r.text();
        let outer: { resCode?: number; resStr?: string };
        try { outer = JSON.parse(text); } catch (e) { return { ok: false as const, error: 'outer parse: ' + (e as Error).message }; }
        if (outer.resCode !== 200) return { ok: false as const, error: `resCode=${outer.resCode}` };
        if (typeof outer.resStr !== 'string') return { ok: false as const, error: 'resStr missing' };
        let inner: { error?: string; data?: Array<{ companyInfo?: unknown }> };
        try { inner = JSON.parse(outer.resStr); } catch (e) { return { ok: false as const, error: 'inner parse: ' + (e as Error).message }; }
        const ci = inner.data?.[0]?.companyInfo;
        if (!ci) return { ok: false as const, error: inner.error || 'no companyInfo in response' };
        return { ok: true as const, company: ci };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      } finally {
        clearTimeout(t);
      }
    }, { cin, timeoutMs: REQUEST_TIMEOUT_MS });

    if (!result.ok) return { ok: false, cin, error: result.error };
    return { ok: true, cin, company: result.company as CompanyInfo };
  });
}

/** Convenience wrapper for the most common consumer query. */
export async function fetchPanByCin(cin: string): Promise<{ ok: boolean; cin: string; pan?: string; companyName?: string; error?: string }> {
  const r = await fetchCompanyInfoByCin(cin);
  if (!r.ok) return { ok: false, cin: r.cin, error: r.error };
  return { ok: true, cin: r.cin, pan: r.company?.PAN, companyName: r.company?.company };
}
