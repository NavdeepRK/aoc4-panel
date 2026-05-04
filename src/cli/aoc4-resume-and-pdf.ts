/**
 * Open an existing draft via its resumeUrl, find any PDF / Preview / Submit action,
 * click it, and capture the PDF response.
 *
 * Usage:
 *   npm run aoc4:resume-and-pdf -- '<resumeUrl>'
 *
 * Useful when you already have a successful draft (from a prior /start-aoc4 run) and
 * just want to verify whether PDF download works given that draft's state.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { waitForBridge } from '../aoc4/bridge.js';

const ARTIFACT_DIR = `./.artifacts/runs/resume-and-pdf-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

(async (): Promise<void> => {
  const resumeUrl = process.argv[2];
  if (!resumeUrl) {
    console.error('Usage: npm run aoc4:resume-and-pdf -- "<resumeUrl>"');
    process.exit(2);
  }
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const { browser, page } = await launch();

  // Capture every PDF response
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

  await page.addInitScript('window.__name = function(f){ return f; };');

  try {
    process.stderr.write(`[resume] navigating to resume URL\n`);
    await page.goto(resumeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try { await waitForBridge(page, 30_000); } catch { /* may not be a guideForm page */ }
    await page.waitForTimeout(15_000);  // let conditional fields and any async populate

    // Capture full state — what buttons exist, what errors are visible
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
        /pdf|preview|view\s*form|download|generate|render|attach|submit/i.test(b.text + ' ' + b.ariaLabel),
      );
      // ALSO grab navigation controls: Next, Save, Continue
      const navButtons = buttons.filter((b) =>
        /^(next|save|continue|previous|prev|submit)$/i.test((b.text || b.ariaLabel).trim()),
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
        allButtonsCount: buttons.length,
        allButtons: buttons,
        pdfRelatedButtons: pdfRelated.slice(0, 30),
        navButtons,
        errorCount: errors.length,
        errors: errors.slice(0, 30),
        bodyPreview: document.body.innerText.slice(0, 1000),
      };
    });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'form-state.json'), JSON.stringify(formState, null, 2));

    // Take a screenshot for visual inspection
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'form-screenshot.png'), fullPage: true });
    process.stderr.write(`[resume] screenshot saved → ${path.join(ARTIFACT_DIR, 'form-screenshot.png')}\n`);

    // Walk the form's bound data — what fields are populated?
    const fieldDump = await page.evaluate(() => {
      type GBExt = { resolveNode?: (s: string) => unknown; getDataXML?: (cb: { success: (r: unknown) => void; error: (e: unknown) => void }) => void };
      const gb = (window as unknown as { guideBridge?: GBExt }).guideBridge;
      if (!gb?.getDataXML) return { ok: false, error: 'guideBridge.getDataXML not available' };
      return new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>((resolve) => {
        gb.getDataXML!({
          success: (r) => {
            const xml = typeof r === 'string' ? r : (r as { data?: string }).data ?? '';
            try {
              const parsed = JSON.parse(xml) as { afData?: { afBoundData?: { data?: { requestBody?: { formData?: Record<string, unknown> } } } } };
              const fd = parsed?.afData?.afBoundData?.data?.requestBody?.formData ?? {};
              // Only keep populated keys
              const populated: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(fd)) {
                if (v !== null && v !== '' && typeof v !== 'object') populated[k] = String(v).slice(0, 100);
                else if (Array.isArray(v) && v.length > 0 && (v as unknown[]).some((x) => x && typeof x === 'object' && Object.keys(x as object).length > 0)) {
                  populated[k] = `[array, ${v.length} items, ${(v as unknown[]).filter((x) => x && Object.keys(x as object).length > 0).length} non-empty]`;
                }
              }
              resolve({ ok: true, data: populated });
            } catch (e) { resolve({ ok: false, error: 'parse: ' + (e as Error).message }); }
          },
          error: (e) => resolve({ ok: false, error: 'getDataXML error: ' + JSON.stringify(e) }),
        });
      });
    });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'field-dump.json'), JSON.stringify(fieldDump, null, 2));
    if (fieldDump.ok && fieldDump.data) {
      const keys = Object.keys(fieldDump.data);
      process.stderr.write(`[resume] form has ${keys.length} populated fields. Sample:\n`);
      for (const k of keys.slice(0, 15)) {
        process.stderr.write(`    ${k} = ${String((fieldDump.data as Record<string, unknown>)[k]).slice(0, 80)}\n`);
      }
    }

    process.stderr.write(`[resume] url=${formState.url}\n`);
    process.stderr.write(`[resume] title=${formState.title}\n`);
    process.stderr.write(`[resume] buttons=${formState.allButtonsCount} pdfRelated=${formState.pdfRelatedButtons.length} errors=${formState.errorCount}\n`);

    if (formState.pdfRelatedButtons.length > 0) {
      process.stderr.write('[resume] PDF-related buttons:\n');
      for (const b of formState.pdfRelatedButtons) {
        process.stderr.write(`    "${b.text}" id=${b.id.slice(-60)} disabled=${b.disabled}\n`);
      }
    } else {
      process.stderr.write('[resume] no PDF-related buttons found — form may need more completion\n');
    }
    if (formState.errorCount > 0) {
      process.stderr.write(`[resume] ${formState.errorCount} validation errors visible (sample):\n`);
      for (const e of formState.errors.slice(0, 10)) {
        process.stderr.write(`    ${e.msg}\n`);
      }
    }

    // Try clicking the first non-disabled PDF/Preview/Generate button
    const target = formState.pdfRelatedButtons.find((b) => !b.disabled && /pdf|preview|view\s*form|download|generate/i.test(b.text + ' ' + b.ariaLabel));
    if (target) {
      process.stderr.write(`[resume] clicking "${target.text}"\n`);
      await page.evaluate((t: { id: string; text: string }) => {
        const el = t.id ? document.getElementById(t.id) : null;
        if (el && el.offsetParent !== null) (el as HTMLElement).click();
        else {
          const all = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
          const f = all.find((e) => (e.innerText ?? '').trim().slice(0, 60) === t.text && e.offsetParent !== null);
          if (f) f.click();
        }
      }, target);
      await page.waitForTimeout(20_000);  // let PDF render + download
    }

    // Final report
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'pdf-captured.json'), JSON.stringify(pdfsCaptured, null, 2));
    if (pdfsCaptured.length > 0) {
      process.stderr.write(`\n✅ ${pdfsCaptured.length} PDF(s) captured. Artifacts: ${ARTIFACT_DIR}\n`);
    } else {
      process.stderr.write(`\n❌ No PDF captured. See ${ARTIFACT_DIR}/form-state.json\n`);
    }

    // Wait 60s before closing — gives user a chance to inspect the visible browser
    process.stderr.write('[resume] keeping browser open 60s for manual inspection...\n');
    await page.waitForTimeout(60_000);
  } catch (e) {
    process.stderr.write(`[resume] ERROR: ${(e as Error).message}\n${(e as Error).stack}\n`);
  } finally {
    await teardown(browser);
  }
})();
