/**
 * HTTP API for the MCA filing service.
 *
 * Mirrors the contract used by the existing INC-20A microservice
 * (see customer-portal-backend-1/controllers/compliance/complianceController.js
 * → startInc20aAutomation, which POSTs to ${INC20A_BASE_URL}/start-inc20a).
 *
 * Endpoints:
 *   POST /health                   liveness check
 *   POST /start-aoc4               kicks off a job; returns { job_id, srId? } once panel1 saves
 *   GET  /jobs/:jobId/status       returns current phase + per-panel results
 *   GET  /jobs/:jobId/pdf          downloads the draft PDF (after DRAFT_CREATED)
 *   POST /jobs/:jobId/upload-signed  accepts the signed PDF, uploads to MCA, transitions to FILED
 *
 * Auth posture:
 *   The service trusts requests from the local network (Customer Portal backend) and
 *   uses MCA's session cookies in `storage-state.json` for actual MCA calls.
 *   For production deployment, add a shared bearer token between the two services.
 */

import 'dotenv/config';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createJob, getJob, publicView, setPhase, listJobs, hydrateJobsFromDisk, type Aoc4FormPayload } from './jobs.js';
import { runAoc4Job, uploadSignedPdfAndSubmit, downloadDraftPdfViaTab } from './aoc4-worker.js';
import { fetchCompanyInfoByCin, fetchPanByCin } from './company-lookup.js';
import { startHeartbeat, stopHeartbeat, pingMca } from './session-heartbeat.js';

const PORT = Number(process.env.MCA_FILING_PORT ?? 8090);
const ARTIFACT_ROOT = process.env.MCA_FILING_ARTIFACT_DIR ?? './.artifacts/runs';
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 5);

/**
 * Concurrency-limited job queue.
 *
 * Each entry in `pending` is { jobId, runner } — a function that returns a Promise.
 * We track `activeCount`; when it dips below MAX_CONCURRENT_JOBS we drain one
 * pending entry. The runner itself decrements activeCount when it finishes.
 */
const _queue: Array<{ jobId: string; runner: () => Promise<void> }> = [];
let _activeCount = 0;

function _drainQueue(): void {
  while (_activeCount < MAX_CONCURRENT_JOBS && _queue.length > 0) {
    const entry = _queue.shift()!;
    _activeCount++;
    process.stdout.write(`[queue] starting ${entry.jobId} (active=${_activeCount}, pending=${_queue.length})\n`);
    void entry.runner()
      .catch(() => { /* errors handled by the runner itself */ })
      .finally(() => {
        _activeCount--;
        process.stdout.write(`[queue] finished ${entry.jobId} (active=${_activeCount}, pending=${_queue.length})\n`);
        _drainQueue();
      });
  }
}

function enqueueJob(jobId: string, runner: () => Promise<void>): void {
  _queue.push({ jobId, runner });
  // Reflect queued state in the job phase if the slot isn't immediately available
  if (_activeCount >= MAX_CONCURRENT_JOBS) {
    try { setPhase(jobId, 'QUEUED'); } catch { /* */ }
  }
  _drainQueue();
}

export function queueStats(): { active: number; pending: number; max: number } {
  return { active: _activeCount, pending: _queue.length, max: MAX_CONCURRENT_JOBS };
}

