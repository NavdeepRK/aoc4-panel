import type { Page } from 'playwright';

export const AOC4_FORM_URL =
  'https://www.mca.gov.in/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html';

export const AOC4_GUIDE_PATH =
  '/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer';

/**
 * Accessibility wrapper around AEM's `window.guideBridge`. Lives in the page context;
 * everything is invoked via `page.evaluate(...)`.
 *
 * Key insight from validation: AEM's `setData(...)` is just `restoreGuideState(...)`
 * — it expects a guideState object, NOT a JSON data payload. Bulk write via setData
 * does NOT work on the MCA form. The blessed runtime write path is per-field via SOM:
 *
 *     gb.resolveNode('<som-expression>').value = newValue;
 *
 * This module exposes that pattern as a typed API.
 */

export interface FormLeaf {
  /** Semantic name (design-time identifier) */
  name: string;
  /** Component type (guideTextBox / guideDropDownList / guideDatePicker / etc.) */
  type: string;
  /** SOM expression — the canonical addressable path */
  som: string;
}

export interface SetFieldResult {
  ok: boolean;
  before?: unknown;
  after?: unknown;
  error?: string;
}

export interface AOC4FormDataDump {
  /** Parsed bound form data: shape = afData.afBoundData.data.requestBody.formData */
  formData: Record<string, unknown> | null;
  /** Parsed unbound form data: shape = afData.afUnboundData.data */
  unbound: Record<string, unknown> | null;
  /** Raw JSON string returned by guideBridge.getDataXML */
  raw: string;
}

export async function waitForBridge(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as { guideBridge?: { isConnected?: () => boolean } }).guideBridge
      && !!(window as unknown as { guideBridge: { isConnected: () => boolean } }).guideBridge.isConnected?.()
      && !!(window as unknown as { guideBridge: { isGuideLoaded: () => boolean } }).guideBridge.isGuideLoaded?.(),
    { timeout: timeoutMs },
  );
}

/**
 * Walks the entire form tree and returns every leaf with its SOM expression.
 * Filters to actual input fields by default (drops images, static text, panels).
 */
export async function walkLeaves(page: Page, opts: { includeStatic?: boolean } = {}): Promise<FormLeaf[]> {
  const includeStatic = !!opts.includeStatic;
  return await page.evaluate(({ includeStatic: incl }) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (som: string) => unknown } }).guideBridge;
    const root = gb.resolveNode('rootPanel');
    if (!root) return [];
    const inputTypes = /guideTextBox|guideTextField|guideDropDownList|guideRadioButton|guideCheckBox|guideDatePicker|guideTextArea|guideNumericBox|guidePasswordBox/i;
    const out: FormLeaf[] = [];
    function safeIn(o: unknown, k: string): boolean {
      return o !== null && typeof o === 'object' && k in (o as Record<string, unknown>);
    }
    function walk(node: unknown, depth: number): void {
      if (!node || depth > 18 || typeof node !== 'object') return;
      let kids: unknown[] | null = null;
      try { kids = (node as { items?: unknown[] }).items ?? null; } catch {}
      if (Array.isArray(kids) && kids.length > 0) {
        for (const k of kids) walk(k, depth + 1);
        return;
      }
      let name = '', type = '', som = '';
      try { name = (node as { name?: string }).name ?? ''; } catch {}
      try { type = (node as { className?: string; type?: string }).className ?? (node as { type?: string }).type ?? ''; } catch {}
      try { som = (node as { somExpression?: string }).somExpression ?? ''; } catch {}
      if (!som) return;
      if (!incl && !inputTypes.test(type)) return;
      if (!safeIn(node, 'value')) return;
      out.push({ name, type, som });
    }
    walk(root, 0);
    return out;
  }, { includeStatic });
}

