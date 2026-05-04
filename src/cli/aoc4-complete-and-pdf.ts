/**
 * Drive a full AOC-4 filing through panel-1 hybrid save + panels 2-6 force save, then
 * navigate the same browser to the resume URL, find the Preview/Download PDF button,
 * click it, and capture the PDF.
 *
 * The user's empirical finding (2026-05-02): PDF is only available when the form is
 * fully filled. Our worker now fills all panels but leaves the browser on the form-load
 * page. To verify PDF actually unlocks, we need to navigate to the draft AS RESUMED and
 * look for the PDF action.
 *
 * Flow:
 *   1. Spawn the worker (HTTP /start-aoc4) — creates draft, fills panels 2-6
 *   2. Wait for phase=DRAFT_CREATED with all 6 panels saved
 *   3. Get the resumeUrl from the job state
 *   4. Open the resume URL in a Playwright browser (same auth context)
 *   5. Walk the form's UI for any Preview / Download / View PDF action
 *   6. Click + capture network for application/pdf responses
 *   7. Save PDF to disk if found
 *
 * Usage: npm run aoc4:complete-and-pdf [CIN]
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { teardown } from '../browser.js';
import { waitForBridge } from '../aoc4/bridge.js';
import { setPhase, type Aoc4Job, createJob } from '../server/jobs.js';
import { runAoc4Job } from '../server/aoc4-worker.js';

const ARTIFACT_DIR = `./.artifacts/runs/complete-and-pdf-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const cin = process.argv[2] ?? 'U69100KA2023PTC177694';
  const today = new Date();
  const fyEnd = new Date(today.getFullYear(), 2, 31);
  if (today < fyEnd) fyEnd.setFullYear(fyEnd.getFullYear() - 1);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const fyStart = iso(new Date(fyEnd.getFullYear() - 1, 3, 1));

  const jobId = `pdf-test-${Date.now()}`;
  const job: Aoc4Job = createJob(jobId, {
    cin,
    financialYearFrom: fyStart,
    financialYearTo: iso(fyEnd),
    boardMeetingFsApprovalDate: '2025-09-15',
    boardMeetingReportDate: '2025-09-15',
    auditorSigningDate: '2025-09-15',
    agmDate: '2025-09-30',
    agmDueDate: '2025-09-30',
    numberOfMembers: 5,
    directors: [
      { din: '11142612', designation: 'Director' },
      { din: '11142613', designation: 'Director' },
    ],
    fsSignerDirectorIndex: 0,
  });

  process.stderr.write('[complete-and-pdf] step 1: running full filing flow (hybrid save + panels 2-6 force save)\n');
  try {
    await runAoc4Job(job, { artifactDir: ARTIFACT_DIR });
  } catch (e) {
    process.stderr.write(`[complete-and-pdf] worker threw: ${(e as Error).message}\n`);
  }
  process.stderr.write(`[complete-and-pdf] worker phase=${job.phase} srId=${job.srId} ref=${job.referenceNumber}\n`);

  if (!job.resumeUrl) {
    process.stderr.write('[complete-and-pdf] no resumeUrl produced — abort\n');
    if (job._browser) try { await teardown(job._browser); } catch { /* */ }
    return;
  }

  // Worker leaves browser warm. Reuse it for navigation.
  const page = job._page;
  const browser = job._browser;
  if (!page || !browser) {
    process.stderr.write('[complete-and-pdf] worker browser handle missing — abort\n');
    return;
  }

  // Capture every PDF response from this point on
  const pdfsCaptured: Array<{ url: string; bytes: number; path: string; method: string }> = [];
  page.on('response', async (resp) => {
    const ct = resp.headers()['content-type'] ?? '';
    if (!ct.includes('pdf')) return;
    try {
      const body = await resp.body();
      if (body.length < 1000) return;
      const fname = path.join(ARTIFACT_DIR, `pdf-${Date.now()}.pdf`);
      fs.writeFileSync(fname, body);
      pdfsCaptured.push({ url: resp.url(), bytes: body.length, path: fname, method: resp.request().method() });
      process.stderr.write(`\n  📄 PDF CAPTURED (${body.length} bytes): ${resp.url()}\n  → ${fname}\n\n`);
    } catch { /* */ }
  });

  process.stderr.write(`[complete-and-pdf] step 2: navigating to resume URL\n  ${job.resumeUrl}\n`);
  try {
    await page.goto(job.resumeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    await page.waitForTimeout(8_000); // let conditional fields settle after draft load
  } catch (e) {
    process.stderr.write(`[complete-and-pdf] resume URL load error: ${(e as Error).message}\n`);
  }

  // Step 3: capture form state — look for Preview / PDF / Submit buttons
  const formState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText ?? '').trim().slice(0, 60),
        id: el.id ?? '',
        ariaLabel: el.getAttribute('aria-label') ?? '',
        href: (el as HTMLAnchorElement).href || undefined,
        disabled: (el as HTMLButtonElement).disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      }))
      .filter((b) => b.text || b.ariaLabel);

    const pdfRelated = buttons.filter((b) =>
      /pdf|preview|view\s*form|download|generate|render|attach|submit\s*to\s*mca/i.test(b.text + ' ' + b.ariaLabel),
    );
    const errors: Array<{ msg: string; widget?: string }> = [];
    document.querySelectorAll('[class*="error"], [class*="invalid"]').forEach((el) => {
      const e = el as HTMLElement;
      if (e.offsetParent === null || e.children.length > 1) return;
      const text = (e.innerText ?? '').trim();
      if (!text || text.length > 200) return;
      const parent = e.closest('[id*="guideContainer"]');
      const pid = parent?.id ?? '';
      errors.push({ msg: text.slice(0, 120), widget: pid.slice(-80) });
    });
    return {
      url: location.href,
      title: document.title,
      pdfRelatedButtons: pdfRelated.slice(0, 30),
      errorCount: errors.length,
      errors: errors.slice(0, 30),
      bodyPreview: document.body.innerText.slice(0, 800),
    };
  });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'resumed-form-state.json'), JSON.stringify(formState, null, 2));
  process.stderr.write(`[complete-and-pdf] step 3: form state — pdfButtons=${formState.pdfRelatedButtons.length}, validationErrors=${formState.errorCount}\n`);
  if (formState.pdfRelatedButtons.length > 0) {
    process.stderr.write('[complete-and-pdf] PDF-related buttons found:\n');
    for (const b of formState.pdfRelatedButtons) {
      process.stderr.write(`    "${b.text}" (id=${b.id.slice(-60)}, disabled=${b.disabled})\n`);
    }
  }
  if (formState.errorCount > 0) {
    process.stderr.write(`[complete-and-pdf] ${formState.errorCount} validation errors (sample 5):\n`);
    for (const e of formState.errors.slice(0, 5)) {
      process.stderr.write(`    "${e.msg}" widget=${e.widget}\n`);
    }
  }

  // Step 4: click any Preview/PDF/Generate button
  const target = formState.pdfRelatedButtons.find((b) => !b.disabled && /pdf|preview|view\s*form|download|generate/i.test(b.text + ' ' + b.ariaLabel));
  if (target) {
    process.stderr.write(`[complete-and-pdf] step 4: clicking "${target.text}"\n`);
    await page.evaluate((t: { id: string; text: string }) => {
      const el = t.id ? document.getElementById(t.id) : null;
      if (el && el.offsetParent !== null) (el as HTMLElement).click();
      else {
        // Fallback: find by text
        const all = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
        const f = all.find((e) => (e.innerText ?? '').trim().slice(0, 60) === t.text && e.offsetParent !== null);
        if (f) f.click();
      }
    }, target);
    await page.waitForTimeout(15_000);
  } else {
    process.stderr.write('[complete-and-pdf] no clickable PDF button — form may need more completion\n');
  }

  // Step 5: report
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'pdf-captured.json'), JSON.stringify(pdfsCaptured, null, 2));
  if (pdfsCaptured.length > 0) {
    process.stderr.write(`\n✅ DONE — ${pdfsCaptured.length} PDF(s) captured. Artifacts: ${ARTIFACT_DIR}\n`);
    setPhase(jobId, 'PDF_DOWNLOADED');
  } else {
    process.stderr.write(`\n❌ NO PDF — see ${ARTIFACT_DIR}/resumed-form-state.json for what's blocking\n`);
  }

  await teardown(browser);
})();
