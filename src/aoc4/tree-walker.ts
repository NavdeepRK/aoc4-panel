import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { walkLeaves, type FormLeaf } from './bridge.js';

export interface PanelGroup {
  panel: string;
  fields: FormLeaf[];
}

export interface WalkArtifacts {
  totalLeaves: number;
  inputCount: number;
  byPanel: Record<string, number>;
  inputTypes: string[];
  panels: PanelGroup[];
}

/**
 * Walks the live form via guideBridge, classifies fields by panel, and writes per-panel
 * JSON artifacts to disk. The artifacts become the source of truth for the typed field
 * maps in `fields/panel*.ts`.
 *
 * IMPORTANT: A bare walk on a freshly-loaded form misses many fields. AOC-4's panels use
 * conditional rendering — fields like `wetherProFinancialStatement`, `industryType`,
 * `auditorCategory`, `whetherConsolidated` only enter the bridge tree AFTER prefillWithCin
 * runs and certain parent radios are set. Use `walkAndPersist` once for the baseline, then
 * use `mergeWalkAfter(...)` after each conditional trigger to union the discovered fields.
 *
 * For one-shot reliability, see `deepWalk(page, triggers, outputDir)` below.
 */
export async function walkAndPersist(page: Page, outputDir: string): Promise<WalkArtifacts> {
  const inputs = await walkLeaves(page, { includeStatic: false });
  const statics = await walkLeaves(page, { includeStatic: true }).then((all) =>
    all.filter((a) => !inputs.some((i) => i.som === a.som)),
  );

  const groups = new Map<string, FormLeaf[]>();
  for (const leaf of inputs) {
    const m = leaf.som.match(/panel(\d+)AOC4|modal_container_copy_\d+|modal_container/);
    const key = m ? m[0] : 'other';
    const arr = groups.get(key) ?? [];
    arr.push(leaf);
    groups.set(key, arr);
  }

  const inputTypes = [...new Set(inputs.map((l) => l.type))].sort();
  const byPanel: Record<string, number> = {};
  for (const [k, v] of groups) byPanel[k] = v.length;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'aoc4-summary.json'),
    JSON.stringify(
      { totalLeaves: inputs.length + statics.length, inputCount: inputs.length, byPanel, inputTypes },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outputDir, 'aoc4-leaves.json'),
    JSON.stringify({ inputs, statics }, null, 2),
  );
  for (const [panel, fields] of groups) {
    fs.writeFileSync(
      path.join(outputDir, `aoc4-${panel}-fields.json`),
      JSON.stringify(fields, null, 2),
    );
  }

  return {
    totalLeaves: inputs.length + statics.length,
    inputCount: inputs.length,
    byPanel,
    inputTypes,
    panels: [...groups.entries()].map(([panel, fields]) => ({ panel, fields })),
  };
}

/**
 * Performs a baseline walk, optionally runs prefill + a sequence of `setProperty` triggers,
 * then re-walks the form and unions all discovered leaves. Writes per-pass artifacts to disk
 * so each conditional revelation is auditable.
 *
 * Triggers are applied in order. After each, the form is allowed to settle (200ms) and
 * re-walked. The final field-map is the union across all passes (de-duplicated by SOM).
 *
 * Typical usage for AOC-4 small-Pvt scenario:
 *   await deepWalk(page, [
 *     { name: 'natureS', value: 'Adopted Financial statements' },
 *     { name: 'wetherProFinancialStatement', value: '1' },
 *     { name: 'whetherAdoptedAdjAGM', value: '1' },
 *     { name: 'whetherAnnualGeneralMeeting', value: '0' },
 *     { name: 'whetherAnyExtension', value: '1' },
 *   ], outputDir);
 *
 * Each trigger reveals a new conditional sub-panel; together they expose ~95% of small-Pvt fields.
 */
