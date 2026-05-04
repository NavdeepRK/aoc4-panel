/**
 * Diagnostic CLI: drives panel 1 save against MCA, then captures everything we need
 * to figure out why panels 2-6 don't fire commonSaveSubmit.
 *
 * Captures (after panel 1 save succeeds):
 *   - All visible buttons on the page (text, id, disabled, classes)
 *   - guideBridge.resolveNode('rootPanel') tree shape (panel names + visibility + active state)
 *   - The activePanel marker if AEM exposes one
 *   - jsonModel for the panel2 save button (what its `click` script actually does)
 *   - Network requests since panel 1 save
 *
 * Usage:  npm run aoc4:inspect-panel2 -- <CIN>
 *
 * Requires: storage-state.json (run `npm run login` first)
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';

const CIN = process.argv[2] ?? 'U69100KA2023PTC177694';
const ARTIFACT_DIR = `./.artifacts/runs/inspect-panel2-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function logAndWrite(name: string, data: unknown): void {
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  process.stderr.write(`  → wrote ${file}\n`);
}

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const { browser, page } = await launch();
  const networkLog: Array<{ ts: string; method: string; url: string; status?: number; body?: string }> = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') networkLog.push({ ts: new Date().toISOString(), method: 'POST', url: req.url() });
  });
  page.on('response', async (resp) => {
    if (resp.request().method() !== 'POST') return;
    let idx = -1;
    for (let i = networkLog.length - 1; i >= 0; i--) {
      if (networkLog[i].url === resp.url() && networkLog[i].status === undefined) { idx = i; break; }
    }
    if (idx < 0) return;
    networkLog[idx].status = resp.status();
    try { networkLog[idx].body = (await resp.text()).slice(0, 800); } catch { /* ignore */ }
  });

  try {
    await page.addInitScript('window.__name = function(f){ return f; };');
    process.stderr.write(`[inspect] loading form for ${CIN}\n`);
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    await page.waitForFunction(() => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'), { timeout: 30_000 });

    // Set CIN + prefill
    await page.evaluate((cin) => {
      type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
      const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
      const root = gb.resolveNode('rootPanel') as GuideNode | null;
      const findSom = (name: string): string | null => {
        let found: string | null = null;
        const walk = (n: GuideNode | undefined): void => {
          if (!n || found) return;
          if (n.name === name && n.somExpression) { found = n.somExpression; return; }
          if (Array.isArray(n.items)) for (const k of n.items) walk(k);
        };
        walk(root ?? undefined);
        return found;
      };
      for (const n of ['CIN_Number_Professional_User', 'CIN_Number_Other_User', 'CINofCompany']) {
        const s = findSom(n); if (s) gb.setProperty([s], 'value', [cin]);
      }
      (window as unknown as { prefillWithCin: (s: string) => void }).prefillWithCin(cin);
    }, CIN);
    await page.waitForTimeout(4500);
    process.stderr.write(`[inspect] prefill done\n`);

    // Apply minimal panel 1 fill
    await page.evaluate(() => {
      type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
      const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
      const root = gb.resolveNode('rootPanel') as GuideNode | null;
      const findSom = (name: string): string | null => {
        let f: string | null = null;
        const walk = (n: GuideNode | undefined): void => {
          if (!n || f) return;
          if (n.name === name && n.somExpression) { f = n.somExpression; return; }
          if (Array.isArray(n.items)) for (const k of n.items) walk(k);
        };
        walk(root ?? undefined); return f;
      };
      const set = (n: string, v: string): void => { const s = findSom(n); if (s) gb.setProperty([s], 'value', [v]); };
      set('fromDate', '2024-04-01');
      set('toDate', '2025-03-31');
      set('textbox1643785189026', '2025-09-15');
      set('DateOfBoard', '2025-09-15');
      set('dateOfSigningOfReports', '2025-09-15');
      set('natureS', 'Adopted Financial statements');
      set('wetherProFinancialStatement', '1');
      set('whetherAdoptedAdjAGM', '1');
      set('whetherAnnualGeneralMeeting', '0');
      set('whetherAnyExtension', '1');
      set('ifyesDateOfAGM', '2025-09-30');
      set('dueDateOfAGM', '2025-09-30');
      set('numberOfMembers', '5');

      // Populate signatory tables
      type Inst = Record<string, { somExpression?: string; value?: unknown }>;
      type IM = { _instances: Inst[]; addInstance?: () => void; removeInstance?: (i: number) => void };
      type Table = { Row1?: { _instanceManager: IM } };
      const sv = (som: string, v: string): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* skip */ } };
      const dt1 = gb.resolveNode('dynamicTable1') as Table | null;
      const dt1IM = dt1?.Row1?._instanceManager;
      if (dt1IM) {
        const r0 = dt1IM._instances[0];
        if (r0?.DINorIncome?.somExpression) sv(r0.DINorIncome.somExpression, '11142612');
        if (r0?.table1designation?.somExpression) sv(r0.table1designation.somExpression, 'Director');
        if (r0?.DateOfSigning?.somExpression) sv(r0.DateOfSigning.somExpression, '2025-09-15');
        for (let i = dt1IM._instances.length - 1; i >= 1; i--) try { dt1IM.removeInstance?.(i); } catch { /* */ }
      }
      const t2 = gb.resolveNode('table2') as Table | null;
      const t2IM = t2?.Row1?._instanceManager;
      if (t2IM) {
        const fillT2 = (idx: number, din: string): void => {
          const row = t2IM._instances[idx]; if (!row) return;
          if (row.din?.somExpression) sv(row.din.somExpression, din);
          if (row.designation1?.somExpression) sv(row.designation1.somExpression, 'Director');
          if (row.DateOfSigningOfBoard?.somExpression) sv(row.DateOfSigningOfBoard.somExpression, '2025-09-15');
        };
        fillT2(0, '11142612');
        fillT2(1, '11142613');
        for (let i = t2IM._instances.length - 1; i >= 2; i--) try { t2IM.removeInstance?.(i); } catch { /* */ }
      }
    });

    // Lock validate
    await page.evaluate(() => {
      const gb = (window as unknown as { guideBridge: { validate?: () => boolean } }).guideBridge;
      try { Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false }); }
      catch { gb.validate = () => true; }
    });

    // === SNAPSHOT BEFORE PANEL 1 SAVE ===
    const beforeSave = await captureFormState(page);
    logAndWrite('01-before-panel1-save', beforeSave);
    process.stderr.write(`[inspect] captured before-save state — ${beforeSave.allButtons.length} buttons visible\n`);

    // Click panel 1 Save
    const respPromise = page.waitForResponse(r => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 }).catch(() => null);
    await page.evaluate(() => {
      const id = 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget';
      document.getElementById(id)?.click();
    });
    const resp = await respPromise;
    if (!resp) {
      logAndWrite('02-panel1-save-failed', { reason: 'no commonSaveSubmit XHR fired' });
      process.stderr.write('[inspect] panel 1 save did not fire — check beforeSave artifact\n');
      return;
    }
    const respText = await resp.text();
    logAndWrite('02-panel1-save-response', { status: resp.status(), body: respText });
    process.stderr.write(`[inspect] panel 1 saved\n`);

    // Wait for the form's post-save UI updates to settle
    await page.waitForTimeout(3000);

    // === SNAPSHOT AFTER PANEL 1 SAVE — what changed? ===
    const afterSave = await captureFormState(page);
    logAndWrite('03-after-panel1-save', afterSave);
    process.stderr.write(`[inspect] captured after-save state — ${afterSave.allButtons.length} buttons visible\n`);

    // === DIFF: which buttons changed disabled state? ===
    const buttonDiff: Array<{ id: string; before: { disabled: boolean; visible: boolean }; after: { disabled: boolean; visible: boolean } }> = [];
    const beforeMap = new Map(beforeSave.allButtons.map((b) => [b.id, b]));
    for (const after of afterSave.allButtons) {
      const before = beforeMap.get(after.id);
      if (!before) continue;
      if (before.disabled !== after.disabled || before.visible !== after.visible) {
        buttonDiff.push({ id: after.id, before: { disabled: before.disabled, visible: before.visible }, after: { disabled: after.disabled, visible: after.visible } });
      }
    }
    logAndWrite('04-button-state-diff', buttonDiff);
    process.stderr.write(`[inspect] ${buttonDiff.length} buttons changed state after panel 1 save\n`);

    // === Try clicking panel 2 Save NOW with the same validate-locked state ===
    process.stderr.write('[inspect] attempting panel 2 Save click\n');
    const p2Resp = page.waitForResponse(r => r.url().includes('/bin/commonSaveSubmit'), { timeout: 15_000 }).catch(() => null);
    const p2ClickResult = await page.evaluate(() => {
      const id = 'guideContainer-rootPanel-panel-panel-panel2AOC4-panel_copy_1258675259-nextitemnav___widget';
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (!el) return { ok: false, reason: 'button not in DOM' };
      const disabled = el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      const rect = el.getBoundingClientRect();
      el.click();
      return { ok: true, disabled, rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y } };
    });
    logAndWrite('05-panel2-click-attempt', p2ClickResult);
    const p2R = await p2Resp;
    if (p2R) {
      logAndWrite('06-panel2-save-response', { status: p2R.status(), body: (await p2R.text()).slice(0, 1000) });
      process.stderr.write('[inspect] PANEL 2 SAVED! checking what worked\n');
    } else {
      process.stderr.write('[inspect] panel 2 save did not fire — capturing post-attempt state\n');
      const postAttempt = await captureFormState(page);
      logAndWrite('06-after-panel2-attempt', postAttempt);
    }

    // === Capture full network log ===
    logAndWrite('99-network-log', networkLog);
    process.stderr.write(`[inspect] DONE — artifacts in ${ARTIFACT_DIR}\n`);
  } catch (e) {
    process.stderr.write(`[inspect] ERROR: ${(e as Error).message}\n${(e as Error).stack}\n`);
  } finally {
    await teardown(browser);
  }
})();

