/**
 * Standalone inspector that opens MCA's AOC-4 form for a given CIN and dumps the
 * {value, label} mapping for every radio button + dropdown we care about.
 *
 * Use this to figure out the actual AEM enum values when the worker's setProperty
 * appears to succeed but MCA renders the wrong option (e.g. setProperty('1') sets
 * the model to '1' but '1' might actually mean "Not Applicable" not "Yes").
 *
 * Usage:  npm run aoc4:inspect-radios -- U62013HR2024PTC118937
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';

const TARGET_FIELDS = [
  'whetherAnnualGeneralMeeting', 'wetherProFinancialStatement', 'whetherAdoptedAdjAGM',
  'whetherAnyExtension', 'whetherSchedule3', 'whetherConsolidated', 'whetherBooksOfAccount',
  'WhetherCompanyIsSubsidiary', 'whetherCompanyHasSubsidiary', 'categoryOfAuditor',
  'natureS', 'industryType', 'country_Auditor', 'area_locality_Auditor', 'InsuranceOrNBFC',
  'whetherAnyOperating', 'Whether_maintenance', 'Whether_audit_of_cost_records',
  'segmentIVradioIa', 'segmentIVradioIc', 'segmentIVradioII', 'segmentVradio1',
  'csrApplicability', 'rptTransactionsExist', 'Whether_any_transactions_entered',
];

(async (): Promise<void> => {
  const cin = process.argv[2] || 'U62013HR2024PTC118937';
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }

  const outPath = path.join('.artifacts', `radios-${cin}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  console.log(`[inspect] launching browser`);
  const { browser, page } = await launch();
  try {
    await page.addInitScript('window.__name = function(f, n){ return f; };');
    console.log(`[inspect] loading ${AOC4_FORM_URL}`);
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);

    // Skip prefill — it triggers AEM iframe re-render that destroys the eval context.
    // We just need the radio/option DOM structure which is present even without prefill.
    console.log('[inspect] waiting 15s for initial render to settle');
    await page.waitForTimeout(15_000);
    void cin; // unused — kept arg for backwards compat

    // Diagnostic: list all frames + their URLs so we know whether AEM is in an iframe
    const frames = page.frames();
    console.log(`[inspect] ${frames.length} frames in page:`);
    for (const f of frames) console.log(`  - ${f.url().slice(0, 100)} (name=${f.name() || '-'})`);

    // Try $$eval first — more resilient. Falls back to evaluate.
    let dump: unknown = null;
    try {
      // Just dump ALL radio inputs and ALL <select>/option pairs in the entire document.
      // Better to scan everything once than retry evaluate forever.
      dump = await page.$$eval('input[type="radio"], select, option', (els) => {
        const out: { radios: Array<{ value: string; id: string; name: string; label: string }>; selects: Array<{ id: string; name: string; options: Array<{ value: string; text: string }> }> } = { radios: [], selects: [] };
        for (const el of els) {
          if (el instanceof HTMLInputElement && el.type === 'radio') {
            let labelText = '';
            if (el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
              if (lbl?.textContent) labelText = lbl.textContent.trim();
            }
            if (!labelText) labelText = (el.closest('label')?.textContent ?? el.nextElementSibling?.textContent ?? el.getAttribute('aria-label') ?? '').trim();
            out.radios.push({ value: el.value, id: el.id, name: el.name, label: labelText.slice(0, 60) });
          } else if (el instanceof HTMLSelectElement) {
            out.selects.push({ id: el.id, name: el.name, options: Array.from(el.options).map(o => ({ value: o.value, text: (o.textContent ?? '').trim().slice(0, 60) })) });
          }
        }
        return out;
      });
      console.log(`[inspect] $$eval succeeded — ${(dump as { radios: unknown[] }).radios.length} radios, ${(dump as { selects: unknown[] }).selects.length} selects`);
    } catch (e) {
      console.log(`[inspect] $$eval failed: ${(e as Error).message?.slice(0, 100)} — falling back to evaluate`);
    }

    // If $$eval worked, save and exit
    if (dump) {
      fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
      console.log(`[inspect] dump written → ${outPath}`);
      // Filter to our target fields
      const data = dump as { radios: Array<{ value: string; id: string; name: string; label: string }>; selects: Array<{ id: string; name: string; options: Array<{ value: string; text: string }> }> };
      for (const fieldName of TARGET_FIELDS) {
        const fLower = fieldName.toLowerCase();
        const matchedRadios = data.radios.filter(r => r.id.toLowerCase().includes(fLower) || r.name.toLowerCase().includes(fLower));
        const matchedSelects = data.selects.filter(s => s.id.toLowerCase().includes(fLower) || s.name.toLowerCase().includes(fLower));
        console.log(`${fieldName.padEnd(38)} radios=${matchedRadios.length} selects=${matchedSelects.length}`);
        for (const r of matchedRadios) console.log(`    radio value="${r.value}" label="${r.label}" id="${r.id.slice(-50)}"`);
        for (const s of matchedSelects) {
          console.log(`    select id="${s.id.slice(-50)}"`);
          for (const o of s.options.slice(0, 8)) console.log(`       opt value="${o.value}" text="${o.text}"`);
        }
      }
      await browser.close();
      return;
    }

    // Aggressive dump — retry on navigation
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        dump = await page.evaluate((names) => {
          type GuideNode = {
            name?: string;
            somExpression?: string;
            className?: string;
            value?: unknown;
            items?: GuideNode[];
            options?: Array<{ value: unknown; label?: string }>;
            jsonModel?: { options?: unknown };
            _view?: { element?: HTMLElement };
          };
          const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
          const root = gb.resolveNode('rootPanel') as GuideNode | null;
          const findNode = (n: string): GuideNode | null => {
            let f: GuideNode | null = null;
            const walk = (k: GuideNode | undefined): void => {
              if (!k || f) return;
              if (k.name === n) { f = k; return; }
              if (Array.isArray(k.items)) for (const c of k.items) walk(c);
            };
            walk(root ?? undefined);
            return f;
          };

          const out: Array<{
            name: string; found: boolean; cls?: string; currentValue?: unknown;
            modelOptions?: Array<{ value: unknown; label?: string }>;
            jsonModelOptions?: unknown;
            domRadios?: Array<{ value: string; label: string; id: string; name: string }>;
            domSelectOptions?: Array<{ value: string; text: string }>;
          }> = [];

          for (const fieldName of names) {
            const node = findNode(fieldName);
            const entry: typeof out[number] = { name: fieldName, found: !!node };
            if (node) {
              entry.cls = node.className;
              entry.currentValue = node.value;
              entry.modelOptions = node.options;
              entry.jsonModelOptions = node.jsonModel?.options;
            }

            // DOM scan: find radios/options near the field name
            const fLower = fieldName.toLowerCase();
            // Radios
            const radioMatches: Array<{ value: string; label: string; id: string; name: string }> = [];
            for (const r of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
              let el: HTMLElement | null = r;
              let depth = 0;
              let near = false;
              while (el && depth < 15) {
                if (el.id && el.id.toLowerCase().includes(fLower)) { near = true; break; }
                el = el.parentElement;
                depth++;
              }
              if (!near && !((r.name ?? '').toLowerCase().includes(fLower) || (r.id ?? '').toLowerCase().includes(fLower))) continue;
              let lt = '';
              if (r.id) {
                const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(r.id)}"]`);
                if (lbl?.textContent) lt = lbl.textContent.trim();
              }
              if (!lt) lt = (r.closest('label')?.textContent ?? r.nextElementSibling?.textContent ?? r.getAttribute('aria-label') ?? '').trim();
              radioMatches.push({ value: r.value, label: lt.slice(0, 50), id: r.id, name: r.name });
            }
            if (radioMatches.length > 0) entry.domRadios = radioMatches;

            // Selects (dropdowns)
            for (const s of Array.from(document.querySelectorAll<HTMLSelectElement>('select'))) {
              let el: HTMLElement | null = s;
              let depth = 0;
              let near = false;
              while (el && depth < 15) {
                if (el.id && el.id.toLowerCase().includes(fLower)) { near = true; break; }
                el = el.parentElement;
                depth++;
              }
              if (!near) continue;
              entry.domSelectOptions = Array.from(s.options).map(o => ({ value: o.value, text: (o.textContent ?? '').trim().slice(0, 50) }));
              break;
            }
            out.push(entry);
          }
          return out;
        }, TARGET_FIELDS);
        console.log(`[inspect] dump succeeded on attempt ${attempt}`);
        break;
      } catch (e) {
        console.log(`[inspect] attempt ${attempt} failed: ${(e as Error).message?.slice(0, 100)}`);
        await page.waitForTimeout(3000);
      }
    }

    if (dump) {
      fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));
      console.log(`[inspect] dump written → ${outPath}`);
      const summary = dump as Array<{ name: string; found: boolean; cls?: string; modelOptions?: unknown; domRadios?: unknown[]; domSelectOptions?: unknown[] }>;
      for (const e of summary) {
        const radios = (e.domRadios as Array<{ value: string; label: string }> | undefined) ?? [];
        const opts   = (e.domSelectOptions as Array<{ value: string; text: string }> | undefined) ?? [];
        console.log(`  ${e.name.padEnd(35)} found=${e.found} cls=${e.cls ?? '-'}`);
        for (const r of radios) console.log(`     radio: value="${r.value}" label="${r.label}"`);
        for (const o of opts.slice(0, 8)) console.log(`     option: value="${o.value}" text="${o.text}"`);
      }
    } else {
      console.log('[inspect] all 10 attempts failed');
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
