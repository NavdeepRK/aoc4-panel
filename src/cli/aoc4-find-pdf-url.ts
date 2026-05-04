/**
 * Diagnostic CLI: load MCA's "My Application" / application-history page, find any draft
 * AOC-4 entries we created earlier today, and capture the URLs of the View/Preview/PDF links.
 *
 * Goal: identify the exact endpoint pattern MCA uses to render the draft form as PDF, so
 * the worker can download it after panel save.
 *
 * Usage:  npm run aoc4:find-pdf-url
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';

const ARTIFACT_DIR = `./.artifacts/runs/find-pdf-url-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const { browser, page } = await launch();

  // Capture every network request — we'll grep for PDF traffic later
  const network: Array<{ method: string; url: string; status?: number; contentType?: string; bytes?: number }> = [];
  page.on('request', (req) => network.push({ method: req.method(), url: req.url() }));
  page.on('response', async (resp) => {
    let idx = -1;
    for (let i = network.length - 1; i >= 0; i--) {
      if (network[i].url === resp.url() && network[i].status === undefined) { idx = i; break; }
    }
    if (idx < 0) return;
    network[idx].status = resp.status();
    network[idx].contentType = resp.headers()['content-type'];
    try {
      const body = await resp.body();
      network[idx].bytes = body.length;
    } catch { /* not buffered */ }
  });

  try {
    await page.addInitScript('window.__name = function(f){ return f; };');
    process.stderr.write(`[find-pdf-url] navigating to /application-history.html\n`);
    await page.goto('https://www.mca.gov.in/content/mca/global/en/application-history.html', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Capture the page's DOM — links + buttons that say View/Preview/Download/PDF
    const findings = await page.evaluate(() => {
      const links: Array<{ tag: string; text: string; href?: string; onclick?: string; id?: string; classes?: string }> = [];
      const all = document.querySelectorAll('a, button, [role="button"]');
      all.forEach((el) => {
        const e = el as HTMLElement;
        if (e.offsetParent === null) return;
        const text = (e.innerText ?? '').trim();
        if (!text) return;
        if (!/view|preview|download|pdf|form|draft|continue/i.test(text)) return;
        const href = (e as HTMLAnchorElement).href;
        const onclick = (e as HTMLElement).getAttribute('onclick');
        links.push({
          tag: e.tagName,
          text: text.slice(0, 80),
          href: href || undefined,
          onclick: onclick?.slice(0, 200) || undefined,
          id: e.id?.slice(0, 100) || undefined,
          classes: e.className?.slice(0, 100) || undefined,
        });
      });
      // Also find all SRN-like text on the page (1-BN... pattern) so we can correlate to our test SRs
      const text = document.body.innerText;
      const srns = [...text.matchAll(/1-BN[A-Z0-9]{4,}/g)].map((m) => m[0]);
      return { links, srns: [...new Set(srns)].slice(0, 20), title: document.title, url: location.href };
    });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'application-history-dom.json'), JSON.stringify(findings, null, 2));
    process.stderr.write(`[find-pdf-url] found ${findings.links.length} candidate links, ${findings.srns.length} SRNs visible\n`);

    // If we see a "Continue" or "View" link/button, click it and capture the URL
    if (findings.links.length > 0) {
      // Pick the first one that looks like a draft view action
      const target = findings.links.find((l) => /continue|view\s*(draft|form|application)/i.test(l.text)) ?? findings.links[0];
      process.stderr.write(`[find-pdf-url] clicking link "${target.text.slice(0, 40)}"\n`);
      // Cap network log size before click
      const before = network.length;
      try {
        await page.evaluate((t) => {
          // Find the matching element again in the page (id-based if possible)
          const all = Array.from(document.querySelectorAll('a, button')) as HTMLElement[];
          const el = t.id ? document.getElementById(t.id) : all.find((e) => (e.innerText ?? '').trim() === t.text);
          if (el && el.offsetParent !== null) el.click();
        }, target);
        await page.waitForTimeout(8000);
      } catch (e) { process.stderr.write(`[find-pdf-url] click error: ${(e as Error).message}\n`); }

      const afterClick = network.slice(before);
      // Filter to interesting requests (skip static)
      const interesting = afterClick.filter((r) => {
        if (/\.(css|js|png|jpg|gif|svg|ico|woff)/.test(r.url)) return false;
        return true;
      });
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'click-result-network.json'), JSON.stringify(interesting, null, 2));

      // Capture the page's new DOM state
      const afterClickDom = await page.evaluate(() => ({ url: location.href, title: document.title, bodyPreview: document.body.innerText.slice(0, 500) }));
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'click-result-page.json'), JSON.stringify(afterClickDom, null, 2));
      process.stderr.write(`[find-pdf-url] after click: ${interesting.length} new XHRs, page URL ${afterClickDom.url}\n`);
    }

    // Always dump the full network log so we can grep for any PDF/preview URLs
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'all-network.json'), JSON.stringify(network.filter((r) => !/\.(css|png|jpg|gif|svg|ico|woff|js)\b/.test(r.url)), null, 2));
    process.stderr.write(`[find-pdf-url] DONE — see ${ARTIFACT_DIR}\n`);
  } catch (e) {
    process.stderr.write(`[find-pdf-url] ERROR: ${(e as Error).message}\n`);
  } finally {
    await teardown(browser);
  }
})();
