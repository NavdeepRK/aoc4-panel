/**
 * Deep introspection of the live MCA AOC-4 AEM form.
 *
 * Goal: walk every panel + every field on the LIVE form and produce a comprehensive
 * JSON describing the actual fields MCA renders TODAY (vs. the PDF which may be older).
 *
 * For each field we capture:
 *   - name              SOM/internal field name (e.g. "whetherAnnualGeneralMeeting")
 *   - somExpression     full SOM path (used by gb.setProperty)
 *   - type              guideTextBox / guideDropDownList / guideRadioButton / guideDatePicker / ...
 *   - label             human-readable question text (from caption.value or surrounding DOM)
 *   - longDescription   help text (when present)
 *   - mandatory         required flag
 *   - readOnly          ditto
 *   - visible           current visibility (used to discover conditional fields)
 *   - currentValue      already-prefilled value (useful as a default in the schema)
 *   - enum              for dropdown / radio — array of internal values
 *   - enumNames         for dropdown / radio — array of human-readable labels (parallel to enum)
 *   - panelPath         dot-separated path of containing panels (rootPanel → segment1 → partA → ...)
 *
 * Conditional-field discovery: AOC-4 panels render fields conditionally — e.g.
 * SRN-of-INC-28 only appears when natureOfFinancialStatements is "Revised...". The introspect
 * fires a small set of "triggers" (set Yes on every binary radio, then No) and merges the
 * diff of newly-appearing fields after each trigger.
 *
 * Output:
 *   .artifacts/aoc4-full-introspect.json   — array of fields with full metadata
 *   .artifacts/aoc4-full-summary.json      — per-panel counts + field-type breakdown
 *
 * Usage:  npm run aoc4:introspect [CIN-to-prefill-with]
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { loadAOC4Form } from '../aoc4/runner.js';

const TS = () => new Date().toISOString().split('T')[1].slice(0, 12);
const log = (m: string) => console.log(`[${TS()}] [introspect] ${m}`);

/* ───────────────────────────── In-page introspection ───────────────────────────── */

/**
 * Code executed inside the browser. Returns full field metadata for every node in the
 * guideBridge tree. We try multiple property paths for each piece of metadata since AEM
 * stores them inconsistently (legacy `caption` vs `label`, `enum` vs `enumNames`, etc.).
 */