function nowIso(): string {
  return new Date().toISOString();
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({} as T);
        resolve(JSON.parse(text) as T);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function readBinary(req: http.IncomingMessage): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function validatePayload(p: Partial<Aoc4FormPayload>): string | null {
  if (!p.cin || typeof p.cin !== 'string') return 'cin is required';
  if (!/^[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(p.cin)) return `cin "${p.cin}" is not a valid CIN format`;
  if (!p.financialYearFrom || !p.financialYearTo) return 'financialYearFrom and financialYearTo are required (yyyy-MM-dd)';
  if (!p.boardMeetingFsApprovalDate || !p.boardMeetingReportDate) return 'board meeting dates required';
  if (!p.auditorSigningDate) return 'auditorSigningDate required';
  if (!p.agmDate || !p.agmDueDate) return 'agmDate + agmDueDate required';
  if (typeof p.numberOfMembers !== 'number') return 'numberOfMembers must be a number';
  if (!Array.isArray(p.directors) || p.directors.length === 0) return 'directors[] required (at least one)';
  for (const d of p.directors) {
    if (!d.din || !/^\d{8}$/.test(d.din)) return `director DIN "${d.din}" is not 8 digits`;
    if (!d.designation) return `director ${d.din} missing designation`;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // CORS — allow the Customer Portal backend to call us from a different origin
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (pathname === '/health' && method === 'GET') {
      return send(res, 200, { ok: true, service: 'mca-filing-service', time: nowIso() });
    }

    // ── /admin — minimal ops dashboard (HTML + JSON) ──────────────────────────
    // Basic auth via ADMIN_TOKEN env var. If unset, dashboard is wide-open (dev only).
    if (pathname === '/admin' && method === 'GET') {
      const token = process.env.ADMIN_TOKEN;
      const provided = url.searchParams.get('token');
      if (token && provided !== token) {
        return send(res, 401, { error: 'admin token required: ?token=<value>' });
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(_ADMIN_HTML);
      return;
    }
    if (pathname === '/admin/api/jobs' && method === 'GET') {
      const token = process.env.ADMIN_TOKEN;
      const provided = url.searchParams.get('token') ?? (req.headers['authorization'] ?? '').replace(/^Bearer\s+/, '');
      if (token && provided !== token) return send(res, 401, { error: 'unauthorized' });

      const all = listJobs().map(publicView);
      const q = queueStats();
      const now = Date.now();
      const phaseCounts: Record<string, number> = {};
      let activeCount = 0;
      for (const j of all) {
        phaseCounts[j.phase] = (phaseCounts[j.phase] ?? 0) + 1;
        if (now - j.lastEventAt < 30 * 60 * 1000 && !/FILED|FAILED|INVALID/.test(j.phase)) activeCount++;
      }
      // Sort most-recent first
      all.sort((a, b) => b.createdAt - a.createdAt);
      const totals = {
        total: all.length,
        active: activeCount,
        today: all.filter(j => now - j.createdAt < 24 * 60 * 60 * 1000).length,
        succeeded: phaseCounts['FILED'] ?? 0,
        draftsCreated: (phaseCounts['DRAFT_CREATED'] ?? 0) + (phaseCounts['PDF_DOWNLOADED'] ?? 0),
        failed: (phaseCounts['FAILED'] ?? 0) + (phaseCounts['INVALID_CREDS'] ?? 0) + (phaseCounts['INVALID_OTP'] ?? 0),
        awaitingLogin: phaseCounts['LOGIN_NEEDED'] ?? 0,
        awaitingOtp:   phaseCounts['OTP_PENDING'] ?? 0,
      };
      return send(res, 200, { totals, phaseCounts, queue: q, jobs: all.slice(0, 100) });
    }

    // GET /check-session — verifies MCA login by making a real HTTP request with stored cookies.
    // Does NOT launch a browser. Uses Node's built-in https to hit an MCA endpoint that returns
    // 200 only for authenticated users (redirects to login page for anonymous requests).
    if (pathname === '/check-session' && method === 'GET') {
      const ssPath = './storage-state.json';
      if (!fs.existsSync(ssPath)) {
        return send(res, 200, { loggedIn: false, reason: 'storage-state.json not found — run: npm run login' });
      }

      let ss: { cookies?: Array<{ name: string; value: string; expires: number; domain: string; path: string }> };
      try {
        ss = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
      } catch (e) {
        return send(res, 200, { loggedIn: false, reason: `storage-state.json parse error: ${(e as Error).message}` });
      }

      const now = Date.now() / 1000;
      const mcaCookies = (ss.cookies ?? []).filter(c => c.domain?.includes('mca.gov.in'));
      if (mcaCookies.length === 0) {
        return send(res, 200, { loggedIn: false, reason: 'no MCA cookies in storage-state.json — run: npm run login' });
      }

      // Build cookie header string from stored cookies (skip expired ones)
      const cookieHeader = mcaCookies
        .filter(c => c.expires === -1 || c.expires > now)
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      if (!cookieHeader) {
        return send(res, 200, { loggedIn: false, reason: 'all MCA cookies expired — run: npm run login' });
      }

      // MCA's CDN (Akamai) returns 403 for raw HTTP requests to most endpoints — even
      // valid sessions get 403 because the CDN requires browser-like navigation context.
      // The reliable check is: do the session-specific auth cookies exist AND are they
      // not expired? After npm run login, MCA sets sessionID + session-token-md5 with a
      // ~4-hour TTL. If those exist and have > 5 minutes left, the session is valid.
      const AUTH_COOKIE_NAMES = ['sessionID', 'session-token-md5'];
      const authCookies = mcaCookies.filter(c => AUTH_COOKIE_NAMES.includes(c.name));
      const validAuth = authCookies.filter(c => c.expires === -1 || c.expires > now + 300); // 5-min buffer
      const expiredAuth = authCookies.filter(c => c.expires > 0 && c.expires <= now + 300);

      const loggedIn = validAuth.length >= 2; // both auth cookies must be present + valid
      const secondsLeft = validAuth.length > 0
        ? Math.min(...validAuth.filter(c => c.expires > 0).map(c => c.expires - now))
        : 0;
      const minutesLeft = Math.floor(secondsLeft / 60);

      return send(res, 200, {
        loggedIn,
        reason: loggedIn
          ? `session valid — auth cookies expire in ~${minutesLeft} min (run: npm run login to refresh before they expire)`
          : expiredAuth.length > 0
            ? 'MCA session expired — run: npm run login to refresh'
            : 'MCA auth cookies not found — run: npm run login first',
        cookieCount: mcaCookies.length,
        authCookiesFound: authCookies.length,
        validAuthCookies: validAuth.length,
        expiresInMinutes: minutesLeft > 0 ? minutesLeft : null,
        note: 'checked sessionID + session-token-md5 cookie expiry (MCA CDN blocks raw HTTP probes)',
      });
    }

    // GET /ping-session — fire a single manual heartbeat ping and return the result
    if (pathname === '/ping-session' && method === 'GET') {
      const result = await pingMca();
      return send(res, 200, { ...result, time: nowIso() });
    }

    // --- Public company-info lookup -------------------------------------------------
    // GET /company-info?cin=...  — returns full 61-field public profile
    // GET /company/:cin/pan      — returns just { pan, companyName } for the lightweight case
    if (pathname === '/company-info' && method === 'GET') {
      const cin = url.searchParams.get('cin');
      if (!cin) return send(res, 400, { error: 'missing ?cin' });
      const r = await fetchCompanyInfoByCin(cin);
      if (!r.ok) return send(res, r.error?.includes('invalid CIN') ? 400 : 502, { error: r.error, cin: r.cin });
      return send(res, 200, { cin: r.cin, company: r.company });
    }
    let cinMatch = pathname.match(/^\/company\/([^/]+)\/pan$/);
    if (cinMatch && method === 'GET') {
      const r = await fetchPanByCin(cinMatch[1]);
      if (!r.ok) return send(res, r.error?.includes('invalid CIN') ? 400 : 502, { error: r.error, cin: r.cin });
      return send(res, 200, { cin: r.cin, pan: r.pan, companyName: r.companyName });
    }

    if (pathname === '/start-aoc4' && method === 'POST') {
      const rawPayload = await readJson<Aoc4FormPayload & { _perJobLogin?: boolean; _spocEmail?: string }>(req);
      // Per-job-login mode: the SPOC will POST their own MCA creds + OTP. Skip the
      // shared-session pre-flight check entirely.
      const perJobLogin = rawPayload._perJobLogin === true;

      if (!perJobLogin) {
        // ── Legacy shared-session pre-flight ──────────────────────────────────
        const ssPath = './storage-state.json';
        if (!fs.existsSync(ssPath)) {
          return send(res, 401, { error: 'MCA session not found. Run `npm run login` first, then retry.' });
        }
        try {
          const ss = JSON.parse(fs.readFileSync(ssPath, 'utf8')) as {
            cookies?: Array<{ name: string; value: string; expires: number; domain: string }>;
          };
          const now = Date.now() / 1000;
          const mcaCookies = (ss.cookies ?? []).filter(c => c.domain?.includes('mca.gov.in'));
          if (mcaCookies.length === 0) {
            return send(res, 401, { error: 'No MCA cookies found. Run `npm run login` first, then retry.' });
          }
          const authNames = ['sessionID', 'session-token-md5'];
          const validAuthCookies = mcaCookies.filter(c =>
            authNames.includes(c.name) && (c.expires === -1 || c.expires > now + 300),
          );
          if (validAuthCookies.length < 2) {
            return send(res, 401, { error: 'MCA session expired — run `npm run login` to refresh, then retry.' });
          }
        } catch { /* parse error — allow through, worker will surface it */ }
      }

      const { _perJobLogin: _p, _spocEmail: spocEmail, ...payload } = rawPayload;
      const err = validatePayload(payload as Aoc4FormPayload);
      if (err) return send(res, 400, { error: err });

      const jobId = `aoc4-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const job = createJob(jobId, payload as Aoc4FormPayload);
      if (spocEmail) job.spocEmail = spocEmail;
      const artifactDir = path.join(ARTIFACT_ROOT, jobId);
      fs.mkdirSync(artifactDir, { recursive: true });

      process.stdout.write(`[server] job ${jobId} created — CIN ${payload.cin}${perJobLogin ? ' (per-job login)' : ''}\n`);
      enqueueJob(jobId, async () => {
        try {
          await runAoc4Job(job, { artifactDir, usePerJobLogin: perJobLogin });
          process.stdout.write(`[server] job ${jobId} completed — phase: ${job.phase}\n`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[server] job ${jobId} THREW: ${msg}\n`);
          try { setPhase(jobId, 'FAILED', { error: msg }); } catch { /* */ }
        }
      });

      return send(res, 202, { job_id: jobId, phase: job.phase, createdAt: nowIso(), queue: queueStats() });
    }

    // ── Per-job login endpoints (Phase 2 of the per-SPOC login feature) ──────
    let mAuth = pathname.match(/^\/jobs\/([^/]+)\/creds$/);
    if (mAuth && method === 'POST') {
      const job = getJob(mAuth[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (job.phase !== 'LOGIN_NEEDED') {
        return send(res, 409, { error: `job is in phase ${job.phase}, not LOGIN_NEEDED` });
      }
      const body = await readJson<{ userId?: string; password?: string }>(req);
      if (!body?.userId || !body?.password) {
        return send(res, 400, { error: 'body must be { userId, password }' });
      }
      if (!job._signals?.creds) {
        return send(res, 500, { error: 'job has no pending creds signal — internal state mismatch' });
      }
      job._signals.creds.resolve({ userId: body.userId, password: body.password });
      return send(res, 202, { ok: true, phase: job.phase });
    }

    mAuth = pathname.match(/^\/jobs\/([^/]+)\/otp$/);
    if (mAuth && method === 'POST') {
      const job = getJob(mAuth[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (job.phase !== 'OTP_PENDING') {
        return send(res, 409, { error: `job is in phase ${job.phase}, not OTP_PENDING` });
      }
      const body = await readJson<{ otp?: string }>(req);
      if (!body?.otp) return send(res, 400, { error: 'body must be { otp }' });
      if (!job._signals?.otp) {
        return send(res, 500, { error: 'job has no pending otp signal — internal state mismatch' });
      }
      job._signals.otp.resolve({ otp: body.otp });
      return send(res, 202, { ok: true, phase: job.phase });
    }

    let m = pathname.match(/^\/jobs\/([^/]+)\/status$/);
    if (m && method === 'GET') {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      return send(res, 200, publicView(job));
    }

    m = pathname.match(/^\/jobs\/([^/]+)\/pdf$/);
    if (m && method === 'GET') {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (!job.draftPdfPath || !fs.existsSync(job.draftPdfPath)) {
        return send(res, 404, { error: 'PDF not yet available — wait for phase=PDF_DOWNLOADED' });
      }
      const buf = fs.readFileSync(job.draftPdfPath);
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="aoc4-${job.cin}-${job.srId ?? 'draft'}.pdf"`,
        'content-length': String(buf.length),
      });
      res.end(buf);
      return;
    }

    // POST /jobs/:jobId/force-download-pdf
    // Re-attempts the PDF download using a real browser tab (bypasses Akamai CDN 403s).
    // Use this when the automatic download at DRAFT_CREATED time failed.
    m = pathname.match(/^\/jobs\/([^/]+)\/force-download-pdf$/);
    if (m && method === 'POST') {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (!['DRAFT_CREATED', 'PDF_DOWNLOADED', 'AWAITING_SIGNATURE'].includes(job.phase)) {
        return send(res, 400, { error: `cannot download PDF in phase ${job.phase} — job must be DRAFT_CREATED or later` });
      }
      const dir = path.join(ARTIFACT_ROOT, job.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const pdfPath = path.join(dir, 'draft.pdf');
      const result = await downloadDraftPdfViaTab(job, pdfPath);
      if (!result.ok) return send(res, 502, { error: result.error });
      job.draftPdfPath = pdfPath;
      if (job.phase === 'DRAFT_CREATED') setPhase(job.jobId, 'PDF_DOWNLOADED');
      return send(res, 200, { ok: true, bytes: result.bytes, via: result.via, phase: job.phase });
    }

    m = pathname.match(/^\/jobs\/([^/]+)\/upload-signed$/);
    if (m && method === 'POST') {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      const buf = await readBinary(req);
      if (buf.length === 0) return send(res, 400, { error: 'empty body — POST the signed PDF as application/pdf' });

      // Stage the signed PDF on disk for audit
      const dir = path.join(ARTIFACT_ROOT, job.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const signedPath = path.join(dir, 'signed.pdf');
      fs.writeFileSync(signedPath, buf);
      job.signedPdfPath = signedPath;

      // Upload to MCA + trigger formSubmitConfirmation
      const result = await uploadSignedPdfAndSubmit(job, buf);
      if (!result.ok) {
        return send(res, 502, { error: result.error, signedPdfBytes: buf.length, phase: job.phase });
      }
      return send(res, 200, {
        ok: true,
        signedPdfBytes: buf.length,
        phase: result.phase ?? job.phase,
        srn: result.srn ?? null,
        note: result.error ?? 'signed PDF uploaded + submit triggered',
      });
    }

    // Manual submit retry — uses the staged signed.pdf if present
    m = pathname.match(/^\/jobs\/([^/]+)\/submit$/);
    if (m && method === 'POST') {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'job not found' });
      if (!job.signedPdfPath || !fs.existsSync(job.signedPdfPath)) {
        return send(res, 400, { error: 'no signed PDF staged for this job — POST /upload-signed first' });
      }
      const buf = fs.readFileSync(job.signedPdfPath);
      const result = await uploadSignedPdfAndSubmit(job, buf);
      const status = result.ok ? 200 : 502;
      return send(res, status, { ok: result.ok, srn: result.srn ?? null, phase: result.phase ?? job.phase, error: result.error });
    }

    if (pathname === '/jobs' && method === 'GET') {
      return send(res, 200, { jobs: listJobs().map(publicView) });
    }

    return send(res, 404, { error: 'unknown route', pathname, method });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return send(res, 500, { error: msg });
  }
});

server.listen(PORT, () => {
  process.stderr.write(`[mca-filing-service] listening on :${PORT} — artifacts → ${ARTIFACT_ROOT}\n`);
  // Hydrate jobs persisted to disk from prior runs so /jobs/:id/status + /pdf keep working
  // across restarts. Live actions (upload-signed, force-download-pdf) still require a browser
  // and will fail with a clear "service was restarted" error if attempted on a stale job.
  const { hydrated, skipped } = hydrateJobsFromDisk();
  if (hydrated > 0 || skipped > 0) {
    process.stderr.write(`[mca-filing-service] hydrated ${hydrated} job(s) from disk, skipped ${skipped}\n`);
  }
  startHeartbeat();
});

// Graceful shutdown so in-flight Playwright browsers get a chance to close
const shutdown = async (sig: string): Promise<void> => {
  process.stderr.write(`[mca-filing-service] received ${sig}, draining…\n`);
  stopHeartbeat();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * Minimal admin dashboard. Self-contained HTML + vanilla JS that polls
 * /admin/api/jobs every 5s. Renders totals + the recent jobs table.
 */
const _ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mca-filing-service — ops dashboard</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px;background:#0f172a;color:#e2e8f0}
  h1{font-size:18px;margin:0 0 16px;font-weight:600}
  h2{font-size:14px;margin:24px 0 8px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .stat{background:#1e293b;padding:12px 16px;border-radius:8px;border:1px solid #334155}
  .stat-label{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em}
  .stat-value{font-size:22px;font-weight:600;margin-top:4px}
  .stat.warn .stat-value{color:#fbbf24}
  .stat.err .stat-value{color:#f87171}
  .stat.ok .stat-value{color:#34d399}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #334155}
  th{font-weight:500;color:#94a3b8;background:#1e293b;position:sticky;top:0}
  tr:hover{background:#1e293b}
  .phase{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
  .phase-LOGIN_NEEDED,.phase-OTP_PENDING,.phase-QUEUED{background:#fef3c7;color:#92400e}
  .phase-FILLING_PANEL,.phase-SAVING_PANEL,.phase-LOADING_FORM,.phase-PREFILLING,.phase-LOGGING_IN_CREDS,.phase-SUBMITTING_OTP,.phase-AUTHENTICATED{background:#dbeafe;color:#1e40af}
  .phase-DRAFT_CREATED,.phase-PDF_DOWNLOADED,.phase-FILED{background:#d1fae5;color:#065f46}
  .phase-FAILED,.phase-INVALID_CREDS,.phase-INVALID_OTP{background:#fee2e2;color:#991b1b}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
  .muted{color:#64748b}
  .err-text{color:#f87171;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #refreshNote{font-size:11px;color:#64748b;float:right}
</style>
</head>
<body>
<h1>mca-filing-service <span class="muted" style="font-size:12px;font-weight:400">— ops dashboard</span> <span id="refreshNote"></span></h1>
<div class="stats" id="stats"></div>
<h2>Recent jobs (latest 100)</h2>
<div style="max-height:60vh;overflow:auto;background:#1e293b;border-radius:8px;border:1px solid #334155">
  <table id="jobs">
    <thead>
      <tr><th>Created</th><th>Job</th><th>CIN</th><th>SPOC</th><th>MCA User</th><th>Phase</th><th>Panels</th><th>Error</th></tr>
    </thead>
    <tbody></tbody>
  </table>
</div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
async function refresh() {
  try {
    const r = await fetch('/admin/api/jobs' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
    if (!r.ok) { document.getElementById('refreshNote').textContent = 'unauthorized'; return; }
    const d = await r.json();
    const t = d.totals;
    const q = d.queue;
    document.getElementById('stats').innerHTML = [
      ['Active', t.active, ''],
      ['Today', t.today, ''],
      ['Drafts', t.draftsCreated, 'ok'],
      ['Filed', t.succeeded, 'ok'],
      ['Awaiting login', t.awaitingLogin, t.awaitingLogin > 0 ? 'warn' : ''],
      ['Awaiting OTP', t.awaitingOtp, t.awaitingOtp > 0 ? 'warn' : ''],
      ['Failed', t.failed, t.failed > 0 ? 'err' : ''],
      ['Queue', q.active + '/' + q.max + (q.pending ? ' (+' + q.pending + ')' : ''), ''],
    ].map(([l, v, cls]) => '<div class="stat ' + cls + '"><div class="stat-label">' + l + '</div><div class="stat-value">' + v + '</div></div>').join('');
    const tbody = document.querySelector('#jobs tbody');
    tbody.innerHTML = d.jobs.map(j => {
      const created = new Date(j.createdAt).toLocaleString('en-IN', { hour12: false });
      const panels = (j.panelResults || []).map(p => p.ok ? '<span style="color:#34d399">' + p.panel + '</span>' : '<span style="color:#f87171">' + p.panel + '</span>').join(' ');
      return '<tr>' +
        '<td class="mono muted">' + created + '</td>' +
        '<td class="mono">' + j.jobId.slice(-12) + '</td>' +
        '<td class="mono">' + (j.cin || '') + '</td>' +
        '<td>' + (j.spocEmail || '<span class="muted">-</span>') + '</td>' +
        '<td class="mono">' + (j.mcaUserId || '<span class="muted">-</span>') + '</td>' +
        '<td><span class="phase phase-' + j.phase + '">' + j.phase + '</span></td>' +
        '<td>' + panels + '</td>' +
        '<td class="err-text">' + (j.error || '') + '</td>' +
      '</tr>';
    }).join('');
    document.getElementById('refreshNote').textContent = 'updated ' + new Date().toLocaleTimeString('en-IN', { hour12: false });
  } catch (e) {
    document.getElementById('refreshNote').textContent = 'err: ' + e.message;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