/** Reads the form's complete bound + unbound data via guideBridge.getDataXML. */
export async function getFormData(page: Page): Promise<AOC4FormDataDump> {
  return await page.evaluate(async () => {
    const gb = (window as unknown as { guideBridge: { getDataXML: (opts: { success: (r: unknown) => void; error: (e: unknown) => void }) => void } }).guideBridge;
    const raw = await new Promise<string>((resolve) => {
      gb.getDataXML({
        success: (r) => resolve(typeof r === 'string' ? r : ((r as { data?: string })?.data ?? '')),
        error: () => resolve(''),
      });
      setTimeout(() => resolve(''), 8000);
    });
    let parsed: { afData?: { afBoundData?: { data?: { requestBody?: { formData?: Record<string, unknown> } } }; afUnboundData?: { data?: Record<string, unknown> } } } | null = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    return {
      raw,
      formData: parsed?.afData?.afBoundData?.data?.requestBody?.formData ?? null,
      unbound: parsed?.afData?.afUnboundData?.data ?? null,
    };
  });
}

/**
 * Sets a field value via SOM expression using AEM's documented `guideBridge.setProperty`
 * bulk API. **This is the only safe write path for fields that will be submitted.**
 *
 * Why setProperty (not `node.value = X`):
 *
 * `node.value = X` writes only the AEM data model. `getDataXML()` reflects the value, but:
 *  - The DOM `<input>` widget stays empty
 *  - AEM's validation pipeline (run on Save click) reads DOM, not model
 *  - Save fails with "Please enter the relevant details" for every SOM-only-written field
 *
 * `gb.setProperty([som], 'value', [val])`:
 *  - Updates model AND DOM in one call
 *  - Triggers AEM's reactive observers (validation, downstream computations)
 *  - Is the documented Adobe API for "wrapper HTML or external scripts" use cases
 *
 * Live-validated 2026-04-29 against MCA AOC-4 form `fromDate` field.
 * See `docs/MCA_AUTOMATION_LESSONS.md` §5b for the full story.
 */
export async function setFieldBySom(page: Page, som: string, value: string | number | null): Promise<SetFieldResult> {
  return await page.evaluate(({ som: s, value: v }) => {
    const gb = (window as unknown as {
      guideBridge: {
        resolveNode: (som: string) => { value?: unknown } | null;
        setProperty: (soms: string[], property: string, values: unknown[]) => void;
      };
    }).guideBridge;
    const node = gb.resolveNode(s);
    if (!node) return { ok: false, error: 'node not resolved' };
    const before = (node as { value?: unknown }).value;
    try {
      gb.setProperty([s], 'value', [v]);
    } catch (e) {
      return { ok: false, error: (e as Error).message, before };
    }
    return { ok: true, before, after: (node as { value?: unknown }).value };
  }, { som, value });
}

/**
 * Convert a user-friendly date (DD/MM/YYYY or DD-MM-YYYY) to the canonical
 * AEM model format (yyyy-MM-dd). The DOM auto-displays it back as DD/MM/YYYY
 * via the form's display formatter.
 *
 * Why this matters: `setProperty` writes the value AS-IS into the model.
 * AEM's date validateExp uses `new Date(this.value)` which parses by browser locale.
 * `new Date("15/04/2026")` is Invalid Date in any locale (no month 15). The model
 * needs ISO `yyyy-MM-dd` for `new Date()` to parse correctly.
 *
 * Live-validated against MCA AOC-4 form 2026-04-29.
 */
