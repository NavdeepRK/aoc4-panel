import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright';
import {
  AOC4_FORM_URL,
  waitForBridge,
  getFormData,
  setFieldsBySom,
  triggerFieldChange,
  saveAndAdvance,
  type FormLeaf,
  type SaveAndAdvanceResult,
} from './bridge.js';
import { fetchCompanyInfo, snapshotAllLookups, type CompanyInfoResponse } from './fdm-client.js';

export interface AOC4FilingData {
  /** Optional CIN — required to drive any prefill in production runs */
  cin?: string;
  /**
   * Per-panel data. Each panel is a `Record<fieldName, value>`.
   * Field names are the semantic names from `fields/*.ts`.
   */
  panel1?: Record<string, string | number | null>;
  panel2?: Record<string, string | number | null>;
  panel3?: Record<string, string | number | null>;
  panel4?: Record<string, string | number | null>;
  panel5?: Record<string, string | number | null>;
  panel6?: Record<string, string | number | null>;
  panel7?: Record<string, string | number | null>;
}

export interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  requestBody?: string | null;
  responseBody: string;
  bodyLen: number;
  contentType?: string;
  timestamp: string;
}

export interface RunOptions {
  /** Where to write captured network logs. Default: ./.artifacts/runs/<timestamp>/ */
  artifactDir?: string;
  /** When true, snapshot all known FDM lookups to disk on form-load. */
  captureLookups?: boolean;
  /** When true, dump full guideBridge form data after each panel save. */
  dumpFormDataAfterEachPanel?: boolean;
  /** Path to JSON file with field maps (panel name -> fieldName -> SOM). */
  fieldMapPath?: string;
}

export async function loadAOC4Form(page: Page, opts: RunOptions = {}): Promise<{ artifactDir: string; capturedRequests: NetworkCapture[] }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = opts.artifactDir ?? `./.artifacts/runs/${stamp}`;
  fs.mkdirSync(artifactDir, { recursive: true });

  const capturedRequests: NetworkCapture[] = [];
  const handler = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!/\.af\.dermis|\/bin\/mca\/|\.af\.internalsubmit/.test(url)) return;
    try {
      const body = await resp.text();
      capturedRequests.push({
        url,
        method: resp.request().method(),
        status: resp.status(),
        requestBody: resp.request().postData(),
        responseBody: body,
        bodyLen: body.length,
        contentType: resp.headers()['content-type'],
        timestamp: new Date().toISOString(),
      });
    } catch {}
  };
  page.on('response', handler);

  await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForBridge(page, 30_000);
  // Network idle gives FDM init calls time to land
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  // Persist captured calls
  fs.writeFileSync(path.join(artifactDir, 'load-network.json'), JSON.stringify(capturedRequests, null, 2));

  if (opts.captureLookups) {
    const lookups = await snapshotAllLookups(page);
    fs.writeFileSync(path.join(artifactDir, 'lookups-snapshot.json'), JSON.stringify(lookups, null, 2));
  }

  return { artifactDir, capturedRequests };
}

export async function prefillFromUserInfo(page: Page, userEmail: string): Promise<CompanyInfoResponse | null> {
  return await fetchCompanyInfo(page, userEmail);
}

interface FieldMapEntry { type: string; som?: string; soms?: string[] }
interface PanelFieldMap { [fieldName: string]: FieldMapEntry }
interface FullFieldMap { [panelKey: string]: PanelFieldMap }

function loadFieldMap(fieldMapPath: string | undefined): FullFieldMap {
  if (!fieldMapPath || !fs.existsSync(fieldMapPath)) return {};
  return JSON.parse(fs.readFileSync(fieldMapPath, 'utf8')) as FullFieldMap;
}

/**
 * Fills a single panel's fields, runs validation, clicks Save (capturing /bin/commonSaveSubmit),
 * and optionally advances to the next panel. Returns per-field set results, the save outcome,
 * and the form-data dump after Save.
 *
 * The internal `panel1` shorthand maps to AEM's `panel1AOC4` SOM key. We accept the short form
 * for ergonomic call sites; saveAndAdvance needs the full key.
 */