export async function deepWalk(
  page: Page,
  triggers: Array<{ name: string; value: string | number | null }>,
  outputDir: string,
): Promise<{ baseline: WalkArtifacts; afterEach: Array<{ trigger: string; newFields: FormLeaf[] }>; merged: WalkArtifacts }> {
  fs.mkdirSync(outputDir, { recursive: true });
  const baseline = await walkAndPersist(page, outputDir);
  const seenSoms = new Set(baseline.panels.flatMap((g) => g.fields.map((f) => f.som)));
  const allLeaves: FormLeaf[] = baseline.panels.flatMap((g) => g.fields);
  const afterEach: Array<{ trigger: string; newFields: FormLeaf[] }> = [];

  for (const t of triggers) {
    const setRes = await page.evaluate(({ name, value }) => {
      type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
      const gb = (window as unknown as {
        guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void };
      }).guideBridge;
      const root = gb.resolveNode('rootPanel') as GuideNode | null;
      if (!root) return { ok: false, error: 'rootPanel not resolved' };
      let som: string | null = null;
      function find(n: GuideNode | undefined): void {
        if (!n || som) return;
        if (n.name === name && n.somExpression) { som = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) find(k);
      }
      find(root);
      if (!som) return { ok: false, error: `node "${name}" not in tree (yet)` };
      try { gb.setProperty([som], 'value', [value]); return { ok: true, som }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    }, t);
    await page.waitForTimeout(250);

    const after = await walkLeaves(page, { includeStatic: false });
    const newOnes = after.filter((l) => !seenSoms.has(l.som));
    for (const f of newOnes) seenSoms.add(f.som);
    allLeaves.push(...newOnes);
    afterEach.push({ trigger: `${t.name}=${t.value}`, newFields: newOnes });
    fs.writeFileSync(
      path.join(outputDir, `walk-after-${t.name}.json`),
      JSON.stringify({ trigger: t, setResult: setRes, newFields: newOnes }, null, 2),
    );
  }

  // Persist merged artifacts
  const groups = new Map<string, FormLeaf[]>();
  for (const leaf of allLeaves) {
    const m = leaf.som.match(/panel(\d+)AOC4|modal_container_copy_\d+|modal_container/);
    const key = m ? m[0] : 'other';
    const arr = groups.get(key) ?? [];
    arr.push(leaf);
    groups.set(key, arr);
  }
  const byPanel: Record<string, number> = {};
  for (const [k, v] of groups) byPanel[k] = v.length;

  fs.writeFileSync(
    path.join(outputDir, 'aoc4-summary-deep.json'),
    JSON.stringify({ baseline: baseline.byPanel, afterEach: afterEach.map((a) => ({ trigger: a.trigger, newCount: a.newFields.length })), mergedByPanel: byPanel, totalUniqueLeaves: allLeaves.length }, null, 2),
  );
  for (const [panel, fields] of groups) {
    fs.writeFileSync(
      path.join(outputDir, `aoc4-${panel}-fields-deep.json`),
      JSON.stringify(fields, null, 2),
    );
  }

  return {
    baseline,
    afterEach,
    merged: {
      totalLeaves: allLeaves.length,
      inputCount: allLeaves.length,
      byPanel,
      inputTypes: [...new Set(allLeaves.map((l) => l.type))].sort(),
      panels: [...groups.entries()].map(([panel, fields]) => ({ panel, fields })),
    },
  };
}

/**
 * Generates a TypeScript field-map module from a panel's JSON artifact.
 * Output is a `Record<semanticName, somExpression>` plus a typed enum of names.
 */
export function generatePanelFieldsModule(panelJsonPath: string, outPath: string, panelKey: string): void {
  const fields = JSON.parse(fs.readFileSync(panelJsonPath, 'utf8')) as FormLeaf[];

  // De-duplicate by name. AOC-4 has repeated names across array rows
  // (e.g. 5x DINorIncome for 5 signatory rows). Keep the first SOM and emit array helpers.
  const byName = new Map<string, FormLeaf[]>();
  for (const f of fields) {
    const arr = byName.get(f.name) ?? [];
    arr.push(f);
    byName.set(f.name, arr);
  }

  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED from .artifacts/aoc4-${panelKey}-fields.json`);
  lines.push(`// Do not edit by hand — re-run \`npm run aoc4:walk\` to regenerate.`);
  lines.push('');
  lines.push(`export const ${panelKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FIELDS = {`);
  for (const [name, occurrences] of byName) {
    if (occurrences.length === 1) {
      lines.push(`  ${JSON.stringify(name)}: { type: ${JSON.stringify(occurrences[0].type)}, som: ${JSON.stringify(occurrences[0].som)} },`);
    } else {
      // Repeated: emit an array of SOM expressions
      lines.push(`  ${JSON.stringify(name)}: { type: ${JSON.stringify(occurrences[0].type)}, soms: [`);
      for (const o of occurrences) lines.push(`    ${JSON.stringify(o.som)},`);
      lines.push(`  ] },`);
    }
  }
  lines.push(`} as const;`);
  lines.push('');
  lines.push(`export type ${panelKey.replace(/[^A-Za-z0-9]/g, '')}FieldName = keyof typeof ${panelKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FIELDS;`);
  lines.push('');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
}