export function toAemDate(input: string | Date): string {
  if (input instanceof Date) {
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const d = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(input).trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY → yyyy-MM-dd
  const m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // MM/DD/YYYY (US) — explicitly NOT supported, force user to disambiguate
  throw new Error(`toAemDate: cannot parse "${s}". Use DD/MM/YYYY or yyyy-MM-dd.`);
}

/**
 * Bulk-set many fields in ONE setProperty call. Faster than multiple setFieldBySom
 * because AEM's reactive pipeline runs once for the whole batch instead of per field.
 * Use when you have ≥3 fields to set on the same panel.
 */
export async function setFieldsBatch(
  page: Page,
  fields: Array<{ som: string; value: string | number | null }>,
): Promise<{ ok: boolean; setCount: number; error?: string }> {
  return await page.evaluate((fs) => {
    const gb = (window as unknown as {
      guideBridge: {
        setProperty: (soms: string[], property: string, values: unknown[]) => void;
      };
    }).guideBridge;
    const soms = fs.map((f) => f.som);
    const vals = fs.map((f) => f.value);
    try {
      gb.setProperty(soms, 'value', vals);
      return { ok: true, setCount: fs.length };
    } catch (e) { return { ok: false, setCount: 0, error: (e as Error).message }; }
  }, fields);
}

/**
 * Bulk sets multiple fields by SOM expression. Returns per-field result.
 */
export async function setFieldsBySom(
  page: Page,
  fields: Array<{ som: string; value: string | number | null; name?: string }>,
): Promise<Array<{ name?: string; som: string; result: SetFieldResult }>> {
  const out: Array<{ name?: string; som: string; result: SetFieldResult }> = [];
  for (const f of fields) {
    out.push({ name: f.name, som: f.som, result: await setFieldBySom(page, f.som, f.value) });
  }
  return out;
}

/**
 * Forces AEM to fire the field's change events so downstream computations + validation run.
 * AEM's GuideField has `dispatch(...)` on it; we use the GuideBridge's own value-set if exposed.
 */
export async function triggerFieldChange(page: Page, som: string): Promise<{ ok: boolean; error?: string }> {
  return await page.evaluate(({ som: s }) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (som: string) => unknown } }).guideBridge;
    const node = gb.resolveNode(s) as { dispatch?: (e: unknown) => void; markUserChange?: () => void; value?: unknown } | null;
    if (!node) return { ok: false, error: 'node not resolved' };
    try {
      // markUserChange is the AEM blessed way to indicate user-driven change
      if (typeof node.markUserChange === 'function') node.markUserChange();
      // Some AEM forms also dispatch a 'change' event on the GuideField
      if (typeof node.dispatch === 'function') node.dispatch({ type: 'change', value: node.value });
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, { som });
}

export async function runFormValidation(page: Page): Promise<{ valid: boolean; raw?: unknown }> {
  return await page.evaluate(() => {
    const gb = (window as unknown as { guideBridge: { validate: () => unknown } }).guideBridge;
    try {
      const r = gb.validate();
      // AEM `validate()` returns either a boolean or an array of error objects
      const valid = (Array.isArray(r) && r.length === 0) || r === true;
      return { valid, raw: r as unknown };
    } catch (e) { return { valid: false, raw: { error: (e as Error).message } }; }
  });
}

/**
 * Result of saving a panel and (optionally) advancing to the next.
 *
 * `inner` shape from MCA's `/bin/commonSaveSubmit`:
 *  - On clean success / partial save: `{ error: "Technical Error Occurred", message: "...Submitted By is a required field..." }`
 *    (counter-intuitively, this IS the success marker for partial saves — see lessons §6.6)
 *  - On true failure: `{ error: "<other>", message: "<details>" }` — no SR ID returned
 *
 * `srId` (if extracted): Siebel SR identifier embedded in the message text — pattern `[Id] = "1-XXXXXXX"`.
 * The same SR is reused on subsequent panel saves; capture it once on panel1.
 */
export interface SaveAndAdvanceResult {
  ok: boolean;
  /** Validation pass before save was attempted */
  preSaveValidation: { valid: boolean; errorCount: number; errors?: unknown };
  /** Network response from /bin/commonSaveSubmit, when captured */
  saveResponse?: { status: number; outer?: { resCode?: number; resStr?: string }; inner?: unknown };
  /** Siebel SR Id, extracted from the response message text */
  srId?: string;
  /** True if we observed the panel transition completing */
  advanced?: boolean;
  /** Diagnostic notes the caller can surface to the user */
  notes: string[];
}

const SR_ID_REGEX = /\[Id\]\s*=\s*"([0-9A-Z\-]+)"/;
const PARTIAL_SAVE_SUCCESS_MARKER = /Submitted By is a required field/i;

