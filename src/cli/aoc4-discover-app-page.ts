/**
 * Discovery CLI: open MCA's application-history dashboard, find a draft AOC-4 entry,
 * navigate to its detail page, and capture the PDF download URL.
 *
 * Per user (May 2026): "After we fill all the AOC-4 form panels, from the dashboard
 * while we click on the application, we get a main page. In that main page, we see
 * the application and we are able to <download> the PDF."
 *
 * Goal: find the exact URL pattern for the PDF on the application detail page.
 *
 * Strategy:
 *   1. DO NOT apply route blockers — the application list rendering JS must run.
 *   2. Load /application-history.html, wait for the table/list to appear (longer timeouts).
 *   3. Find any of our test SRs in the list (1-BNRZ0BL, 1-BNS3XCA, 1-BNS9YYZ, etc.).
 *   4. Click the row / detail link.
 *   5. On the detail page, find any link/button that triggers a PDF download.
 *   6. Capture every network request — grep for application/pdf responses.
 *
 * Usage:  npm run aoc4:discover-app-page
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';

const ARTIFACT_DIR = `./.artifacts/runs/discover-app-page-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

// All SR Ids our automation has created today (any of them should appear in My Application)
const KNOWN_SRS = [
  '1-BNS9YYZ', '1-BNS9Z73', '1-BNS3XCA', '1-BNS3P0Z',
  '1-BNS00PR', '1-BNRYM3S', '1-BNRZ0BL', '1-BNRQLTK',
  '1-BNRPA16', '1-BNROXTB', '1-BNRAQGG',
];

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  // Launch with storage state but NO route blockers
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    storageState: './storage-state.json',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  // Capture every interesting network request
  const network: Array<{ method: string; url: string; status?: number; contentType?: string; bytes?: number; isPDF?: boolean }> = [];
  page.on('request', (req) => network.push({ method: req.method(), url: req.url() }));
  page.on('response', async (resp) => {
    let idx = -1;
    for (let i = network.length - 1; i >= 0; i--) {
      if (network[i].url === resp.url() && network[i].status === undefined) { idx = i; break; }
    }
    if (idx < 0) return;
    network[idx].status = resp.status();
    const ct = resp.headers()['content-type'] ?? '';
    network[idx].contentType = ct;
    if (ct.includes('pdf')) network[idx].isPDF = true;
    try {
      const body = await resp.body();
      network[idx].bytes = body.length;
      // If it's a PDF, save it!
      if (ct.includes('pdf') && body.length > 1000) {
        const filename = `pdf-from-${resp.url().split('/').pop()?.slice(0, 40) || 'unknown'}.pdf`;
        fs.writeFileSync(path.join(ARTIFACT_DIR, filename), body);
        process.stderr.write(`[discover] CAPTURED PDF: ${body.length} bytes from ${resp.url()}\n`);
      }
    } catch { /* not buffered */ }
  });

  // Block ONLY the login-staleness redirector. Let everything else load (especially the
  // application-list JS in clientlib-restri* and devtool*).
  await context.route('**/clientlib-loginfilter*.js*', (r) => r.abort());

  await page.addInitScript('window.__name = function(f){ return f; };');

  try {
    // MCA's anti-direct-URL clientlib bounces /application-history.html → /home.html when
    // accessed without an in-page click. Workaround: load /home.html, then click the
    // "My Application" nav link.
    process.stderr.write('[discover] step 1: navigating to /home.html\n');
    await page.goto('https://www.mca.gov.in/content/mca/global/en/home.html', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    process.stderr.write('[discover] step 2: clicking "My Application" nav link\n');
    const myAppClick = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
      const t = links.find((a) => /^my\s*application/i.test((a.innerText ?? '').trim()) && a.offsetParent !== null);
      if (!t) return { ok: false, error: 'My Application link not found' };
      t.click();
      return { ok: true, href: t.href };
    });
    process.stderr.write(`[discover] My Application click: ${JSON.stringify(myAppClick)}\n`);
    if (!myAppClick.ok) throw new Error('My Application nav link not clickable');

    process.stderr.write('[discover] step 3: waiting 20s for application list to populate\n');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(20_000);

    // Capture the page DOM, looking for any of our SRs
    const dom1 = await page.evaluate((knownSrs: string[]) => {
      const text = document.body.innerText;
      const srnsOnPage = knownSrs.filter((s) => text.includes(s));
      // Also find ALL SRN-like patterns + all clickable elements
      const allSrns = [...text.matchAll(/1-[A-Z0-9]{6,}/g)].map((m) => m[0]);
      const links = Array.from(document.querySelectorAll('a, button, [role="button"], [onclick]'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const e = el as HTMLElement;
          return {
            tag: e.tagName,
            text: (e.innerText ?? '').trim().slice(0, 100),
            href: (e as HTMLAnchorElement).href || undefined,
            onclick: e.getAttribute('onclick')?.slice(0, 200),
            id: e.id?.slice(0, 100),
            className: e.className?.toString?.().slice(0, 100),
          };
        })
        .filter((l) => l.text.length > 0);
      return {
        url: location.href,
        title: document.title,
        srnsOnPage,
        allSrnsCount: [...new Set(allSrns)].length,
        sampleSrns: [...new Set(allSrns)].slice(0, 10),
        linkCount: links.length,
        // Filter to interesting links
        interestingLinks: links.filter((l) => /view|preview|download|pdf|continue|details|complete|form|application|file/i.test(l.text)).slice(0, 30),
        bodyPreview: document.body.innerText.slice(0, 1000),
      };
    }, KNOWN_SRS);
    fs.writeFileSync(path.join(ARTIFACT_DIR, '01-application-history-dom.json'), JSON.stringify(dom1, null, 2));
    process.stderr.write(`[discover] application-history: ${dom1.linkCount} buttons, ${dom1.srnsOnPage.length} of our SRs visible, ${dom1.allSrnsCount} total SRNs\n`);

    if (dom1.allSrnsCount === 0) {
      process.stderr.write('[discover] NO SRNs visible on the page — list may need user interaction (filter, search, login refresh)\n');
      process.stderr.write('[discover] page text preview: ' + dom1.bodyPreview.slice(0, 300) + '\n');
    }

    // If we found a "View" / "Continue" / "Details" link, click the first one
    const target = dom1.interestingLinks.find((l) => /view|details|continue|complete/i.test(l.text)) ?? dom1.interestingLinks[0];
    if (target) {
      process.stderr.write(`[discover] clicking "${target.text.slice(0, 60)}"\n`);
      try {
        const beforeNetCount = network.length;
        await page.evaluate((t: { id?: string; text: string }) => {
          const all = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
          let el: HTMLElement | null = null;
          if (t.id) el = document.getElementById(t.id);
          if (!el) el = all.find((e) => (e.innerText ?? '').trim().slice(0, 100) === t.text) ?? null;
          if (el && el.offsetParent !== null) el.click();
        }, target);
        await page.waitForTimeout(8000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        // Capture state after click
        const dom2 = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          buttonCount: document.querySelectorAll('a, button').length,
          pdfButtons: Array.from(document.querySelectorAll('a, button, [role="button"]'))
            .filter((el) => (el as HTMLElement).offsetParent !== null && /pdf|download|preview|view\s*form/i.test(((el as HTMLElement).innerText ?? '').trim()))
            .map((el) => ({
              tag: el.tagName,
              text: ((el as HTMLElement).innerText ?? '').trim().slice(0, 100),
              href: (el as HTMLAnchorElement).href,
              id: el.id,
            })),
          bodyPreview: document.body.innerText.slice(0, 2000),
        }));
        fs.writeFileSync(path.join(ARTIFACT_DIR, '02-detail-page-dom.json'), JSON.stringify(dom2, null, 2));
        process.stderr.write(`[discover] detail page url=${dom2.url} ${dom2.pdfButtons.length} PDF-like buttons\n`);

        // If a PDF button exists, click it
        if (dom2.pdfButtons.length > 0) {
          process.stderr.write(`[discover] clicking PDF button "${dom2.pdfButtons[0].text}"\n`);
          await page.evaluate((id) => { const el = id ? document.getElementById(id) : null; if (el) (el as HTMLElement).click(); }, dom2.pdfButtons[0].id);
          await page.waitForTimeout(10_000);
        }

        // Capture which network requests happened after the click — these are our candidates
        const newRequests = network.slice(beforeNetCount).filter((r) => !/\.(css|png|jpg|gif|svg|ico|woff|js)\b/.test(r.url));
        fs.writeFileSync(path.join(ARTIFACT_DIR, '03-after-click-network.json'), JSON.stringify(newRequests, null, 2));
        const pdfsCaptured = newRequests.filter((r) => r.isPDF);
        process.stderr.write(`[discover] ${newRequests.length} interesting requests after click; ${pdfsCaptured.length} returned PDFs\n`);
        for (const p of pdfsCaptured) process.stderr.write(`  PDF: ${p.method} ${p.url}\n`);
      } catch (e) {
        process.stderr.write(`[discover] click error: ${(e as Error).message}\n`);
      }
    } else {
      process.stderr.write('[discover] no interesting buttons found on application-history\n');
    }

    fs.writeFileSync(path.join(ARTIFACT_DIR, '99-all-network.json'), JSON.stringify(network.filter((r) => !/\.(css|png|jpg|gif|svg|ico|woff|js)\b/.test(r.url)), null, 2));
    process.stderr.write(`[discover] DONE — see ${ARTIFACT_DIR}\n`);
  } catch (e) {
    process.stderr.write(`[discover] ERROR: ${(e as Error).message}\n${(e as Error).stack}\n`);
  } finally {
    await browser.close();
  }
})();
