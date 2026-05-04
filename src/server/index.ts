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
import { createJob, getJob, publicView, setPhase, listJobs, type Aoc4FormPayload } from './jobs.js';
import { runAoc4Job, uploadSignedPdfAndSubmit } from './aoc4-worker.js';
import { fetchCompanyInfoByCin, fetchPanByCin } from './company-lookup.js';

const PORT = Number(process.env.MCA_FILING_PORT ?? 8090);
const ARTIFACT_ROOT = process.env.MCA_FILING_ARTIFACT_DIR ?? './.artifacts/runs';

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
      const payload = await readJson<Aoc4FormPayload>(req);
      const err = validatePayload(payload);
      if (err) return send(res, 400, { error: err });

      const jobId = `aoc4-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const job = createJob(jobId, payload);
      const artifactDir = path.join(ARTIFACT_ROOT, jobId);
      fs.mkdirSync(artifactDir, { recursive: true });

      // Kick off the worker. Run in background — return job_id immediately so the caller can poll.
      void runAoc4Job(job, { artifactDir }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[server] job ${jobId} failed: ${msg}\n`);
        try { setPhase(jobId, 'FAILED', { error: msg }); } catch { /* job may already be gone */ }
      });

      return send(res, 202, { job_id: jobId, phase: job.phase, createdAt: nowIso() });
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
});

// Graceful shutdown so in-flight Playwright browsers get a chance to close
const shutdown = async (sig: string): Promise<void> => {
  process.stderr.write(`[mca-filing-service] received ${sig}, draining…\n`);
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