/**
 * Saves the current panel, captures the `/bin/commonSaveSubmit` response, and (optionally)
 * advances to the next panel. Use this as the ONLY save path during automated runs — clicking
 * the Save button manually leaves the response uncaptured and makes failures hard to diagnose.
 *
 * Steps:
 *  1. Run `gb.validate()` to surface any client-side errors before the network call.
 *  2. If validation has errors and `opts.requireValid` is true (default), return without saving.
 *  3. Wire a one-shot response listener on the page for `/bin/commonSaveSubmit`.
 *  4. Click the panel's Save button (resolved via `panel.resolveNode().widget.click()`-equivalent
 *     OR the literal AEM button id pattern `<panel-som-dashed>-nextitemnav___widget`).
 *  5. Wait for the response, parse the double-wrapped envelope, extract the SR Id.
 *  6. If `opts.advance` is true, also click the top-level Next button to move to the next panel.
 *
 * MCA-specific: A partial save returns `Submitted By is a required field` — that's the SUCCESS
 * marker for non-final-submit saves; the field is set only at DSC submission time.
 */
export async function saveAndAdvance(
  page: Page,
  panelKey: 'panel1AOC4' | 'panel2AOC4' | 'panel3AOC4' | 'panel4AOC4' | 'panel5AOC4' | 'panel6AOC4' | 'panel7AOC4',
  opts: { requireValid?: boolean; advance?: boolean; timeoutMs?: number } = {},
): Promise<SaveAndAdvanceResult> {
  const requireValid = opts.requireValid ?? true;
  const advance = opts.advance ?? false;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const notes: string[] = [];

  // 1. Pre-save validation
  const validation = await runFormValidation(page);
  const errors = Array.isArray(validation.raw) ? (validation.raw as unknown[]) : [];
  const errorCount = errors.length;
  const preSaveValidation = { valid: validation.valid, errorCount, errors: errorCount > 0 ? errors : undefined };

  if (!validation.valid && requireValid) {
    notes.push(`pre-save validation failed with ${errorCount} error(s); not clicking Save`);
    return { ok: false, preSaveValidation, notes };
  }

  // 2. Set up response capture for the save endpoint
  const respPromise = page
    .waitForResponse((r) => r.url().includes('/bin/commonSaveSubmit'), { timeout: timeoutMs })
    .catch(() => null);

  // 3. Click the panel's Save button. AEM exposes panel Save as a button widget with
  // an id derived from the panel's SOM expression — pattern documented in fillPanel.
  // We try the deterministic id first; fall back to a button-by-name lookup.
  const clickResult = await page.evaluate((pk) => {
    // Search the panel's tree for a button whose semantic name matches "Save" or "aoc4_Save<n>"
    type GuideNode = { name?: string; somExpression?: string; className?: string; items?: GuideNode[]; widget?: { click?: () => void } };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
    const panel = gb.resolveNode(pk) as GuideNode | null;
    if (!panel) return { ok: false, error: `panel ${pk} not resolved` };
    let saveButton: GuideNode | null = null;
    function findSave(n: GuideNode | undefined): void {
      if (!n || saveButton) return;
      const isButton = (n.className ?? '').toLowerCase().includes('button');
      const looksLikeSave = isButton && /save/i.test(n.name ?? '');
      if (looksLikeSave) { saveButton = n; return; }
      if (Array.isArray(n.items)) for (const k of n.items) findSave(k);
    }
    findSave(panel);
    if (!saveButton) return { ok: false, error: 'no Save button found inside panel tree' };
    const btn = saveButton as GuideNode;
    const som = btn.somExpression;
    // Try widget.click() (works in headless) — fall back to dispatch
    try {
      if (btn.widget && typeof btn.widget.click === 'function') {
        btn.widget.click();
        return { ok: true, via: 'widget.click', som };
      }
    } catch { /* fall through */ }
    // DOM-level fallback: AEM widgets follow the id pattern <som-dotted-converted-to-dashes>___widget
    if (som) {
      const id = som.replace(/\[(\d+)\]/g, '_$1').replace(/\./g, '-') + '___widget';
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) { el.click(); return { ok: true, via: 'dom-id', som, id }; }
    }
    return { ok: false, error: 'Save button found but no clickable widget or DOM element' };
  }, panelKey);

  if (!clickResult.ok) {
    notes.push(`save click failed: ${'error' in clickResult ? clickResult.error : 'unknown'}`);
    return { ok: false, preSaveValidation, notes };
  }
  notes.push(`save clicked via ${(clickResult as { via?: string }).via}${(clickResult as { som?: string }).som ? ' (som=' + (clickResult as { som?: string }).som + ')' : ''}`);

  // 4. Wait for /bin/commonSaveSubmit response
  const resp = await respPromise;
  if (!resp) {
    notes.push('no /bin/commonSaveSubmit response captured before timeout — Save click may have been blocked by an alert/modal');
    return { ok: false, preSaveValidation, notes };
  }

  let outer: { resCode?: number; resStr?: string } | undefined;
  let inner: unknown;
  let srId: string | undefined;
  try {
    const text = await resp.text();
    outer = JSON.parse(text) as { resCode?: number; resStr?: string };
    if (typeof outer.resStr === 'string') {
      inner = JSON.parse(outer.resStr) as unknown;
      const innerObj = inner as { message?: string; error?: string };
      if (typeof innerObj?.message === 'string') {
        const m = innerObj.message.match(SR_ID_REGEX);
        if (m) srId = m[1];
      }
    }
  } catch (e) {
    notes.push(`failed to parse save response: ${(e as Error).message}`);
  }

  // 5. Decide success: either no error, or the partial-save success marker
  const innerObj = inner as { message?: string; error?: string } | undefined;
  const innerMsg = innerObj?.message ?? '';
  const innerErr = innerObj?.error ?? '';
  const isPartialSaveSuccess = PARTIAL_SAVE_SUCCESS_MARKER.test(innerMsg);
  const isCleanSuccess = !innerErr && !innerMsg.toLowerCase().includes('error');
  const ok = (resp.status() === 200) && (isCleanSuccess || isPartialSaveSuccess);

  if (isPartialSaveSuccess) notes.push(`partial save success marker present: "${innerMsg.slice(0, 80)}…"`);
  if (srId) notes.push(`SR Id captured: ${srId}`);
  if (!ok && innerMsg) notes.push(`save reported error: ${innerMsg.slice(0, 200)}`);

  // 6. Optionally advance to the next panel by clicking the top-level Next button
  let advanced = false;
  if (ok && advance) {
    const nextRes = await page.evaluate(() => {
      const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
      const root = gb.resolveNode('rootPanel') as { items?: Array<{ name?: string; widget?: { click?: () => void }; somExpression?: string; className?: string }> } | null;
      if (!root) return { ok: false, error: 'rootPanel not resolved' };
      const items = root.items ?? [];
      const nextBtn = items.find((b) => /button/i.test(b.className ?? '') && /^Next$/i.test(b.name ?? ''));
      if (!nextBtn) return { ok: false, error: 'top-level Next button not found' };
      try { nextBtn.widget?.click?.(); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    });
    advanced = nextRes.ok;
    notes.push(advanced ? 'advanced to next panel' : `advance failed: ${(nextRes as { error?: string }).error ?? 'unknown'}`);
    if (advanced) await page.waitForTimeout(800);
  }

  return {
    ok,
    preSaveValidation,
    saveResponse: { status: resp.status(), outer, inner },
    srId,
    advanced,
    notes,
  };
}

/** Returns the SOM expression for a field given its semantic name (first match in tree). */
export async function findSomByName(page: Page, name: string): Promise<string | null> {
  return await page.evaluate((target) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (som: string) => unknown } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as { items?: unknown[] } | null;
    if (!root) return null;
    let found: string | null = null;
    function walk(n: unknown): void {
      if (!n || typeof n !== 'object' || found) return;
      if ((n as { name?: string }).name === target && (n as { somExpression?: string }).somExpression) {
        found = (n as { somExpression: string }).somExpression;
        return;
      }
      const kids = (n as { items?: unknown[] }).items;
      if (Array.isArray(kids)) for (const k of kids) walk(k);
    }
    walk(root);
    return found;
  }, name);
}