async function introspectInPage(page: import('playwright').Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(() => {
    // tsx/esbuild injects `__name(fn, "name")` helpers when transpiling — polyfill so
    // browser-side execution doesn't ReferenceError.
    const g = globalThis as unknown as { __name?: <T>(fn: T) => T };
    if (typeof g.__name !== 'function') g.__name = <T>(fn: T) => fn;
    type N = {
      name?: string;
      somExpression?: string;
      className?: string;
      type?: string;
      visible?: boolean;
      mandatory?: boolean;
      readOnly?: boolean;
      value?: unknown;
      caption?: { value?: string };
      label?: { value?: string } | string;
      longDescription?: string | { value?: string };
      assistive?: string;
      placeholder?: string;
      enum?: unknown[];
      enumNames?: unknown[];
      items?: N[];
      _view?: { element?: HTMLElement };
    };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as N | null;
    if (!root) return [];

    const out: Array<Record<string, unknown>> = [];

    const labelOf = (n: N): string => {
      // Common AEM places labels can live
      const cap = (n.caption as { value?: string } | undefined)?.value;
      if (cap) return cap.replace(/<[^>]+>/g, '').trim();
      if (typeof n.label === 'string') return n.label.replace(/<[^>]+>/g, '').trim();
      const lblObj = n.label as { value?: string } | undefined;
      if (lblObj?.value) return lblObj.value.replace(/<[^>]+>/g, '').trim();
      // Fallback: pull the rendered label from the DOM
      try {
        const el = n._view?.element;
        if (el) {
          const dom = el.querySelector?.('.guideFieldLabel, label, legend, .questionItemLabel');
          const t = dom?.textContent?.trim();
          if (t) return t;
        }
      } catch { /* ignore */ }
      return '';
    };

    const helpOf = (n: N): string => {
      const ld = n.longDescription;
      if (typeof ld === 'string') return ld.replace(/<[^>]+>/g, '').trim();
      if (ld && typeof ld === 'object' && 'value' in ld) {
        return String((ld as { value?: string }).value ?? '').replace(/<[^>]+>/g, '').trim();
      }
      return '';
    };

    /** Build a dot-separated path of containing panel `name`s. */
    const walk = (n: N | undefined, panelPath: string[]): void => {
      if (!n) return;
      const isPanel = /panel/i.test(n.className || n.type || '');
      const nextPath = isPanel && n.name ? [...panelPath, n.name] : panelPath;

      // Leaf detection — has `value` in prototype chain AND is an input-y type
      const isInput = /TextBox|TextField|DropDownList|RadioButton|CheckBox|DatePicker|TextArea|NumericBox|PasswordBox/i.test(n.className || n.type || '');
      if (isInput && n.somExpression && n.name) {
        const entry: Record<string, unknown> = {
          name:            n.name,
          som:             n.somExpression,
          type:            n.className || n.type || '',
          label:           labelOf(n),
          longDescription: helpOf(n),
          mandatory:       n.mandatory === true,
          readOnly:        n.readOnly === true,
          visible:         n.visible !== false,
          currentValue:    n.value ?? null,
          enum:            Array.isArray(n.enum) ? n.enum : null,
          enumNames:       Array.isArray(n.enumNames) ? n.enumNames : null,
          panelPath:       nextPath.join('.'),
          placeholder:     n.placeholder ?? null,
          assistive:       n.assistive ?? null,
        };

        // For radio/dropdown nodes, also scrape <option> elements from the DOM to capture
        // the (label, internal value) pairs — AEM sometimes stores these only on the rendered <select>.
        try {
          const el = n._view?.element;
          if (el) {
            const sel = el.querySelector?.('select') as HTMLSelectElement | null;
            if (sel && (!entry.enum || (entry.enum as unknown[]).length === 0)) {
              const opts: Array<{ value: string; label: string }> = [];
              for (const opt of Array.from(sel.options)) {
                opts.push({ value: opt.value, label: (opt.textContent || '').trim() });
              }
              if (opts.length > 0) entry.domOptions = opts;
            }
            const radios = el.querySelectorAll?.('input[type="radio"]') as NodeListOf<HTMLInputElement>;
            if (radios && radios.length > 0 && (!entry.enum || (entry.enum as unknown[]).length === 0)) {
              const opts: Array<{ value: string; label: string }> = [];
              for (const r of Array.from(radios)) {
                const lbl: Element | null = r.closest('label') ?? (r.id ? el.querySelector(`label[for="${r.id}"]`) : null);
                opts.push({ value: r.value, label: (lbl?.textContent || '').trim() });
              }
              if (opts.length > 0) entry.domOptions = opts;
            }
          }
        } catch { /* ignore */ }

        out.push(entry);
      }

      if (Array.isArray(n.items)) for (const k of n.items) walk(k, nextPath);
    };

    walk(root, []);
    return out;
  });
}

/**
 * Trigger conditional-field discovery: toggle every binary radio (Yes/No) on the current
 * panel, walk after each toggle, and collect any newly-appearing fields. Then restore.
 *
 * We use a heuristic — set each radio to "Yes" then "No" — to surface fields that only
 * render under one of those branches.
 */
async function exposeConditionals(page: import('playwright').Page): Promise<Array<Record<string, unknown>>> {
  const seenSoms = new Set<string>();
  const collected: Array<Record<string, unknown>> = [];

  const baseline = await introspectInPage(page);
  for (const f of baseline) { seenSoms.add(String(f.som)); collected.push(f); }
  log(`baseline fields: ${baseline.length}`);

  // Find binary radio/dropdown fields with Yes/No options
  const triggers: Array<{ som: string; values: string[] }> = [];
  for (const f of baseline) {
    const opts = (f.enum || (f as { domOptions?: Array<{ value: string }> }).domOptions || []) as Array<string | { value: string }>;
    const optVals = opts.map(o => typeof o === 'string' ? o : o.value);
    if (optVals.length >= 2 && optVals.length <= 4) {
      triggers.push({ som: String(f.som), values: optVals.filter(v => typeof v === 'string') as string[] });
    }
  }
  log(`will toggle ${triggers.length} radio/dropdown fields to expose conditional children`);

  for (const t of triggers) {
    for (const v of t.values) {
      try {
        await page.evaluate(({ som, value }) => {
          const g = globalThis as unknown as { __name?: <T>(fn: T) => T };
          if (typeof g.__name !== 'function') g.__name = <T>(fn: T) => fn;
          const gb = (window as unknown as { guideBridge: { setProperty: (s: string[], p: string, vs: unknown[]) => void } }).guideBridge;
          try { gb.setProperty([som], 'value', [value]); } catch { /* ignore */ }
        }, { som: t.som, value: v });
        await page.waitForTimeout(150); // let AEM re-render
        const next = await introspectInPage(page);
        let added = 0;
        for (const f of next) {
          const som = String(f.som);
          if (!seenSoms.has(som)) {
            seenSoms.add(som);
            collected.push({ ...f, _discoveredAfter: `${t.som}=${v}` });
            added++;
          }
        }
        if (added > 0) log(`${t.som}=${v} exposed ${added} new field(s)`);
      } catch { /* ignore */ }
    }
  }

  return collected;
}

