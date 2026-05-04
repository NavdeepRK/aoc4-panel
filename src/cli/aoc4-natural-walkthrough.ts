/**
 * Natural panel-by-panel walkthrough — open the resume URL, save panel 1 normally,
 * wait for panel 2 to activate, save panel 2, etc. After all 6 panels, look for a
 * Submit / Generate PDF action.
 *
 * Uses the form's NATURAL state transitions instead of force-clicking disabled buttons.
 * Each save click triggers AEM's panel-advance logic; the next panel becomes active and
 * its Save button enables organically.
 *
 * Usage: npm run aoc4:natural-walkthrough -- '<resumeUrl>'
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { waitForBridge } from '../aoc4/bridge.js';

const ARTIFACT_DIR = `./.artifacts/runs/natural-walkthrough-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const PANEL_SAVE_IDS: Record<number, string> = {
  1: 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget',
  2: 'guideContainer-rootPanel-panel-panel-panel2AOC4-panel_copy_1258675259-nextitemnav___widget',
  4: 'guideContainer-rootPanel-panel-panel-panel4AOC4-panel_2074267803_cop_2609391-panel_2092040517-nextitemnav___widget',
  5: 'guideContainer-rootPanel-panel-panel-panel5AOC4-panel_1564862517-nextitemnav___widget',
  6: 'guideContainer-rootPanel-panel-panel-panel6AOC4-panel_685745594_copy-panel-nextitemnav___widget',
};

(async (): Promise<void> => {
  const resumeUrl = process.argv[2];
  if (!resumeUrl) { console.error('Usage: npm run aoc4:natural-walkthrough -- "<resumeUrl>"'); process.exit(2); }
  if (!fs.existsSync('./storage-state.json')) { console.error('Run `npm run login` first.'); process.exit(2); }

  const { browser, page } = await launch();
  const network: Array<{ url: string; method: string; status?: number; ct?: string; bytes?: number }> = [];
  const pdfsCaptured: Array<{ url: string; bytes: number; path: string }> = [];

  page.on('request', (req) => {
    if (/\.(css|png|jpg|jpeg|gif|svg|ico|woff)/.test(req.url())) return;
    network.push({ url: req.url(), method: req.method() });
  });
  page.on('response', async (resp) => {
    let entry: typeof network[0] | undefined;
    for (let i = network.length - 1; i >= 0; i--) {
      if (network[i].url === resp.url() && network[i].status === undefined) { entry = network[i]; break; }
    }
    if (!entry) return;
    entry.status = resp.status();
    const ct = resp.headers()['content-type'] ?? '';
    entry.ct = ct;
    if (ct.includes('pdf')) {
      try {
        const body = await resp.body();
        if (body.length < 1000) return;
        const fname = path.join(ARTIFACT_DIR, `pdf-${Date.now()}.pdf`);
        fs.writeFileSync(fname, body);
        pdfsCaptured.push({ url: resp.url(), bytes: body.length, path: fname });
        process.stderr.write(`\n  📄 PDF (${body.length} bytes): ${resp.url()} → ${fname}\n\n`);
      } catch { /* */ }
    }
  });

  await page.addInitScript('window.__name = function(f){ return f; };');

  try {
    process.stderr.write('[walk] step 1: navigating to resume URL\n');
    await page.goto(resumeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForBridge(page, 30_000);
    await page.waitForTimeout(10_000);

    // Bypass validate so saves can fire
    await page.evaluate(() => {
      const gb = (window as unknown as { guideBridge?: { validate?: () => boolean } }).guideBridge;
      if (gb) try { Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false }); } catch { gb.validate = () => true; }
    });

    // For each panel: fill what's currently visible, save, dismiss modal, wait for transition
    for (const panelNum of [1, 2, 4, 5, 6]) {
      process.stderr.write(`\n[walk] panel ${panelNum}: filling visible empty leaves\n`);

      // Fill all visible empty fields with sensible defaults
      const fillStats = await page.evaluate((pn) => {
        type GN = { name?: string; somExpression?: string; className?: string; items?: GN[]; value?: unknown; visible?: boolean; jsonModel?: { options?: Array<string | { value?: string }> } };
        const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
        const root = gb.resolveNode('rootPanel') as GN | null;
        let counts = { numeric: 0, radio: 0, dd: 0, date: 0, text: 0 };
        const today = new Date().toISOString().slice(0, 10);
        const setVal = (som: string, v: unknown): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* */ } };
        const walk = (n: GN | undefined): void => {
          if (!n || n.visible === false) return;
          if (n.somExpression && Object.prototype.hasOwnProperty.call(n, 'value')) {
            const cur = n.value;
            const empty = cur == null || cur === '';
            if (empty) {
              const cls = (n.className ?? '').toLowerCase();
              if (cls.includes('radiobutton')) { setVal(n.somExpression, '1'); counts.radio++; }
              else if (cls.includes('datepicker')) { setVal(n.somExpression, today); counts.date++; }
              else if (cls.includes('dropdownlist')) {
                const opts = n.jsonModel?.options ?? [];
                for (const o of opts) {
                  const v = typeof o === 'string' ? o.split('=')[0] : (o?.value ?? '');
                  if (v && v !== '') { setVal(n.somExpression, v); counts.dd++; break; }
                }
              } else if (/textbox|textfield|numericbox/i.test(cls)) {
                if (/Current|Previous|Date|Total|Capital|Amount|Tax|Profit|Revenue|Expense/.test(n.name ?? '')) {
                  setVal(n.somExpression, '0.00'); counts.numeric++;
                } else { setVal(n.somExpression, 'NA'); counts.text++; }
              }
            }
          }
          if (Array.isArray(n.items)) for (const k of n.items) walk(k);
        };
        // Filter to current panel's subtree
        const panelKey = `panel${pn}AOC4`;
        const panel = (gb.resolveNode(panelKey) ?? root) as GN;
        walk(panel);
        return counts;
      }, panelNum);
      process.stderr.write(`  filled: ${fillStats.numeric}n ${fillStats.radio}r ${fillStats.dd}dd ${fillStats.date}d ${fillStats.text}t\n`);

      const buttonId = PANEL_SAVE_IDS[panelNum];
      if (!buttonId) continue;

      process.stderr.write(`  clicking panel ${panelNum} Save (waiting for it to enable...)\n`);
      const enabledOk = await page.evaluate(async (id) => {
        const start = Date.now();
        while (Date.now() - start < 15_000) {
          const el = document.getElementById(id) as HTMLButtonElement | null;
          if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null) return true;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      }, buttonId);
      if (!enabledOk) {
        process.stderr.write(`  ⚠ panel ${panelNum} Save did not enable within 15s — skipping\n`);
        continue;
      }

      const respPromise = page.waitForResponse((r) => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 }).catch(() => null);
      await page.evaluate((id) => { document.getElementById(id)?.click(); }, buttonId);
      const resp = await respPromise;
      if (resp) {
        process.stderr.write(`  save fired: ${resp.status()}\n`);
      } else {
        process.stderr.write(`  save did NOT fire commonSaveSubmit\n`);
      }

      // Dismiss the post-save modal so the next panel's button can enable
      await page.waitForTimeout(1500);
      const dismissed = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('button[id*="modal_container"][id$="nextitemnav_copy___widget"]'));
        const visible = candidates.filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
        if (visible.length === 0) return false;
        visible[0].click();
        return true;
      });
      if (dismissed) process.stderr.write(`  dismissed post-save modal\n`);
      await page.waitForTimeout(2500);
    }

    // After all panels saved, look for Submit / Preview / PDF actions
    process.stderr.write('\n[walk] all panels processed. Looking for Submit / Preview / PDF actions\n');
    const finalState = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({
          text: (el.innerText ?? '').trim().slice(0, 60),
          id: el.id ?? '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          disabled: (el as HTMLButtonElement).disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        }))
        .filter((b) => b.text || b.ariaLabel);
      const pdfRelated = buttons.filter((b) => /pdf|preview|download|generate|submit|verify/i.test(b.text + ' ' + b.ariaLabel));
      return { buttonCount: buttons.length, pdfRelated, allButtons: buttons };
    });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'final-state.json'), JSON.stringify(finalState, null, 2));
    process.stderr.write(`[walk] ${finalState.buttonCount} buttons. ${finalState.pdfRelated.length} PDF-related:\n`);
    for (const b of finalState.pdfRelated) process.stderr.write(`    "${b.text}" disabled=${b.disabled}\n`);

    // Click any non-disabled PDF/Submit/Preview action
    const target = finalState.pdfRelated.find((b) => !b.disabled && /pdf|preview|download|generate/i.test(b.text + ' ' + b.ariaLabel));
    if (target) {
      process.stderr.write(`[walk] clicking "${target.text}"\n`);
      await page.evaluate((t: { id: string; text: string }) => {
        const el = t.id ? document.getElementById(t.id) : null;
        if (el) (el as HTMLElement).click();
        else {
          const all = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
          const f = all.find((e) => (e.innerText ?? '').trim().slice(0, 60) === t.text);
          if (f) f.click();
        }
      }, target);
      await page.waitForTimeout(20_000);
    }

    // Take screenshot of the final state
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'final-screenshot.png'), fullPage: true });

    if (pdfsCaptured.length > 0) {
      process.stderr.write(`\n✅ ${pdfsCaptured.length} PDF(s) captured. ${ARTIFACT_DIR}\n`);
    } else {
      process.stderr.write(`\n❌ No PDF. Final state in ${ARTIFACT_DIR}\n`);
    }

    fs.writeFileSync(path.join(ARTIFACT_DIR, 'all-network.json'), JSON.stringify(network, null, 2));
    process.stderr.write('[walk] keeping browser open 60s for inspection\n');
    await page.waitForTimeout(60_000);
  } catch (e) {
    process.stderr.write(`[walk] ERROR: ${(e as Error).message}\n${(e as Error).stack}\n`);
  } finally {
    await teardown(browser);
  }
})();