export async function fillPanel(
  page: Page,
  panelKey: 'panel1' | 'panel2' | 'panel3' | 'panel4' | 'panel5' | 'panel6' | 'panel7',
  values: Record<string, string | number | null>,
  fieldMap: FullFieldMap,
  opts: { triggerChangeAfterEach?: boolean; save?: boolean; advance?: boolean; requireValid?: boolean } = {},
): Promise<{
  setResults: Awaited<ReturnType<typeof setFieldsBySom>>;
  saveResult?: SaveAndAdvanceResult;
  postSaveData?: Record<string, unknown>;
}> {
  const map = fieldMap[panelKey] ?? {};
  const fields: Array<{ som: string; value: string | number | null; name: string }> = [];
  for (const [fname, val] of Object.entries(values)) {
    const entry = map[fname];
    if (!entry) continue;
    const som = entry.som ?? entry.soms?.[0];
    if (!som) continue;
    fields.push({ som, value: val, name: fname });
  }

  const setResults = await setFieldsBySom(page, fields);

  if (opts.triggerChangeAfterEach) {
    for (const f of fields) await triggerFieldChange(page, f.som);
  }

  let saveResult: SaveAndAdvanceResult | undefined;
  if (opts.save !== false) {
    const aemPanelKey = `${panelKey}AOC4` as const;
    saveResult = await saveAndAdvance(page, aemPanelKey, {
      requireValid: opts.requireValid ?? true,
      advance: opts.advance ?? false,
    });
  }

  const dump = await getFormData(page);
  return { setResults, saveResult, postSaveData: dump.formData ?? undefined };
}

/**
 * End-to-end orchestrator. Walks Company Details → Attachments → Review, but stops one
 * step before the final DSC sign step. The human plugs in the DSC and clicks Submit.
 */
export async function runFiling(page: Page, data: AOC4FilingData, opts: RunOptions = {}): Promise<{ artifactDir: string }> {
  const { artifactDir } = await loadAOC4Form(page, { ...opts, captureLookups: opts.captureLookups ?? true });
  const fieldMap = loadFieldMap(opts.fieldMapPath ?? './.artifacts/aoc4-field-map.json');

  const panels = ['panel1', 'panel2', 'panel3', 'panel4', 'panel5', 'panel6', 'panel7'] as const;
  let lastSrId: string | undefined;
  for (const p of panels) {
    const values = data[p];
    if (!values) continue;
    // Advance after every panel except the last — final panel save is followed by DSC, not Next.
    const isLast = p === panels[panels.length - 1];
    const result = await fillPanel(page, p, values, fieldMap, {
      triggerChangeAfterEach: true,
      save: true,
      advance: !isLast,
      requireValid: true,
    });
    if (result.saveResult?.srId) lastSrId = result.saveResult.srId;
    fs.writeFileSync(
      path.join(artifactDir, `${p}-fill-result.json`),
      JSON.stringify(result, null, 2),
    );
    if (result.saveResult && !result.saveResult.ok) {
      // Stop on first save failure — subsequent panels won't load until the SR row exists.
      fs.writeFileSync(
        path.join(artifactDir, `${p}-stopped.json`),
        JSON.stringify({ reason: 'save not ok; stopping run', notes: result.saveResult.notes }, null, 2),
      );
      break;
    }
  }

  if (lastSrId) {
    fs.writeFileSync(path.join(artifactDir, 'sr-id.txt'), lastSrId);
  }

  // Stop before DSC submission. Human handoff from here.
  return { artifactDir };
}

/**
 * Capture-only run: load form, snapshot all FDM operations + form data, exit.
 * Useful for regenerating the API response samples without filing anything.
 */
export async function captureOnly(page: Page, opts: RunOptions = {}): Promise<{ artifactDir: string }> {
  const { artifactDir } = await loadAOC4Form(page, { ...opts, captureLookups: true });
  const data = await getFormData(page);
  fs.writeFileSync(path.join(artifactDir, 'initial-form-data.json'), JSON.stringify({ formData: data.formData, unbound: data.unbound }, null, 2));
  return { artifactDir };
}

export { walkAndPersist } from './tree-walker.js';
export type { FormLeaf };