/* ───────────────────────────── Per-panel navigation ───────────────────────────── */

const PANEL_KEYS = ['panel1AOC4', 'panel2AOC4', 'panel3AOC4', 'panel4AOC4', 'panel5AOC4', 'panel6AOC4', 'panel7AOC4'];

/**
 * Make a panel the active one without saving. AEM has internal nav helpers; we simply set
 * `gb.setFocus(panelSOM)` which switches the view to that panel without firing save.
 */
async function navigateToPanel(page: import('playwright').Page, panelKey: string): Promise<boolean> {
  return await page.evaluate((key) => {
    const g = globalThis as unknown as { __name?: <T>(fn: T) => T };
    if (typeof g.__name !== 'function') g.__name = <T>(fn: T) => fn;
    type GB = {
      resolveNode: (s: string) => { somExpression?: string } | null;
      setFocus?: (s: string) => void;
    };
    const gb = (window as unknown as { guideBridge: GB }).guideBridge;
    const node = gb.resolveNode(key);
    if (!node?.somExpression) return false;
    try {
      gb.setFocus?.(node.somExpression);
      return true;
    } catch { return false; }
  }, panelKey);
}

/* ───────────────────────────── Main ───────────────────────────── */

async function main(): Promise<void> {
  const cin = process.argv[2] || 'U62013HR2024PTC118937';   // PharmLogic by default
  log(`prefill CIN: ${cin}`);

  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }

  const { browser, page } = await launch();
  try {
    await loadAOC4Form(page, { captureLookups: false });
    log('form loaded; firing prefillWithCin to expose CIN-dependent fields…');

    // Prefill panel 1 with the CIN — many fields only enter the tree after this fires.
    await page.evaluate(async (cin) => {
      const g = globalThis as unknown as { __name?: <T>(fn: T) => T };
      if (typeof g.__name !== 'function') g.__name = <T>(fn: T) => fn;
      type W = { prefillWithCin?: (c: string) => Promise<unknown> };
      const w = window as unknown as W;
      if (typeof w.prefillWithCin === 'function') {
        try { await w.prefillWithCin(cin); } catch { /* ignore */ }
      }
    }, cin);
    await page.waitForTimeout(2500);

    // Walk panel by panel
    const allFields: Array<Record<string, unknown>> = [];
    const perPanelCounts: Record<string, number> = {};
    for (const panelKey of PANEL_KEYS) {
      const ok = await navigateToPanel(page, panelKey);
      if (!ok) { log(`could not focus ${panelKey} — skipping`); continue; }
      await page.waitForTimeout(1200);
      const collected = await exposeConditionals(page);
      log(`${panelKey}: collected ${collected.length} fields total`);
      perPanelCounts[panelKey] = collected.length;
      // Tag with which panel they came from (panelPath may not always set if nodes are deep)
      for (const f of collected) {
        allFields.push({ ...f, sourcePanel: panelKey });
      }
    }

    // Deduplicate (a field can show up in multiple panels' walks if SOM is shared)
    const seen = new Set<string>();
    const deduped: Array<Record<string, unknown>> = [];
    for (const f of allFields) {
      const k = String(f.som);
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(f);
    }

    // Write artifacts
    const outDir = path.resolve('./.artifacts');
    fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, 'aoc4-full-introspect.json');
    fs.writeFileSync(outPath, JSON.stringify({ cin, timestamp: new Date().toISOString(), perPanelCounts, fields: deduped }, null, 2));
    log(`wrote ${deduped.length} unique fields → ${outPath}`);

    // Summary breakdown
    const byType: Record<string, number> = {};
    const byPanel: Record<string, number> = {};
    let withLabel = 0;
    let withEnum = 0;
    for (const f of deduped) {
      const t = String(f.type || 'unknown');
      byType[t] = (byType[t] || 0) + 1;
      const p = String(f.sourcePanel || 'unknown');
      byPanel[p] = (byPanel[p] || 0) + 1;
      if (f.label) withLabel++;
      if ((f.enum && (f.enum as unknown[]).length) || (f as { domOptions?: unknown[] }).domOptions) withEnum++;
    }
    const summaryPath = path.join(outDir, 'aoc4-full-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      totalFields: deduped.length,
      withLabel,
      withEnumOptions: withEnum,
      byType,
      byPanel,
    }, null, 2));
    log(`summary → ${summaryPath}`);
    log(`total=${deduped.length}, with-label=${withLabel}, with-options=${withEnum}`);

  } finally {
    await teardown(browser).catch(() => { /* ignore */ });
  }
}

main().catch((e) => {
  console.error('[introspect] fatal:', e);
  process.exit(1);
});
