/**
 * Post-save PDF discovery — drives a full filing run, then navigates from the post-save
 * form state to the My Application page via in-page click (avoiding MCA's anti-direct-URL
 * bounce), finds our newly-created draft, clicks View, and captures the PDF URL.
 *
 * Why this works when `aoc4-discover-app-page` doesn't:
 *
 *   - `/application-history.html` accessed cold is bounced to `/home.html` by the
 *     `clientlib-restrinewtab*` redirector. Our route blockers prevent that script from
 *     loading — but then the application list's JS doesn't populate either.
 *
 *   - After a successful AOC-4 save, the worker's browser is sitting on the form page
 *     with a logged-in session. Clicking the "My Application" nav link from THERE is an
 *     in-page navigation, not a direct URL hit — the redirector doesn't fire because the
 *     navigation was triggered by a user-style click event.
 *
 * Strategy:
 *
 *   1. Run the worker's normal hybrid save flow (creates a draft, captures srId + ref)
 *   2. From the same browser, click the nav-bar "My Application" link
 *   3. Wait for the application list to render (give it 30s — slow JS table)
 *   4. Find a row whose SRN matches our draft's referenceNumber or srId
 *   5. Click whatever "View"/"Open"/"Continue Filing" action exists on that row
 *   6. Set up a network capture filter for `application/pdf` responses
 *   7. Whatever URL returns the PDF — that's the answer
 *
 * Usage: npm run aoc4:pdf-discover-postsave
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';

const ARTIFACT_DIR = `./.artifacts/runs/pdf-discover-postsave-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const SR_ID_REGEX = /\[Id\]\s*=\s*"([0-9A-Z\-]+)"/;

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

  const { browser, page } = await launch();

  // Capture every interesting network request from the moment we start
  const network: Array<{ ts: string; method: string; url: string; status?: number; contentType?: string; bytes?: number; isPDF?: boolean }> = [];
  page.on('request', (req) => {
    if (/\.(css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)/.test(req.url())) return;
    network.push({ ts: new Date().toISOString(), method: req.method(), url: req.url() });
  });
  page.on('response', async (resp) => {
    if (/\.(css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)/.test(resp.url())) return;
    let idx = -1;
    for (let i = network.length - 1; i >= 0; i--) {
      if (network[i].url === resp.url() && network[i].status === undefined) { idx = i; break; }
    }
    if (idx < 0) return;
    network[idx].status = resp.status();
    const ct = resp.headers()['content-type'] ?? '';
    network[idx].contentType = ct;
    if (ct.includes('pdf')) {
      network[idx].isPDF = true;
      try {
        const body = await resp.body();
        network[idx].bytes = body.length;
        if (body.length > 1000) {
          const fname = path.join(ARTIFACT_DIR, `captured-pdf-${Date.now()}.pdf`);
          fs.writeFileSync(fname, body);
          process.stderr.write(`\n  ✓ CAPTURED PDF (${body.length} bytes): ${resp.url()}\n  → ${fname}\n\n`);
        }
      } catch { /* */ }
    }
  });

  try {
    process.stderr.write('[discover] step 1: launching form, hybrid save flow\n');
    await page.addInitScript('window.__name = function(f){ return f; };');
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    await page.waitForFunction(
      () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'),
      { timeout: 30_000 },
    );

    // Pre-prime draftID
    await page.evaluate(async () => {
      type GBExt = { customContextProperty?: (k: string, v?: unknown) => unknown };
      const gb = (window as unknown as { guideBridge: GBExt }).guideBridge;
      if (gb.customContextProperty?.('draftID')) return;
      try {
        const r = await fetch('/content/forms/portal/draftandsubmission.fp.draft.json?func=getUid', { credentials: 'include' });
        if (!r.ok) return;
        const j = await r.json() as { id?: string };
        if (j.id) gb.customContextProperty?.('draftID', j.id + '_af');
      } catch { /* */ }
    });

    // Set CIN + prefill
    await page.evaluate((c: string) => {
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
        walk(root ?? undefined);
        return f;
      };
      for (const fn of ['CIN_Number_Professional_User', 'CIN_Number_Other_User', 'CINofCompany']) {
        const s = findSom(fn);
        if (s) gb.setProperty([s], 'value', [c]);
      }
      (window as unknown as { prefillWithCin: (s: string) => void }).prefillWithCin(c);
    }, cin);
    await page.waitForTimeout(4500);

    // Apply panel 1 + signatory tables (small-Pvt preset, abbreviated inline)
    await page.evaluate((args: { fyFrom: string; fyTo: string; bdate: string; agm: string; agmDue: string }) => {
      type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
      type Inst = Record<string, { somExpression?: string; value?: unknown }>;
      type IM = { _instances: Inst[]; addInstance?: () => void; removeInstance?: (i: number) => void };
      type Table = { Row1?: { _instanceManager: IM } };
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
      set('fromDate', args.fyFrom);
      set('toDate', args.fyTo);
      set('textbox1643785189026', args.bdate);
      set('DateOfBoard', args.bdate);
      set('dateOfSigningOfReports', args.bdate);
      set('natureS', 'Adopted Financial statements');
      set('wetherProFinancialStatement', '1');
      set('whetherAdoptedAdjAGM', '1');
      set('whetherAnnualGeneralMeeting', '0');
      set('whetherAnyExtension', '1');
      set('ifyesDateOfAGM', args.agm);
      set('dueDateOfAGM', args.agmDue);
      set('numberOfMembers', '5');

      const sv = (som: string, v: string): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* */ } };
      const dt1 = gb.resolveNode('dynamicTable1') as Table | null;
      const dt1IM = dt1?.Row1?._instanceManager;
      if (dt1IM) {
        const r0 = dt1IM._instances[0];
        if (r0?.DINorIncome?.somExpression) sv(r0.DINorIncome.somExpression, '11142612');
        if (r0?.table1designation?.somExpression) sv(r0.table1designation.somExpression, 'Director');
        if (r0?.DateOfSigning?.somExpression) sv(r0.DateOfSigning.somExpression, args.bdate);
        for (let i = dt1IM._instances.length - 1; i >= 1; i--) try { dt1IM.removeInstance?.(i); } catch { /* */ }
      }
      const t2 = gb.resolveNode('table2') as Table | null;
      const t2IM = t2?.Row1?._instanceManager;
      if (t2IM) {
        const fillT2 = (idx: number, din: string): void => {
          const row = t2IM._instances[idx]; if (!row) return;
          if (row.din?.somExpression) sv(row.din.somExpression, din);
          if (row.designation1?.somExpression) sv(row.designation1.somExpression, 'Director');
          if (row.DateOfSigningOfBoard?.somExpression) sv(row.DateOfSigningOfBoard.somExpression, args.bdate);
        };
        fillT2(0, '11142612');
        fillT2(1, '11142613');
        for (let i = t2IM._instances.length - 1; i >= 2; i--) try { t2IM.removeInstance?.(i); } catch { /* */ }
      }
    }, { fyFrom: fyStart, fyTo: iso(fyEnd), bdate: '2025-09-15', agm: '2025-09-30', agmDue: '2025-09-30' });

    // Bypass validate
    await page.evaluate(() => {
      type GBOverride = { validate?: () => boolean };
      const gb = (window as unknown as { guideBridge: GBOverride }).guideBridge;
      try { Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false }); }
      catch { gb.validate = () => true; }
    });

    // Click panel 1 Save
    process.stderr.write('[discover] step 2: clicking panel 1 Save\n');
    const siebelPromise = page.waitForResponse((r) => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 }).catch(() => null);
    await page.evaluate(() => {
      const id = 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget';
      document.getElementById(id)?.click();
    });
    const siebelResp = await siebelPromise;
    if (!siebelResp) {
      process.stderr.write('[discover] save did not fire\n');
      return;
    }

    // Parse SR id from response
    let srId: string | undefined;
    let referenceNumber: string | undefined;
    try {
      const text = await siebelResp.text();
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'siebel-response.json'), text);
      const outer = JSON.parse(text) as { resStr?: string };
      if (typeof outer.resStr === 'string') {
        const inner = JSON.parse(outer.resStr) as { message?: string; data?: { integrationId?: string; referenceNumber?: string } };
        const m = (inner.message ?? '').match(SR_ID_REGEX);
        if (m) srId = m[1];
        if (inner.data?.integrationId) srId = inner.data.integrationId;
        if (inner.data?.referenceNumber) referenceNumber = inner.data.referenceNumber;
      }
    } catch { /* */ }
    process.stderr.write(`[discover] saved srId=${srId ?? '-'} ref=${referenceNumber ?? '-'}\n`);

    if (!srId) {
      process.stderr.write('[discover] no SR id captured — abort\n');
      return;
    }

    // Wait for any post-save modal to render, then dismiss any visible OK
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button[id*="modal_container"][id$="nextitemnav_copy___widget"]'));
      const visible = buttons.filter((el) => el.offsetParent !== null);
      if (visible.length > 0) visible[0].click();
    });
    await page.waitForTimeout(1500);

    // Step 3: in-page navigate to My Application via the nav link
    process.stderr.write('[discover] step 3: in-page nav to "My Application"\n');
    const navResult = await page.evaluate(() => {
      // Find the nav link, NOT a direct goto. The link has href to /application-history.html
      const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
      const t = links.find((a) => /^my\s*application/i.test((a.innerText ?? '').trim()) && a.offsetParent !== null);
      if (!t) return { ok: false, reason: 'My Application link not found' };
      t.click();
      return { ok: true, href: t.href };
    });
    process.stderr.write(`[discover] nav click: ${JSON.stringify(navResult)}\n`);
    if (!navResult.ok) return;

    // Wait for the application list to populate (slow JS table)
    process.stderr.write('[discover] step 4: waiting 25s for application list to render\n');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(25_000);

    const dom = await page.evaluate((targetSrIds: string[]) => {
      const text = document.body.innerText;
      const allSrns = [...text.matchAll(/1-[A-Z0-9]{6,}/g)].map((m) => m[0]);
      const ourMatches = targetSrIds.filter((sid) => text.includes(sid));
      // Find rows with our SR ids
      const rows = Array.from(document.querySelectorAll('tr, [role="row"], div[class*="row"]')) as HTMLElement[];
      const matchingRows = rows.filter((r) => targetSrIds.some((sid) => (r.innerText ?? '').includes(sid))).map((r) => ({
        text: r.innerText.slice(0, 200),
        buttons: Array.from(r.querySelectorAll('a, button, [role="button"], [onclick]')).map((b) => ({
          text: ((b as HTMLElement).innerText ?? '').trim().slice(0, 60),
          href: (b as HTMLAnchorElement).href || undefined,
          onclick: (b as HTMLElement).getAttribute('onclick') ?? undefined,
          id: (b as HTMLElement).id ?? undefined,
        })).filter((b) => b.text.length > 0),
      }));
      return {
        url: location.href,
        title: document.title,
        ourMatches,
        allSrnsCount: [...new Set(allSrns)].length,
        sampleSrns: [...new Set(allSrns)].slice(0, 10),
        matchingRowsCount: matchingRows.length,
        matchingRows,
      };
    }, [srId, referenceNumber].filter(Boolean) as string[]);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'app-history-dom.json'), JSON.stringify(dom, null, 2));
    process.stderr.write(`[discover] page=${dom.url} matchingRows=${dom.matchingRowsCount} totalSRNs=${dom.allSrnsCount} (sample=${dom.sampleSrns.join(',')})\n`);

    if (dom.matchingRows.length === 0) {
      process.stderr.write('[discover] our SR not visible in My Application list — may be in a different tab (Pending for Action vs Under Processing)\n');
      // Save the full DOM for inspection
      const fullDom = await page.evaluate(() => document.body.innerHTML.slice(0, 50_000));
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'app-history-html.html'), fullDom);
      return;
    }

    // Step 5: click View/Open/Continue Filing on the first matching row
    const targetRow = dom.matchingRows[0];
    const target = targetRow.buttons.find((b) => /view|continue|open|details|pdf|download/i.test(b.text));
    if (!target) {
      process.stderr.write(`[discover] matching row found but no actionable button (buttons: ${targetRow.buttons.map((b) => b.text).join(', ')})\n`);
      return;
    }

    process.stderr.write(`[discover] step 5: clicking "${target.text}"\n`);
    const beforeNetCount = network.length;
    await page.evaluate((t: { id?: string; text: string }) => {
      const all = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
      let el: HTMLElement | null = null;
      if (t.id) el = document.getElementById(t.id);
      if (!el) el = all.find((e) => (e.innerText ?? '').trim().slice(0, 60) === t.text) ?? null;
      if (el && el.offsetParent !== null) el.click();
    }, target);
    await page.waitForTimeout(15_000);

    // Capture all post-click XHRs + final page state
    const afterClick = network.slice(beforeNetCount);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'after-click-network.json'), JSON.stringify(afterClick, null, 2));
    const pdfs = afterClick.filter((r) => r.isPDF || r.contentType?.includes('pdf'));
    process.stderr.write(`[discover] step 6: ${afterClick.length} new XHRs, ${pdfs.length} returned PDFs\n`);
    for (const p of pdfs) process.stderr.write(`    ${p.method} ${p.status} ${p.url}\n`);

    fs.writeFileSync(path.join(ARTIFACT_DIR, 'all-network.json'), JSON.stringify(network, null, 2));
    process.stderr.write(`[discover] DONE — see ${ARTIFACT_DIR}\n`);
  } catch (e) {
    process.stderr.write(`[discover] ERROR: ${(e as Error).message}\n${(e as Error).stack}\n`);
  } finally {
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'all-network.json'), JSON.stringify(network, null, 2));
    await teardown(browser);
  }
})();