async function captureFormState(page: import('playwright').Page): Promise<{
  url: string;
  unboundFlags: Record<string, unknown>;
  draftID: unknown;
  allButtons: Array<{ id: string; text: string; ariaLabel: string; disabled: boolean; visible: boolean; classes: string }>;
  topLevelButtons: Array<{ name: string; somExpression: string; visible: unknown; enabled: unknown }>;
  panelTree: unknown;
  activePanel: unknown;
}> {
  return await page.evaluate(() => {
    type GuideNode = { name?: string; somExpression?: string; className?: string; visible?: unknown; enabled?: unknown; items?: GuideNode[]; activeChild?: unknown; jsonModel?: unknown };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; getDataXML?: (o: { success: (r: unknown) => void; error: (e: unknown) => void }) => void; customContextProperty?: (k: string) => unknown } }).guideBridge;

    // Unbound flags + draftID
    let unbound: Record<string, unknown> = {};
    try {
      const raw = (gb as unknown as { _guide?: { _data?: () => string }; getDataXML?: (o: { success: (r: unknown) => void; error: (e: unknown) => void }) => void });
      // Synchronous getDataXML if available
      let parsed: { afData?: { afUnboundData?: { data?: Record<string, unknown> } } } = {};
      if (typeof raw.getDataXML === 'function') {
        // Skip sync attempt; would be async-only. Read live properties via _guide instead.
      }
      const guide = (gb as unknown as { _guide?: { _data?: { _guideObject?: unknown } } })._guide;
      if (guide?._data) {
        // Best-effort introspection
        unbound = (guide._data as unknown as { _guideObject?: { afData?: { afUnboundData?: { data?: Record<string, unknown> } } } })._guideObject?.afData?.afUnboundData?.data ?? {};
      }
      void parsed;
    } catch { /* ignore */ }

    const draftID = gb.customContextProperty?.('draftID') ?? null;

    // Visible buttons in DOM
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => {
        const e = el as HTMLElement;
        return {
          id: e.id ?? '',
          text: (e.innerText ?? '').trim().slice(0, 60),
          ariaLabel: e.getAttribute('aria-label') ?? '',
          disabled: (e as HTMLButtonElement).disabled || e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true',
          visible: e.offsetParent !== null,
          classes: (e.className ?? '').slice(0, 100),
        };
      })
      .filter((b) => b.id && b.visible);

    // Top-level buttons (children of rootPanel)
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const topLevelButtons: Array<{ name: string; somExpression: string; visible: unknown; enabled: unknown }> = [];
    if (root?.items) {
      for (const it of root.items) {
        const cls = it.className ?? '';
        if (typeof cls === 'string' && /button/i.test(cls) && it.somExpression) {
          topLevelButtons.push({ name: it.name ?? '', somExpression: it.somExpression, visible: it.visible, enabled: it.enabled });
        }
      }
    }

    // Panel tree (just names + visibility + activeChild flag for top panels)
    const panelTree: Array<{ name: string; som: string; visible: unknown; activeChild: unknown }> = [];
    const dive = (n: GuideNode | undefined, depth: number): void => {
      if (!n || depth > 4) return;
      const cls = n.className ?? '';
      if (typeof cls === 'string' && /panel/i.test(cls) && n.somExpression && n.name) {
        panelTree.push({ name: n.name, som: n.somExpression.slice(-80), visible: n.visible, activeChild: n.activeChild });
      }
      if (Array.isArray(n.items)) for (const k of n.items) dive(k, depth + 1);
    };
    dive(root ?? undefined, 0);

    // Active panel — AEM forms expose this on guideContext
    let activePanel: unknown = null;
    try {
      const ctx = (window as unknown as { guidelib?: { runtime?: { guideContext?: { activePanel?: unknown; currentPanelInstance?: unknown } } } }).guidelib;
      activePanel = {
        guideContextActivePanel: ctx?.runtime?.guideContext?.activePanel,
        currentPanelInstance: ctx?.runtime?.guideContext?.currentPanelInstance,
      };
    } catch { /* skip */ }

    return { url: location.href, unboundFlags: unbound, draftID, allButtons, topLevelButtons, panelTree, activePanel };
  });
}
