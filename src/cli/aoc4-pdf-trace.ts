/**
 * Human-in-the-loop diagnostic: open a Playwright browser at MCA's home page, log every
 * network request, and wait for the user to manually:
 *   1. Click "My Application"
 *   2. Find one of our draft AOC-4 SRNs (1-BNS9YYZ, 1-BNS9Z73, 1-BNS3XCA, etc.)
 *   3. Click View / Open / Continue / Download PDF on that row
 *   4. Press ENTER in this terminal
 *
 * The CLI captures every network request during the interaction and dumps any that
 * returned application/pdf — those are our PDF endpoints.
 *
 * Usage:  npm run aoc4:pdf-trace
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { chromium } from 'playwright';

const ARTIFACT_DIR = `./.artifacts/runs/pdf-trace-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    storageState: './storage-state.json',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  const network: Array<{ method: string; url: string; status?: number; contentType?: string; bytes?: number; isPDF?: boolean; fromUrl?: string }> = [];

  page.on('request', (req) => {
    network.push({
      method: req.method(),
      url: req.url(),
      fromUrl: req.frame().url().slice(0, 100),
    });
  });
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
      if (ct.includes('pdf') && body.length > 1000) {
        const stamp = Date.now();
        const filename = `pdf-${stamp}.pdf`;
        fs.writeFileSync(path.join(ARTIFACT_DIR, filename), body);
        process.stderr.write(`\n  ┃ 📄 CAPTURED PDF: ${body.length} bytes\n`);
        process.stderr.write(`  ┃    URL: ${resp.url()}\n`);
        process.stderr.write(`  ┃    Method: ${network[idx].method}\n`);
        process.stderr.write(`  ┃    File: ${path.join(ARTIFACT_DIR, filename)}\n\n`);
      }
    } catch { /* not buffered */ }
  });

  // Block the loginfilter redirect so manual navigation isn't bounced
  await context.route('**/clientlib-loginfilter*.js*', (r) => r.abort());
  await context.route('**/clientlib-devtool*.js*', (r) => r.abort());
  await page.addInitScript('window.__name = function(f){ return f; };');

  // Optional argv[2]: a specific URL to load (e.g., a resumeUrl). Default = home page.
  const startUrl = process.argv[2] || 'https://www.mca.gov.in/content/mca/global/en/home.html';
  process.stderr.write(`\n┃ Opening ${startUrl} in a Chrome window…\n`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Bring the Chromium window to the front of the screen
  try {
    await page.bringToFront();
  } catch { /* may not be supported on all platforms */ }

  process.stderr.write('\n');
  process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stderr.write('  📋 IN THE BROWSER WINDOW:\n');
  process.stderr.write('     1. Click "My Application" in the top nav\n');
  process.stderr.write('     2. Find one of our SR drafts in the list:\n');
  process.stderr.write('        1-BNS9YYZ, 1-BNS9Z73, 1-BNS3XCA, 1-BNS00PR, 1-BNRYM3S\n');
  process.stderr.write('     3. Click View / Open / Continue Filing / Download PDF\n');
  process.stderr.write('     4. Once you SEE the PDF render, press ENTER here.\n');
  process.stderr.write('\n');
  process.stderr.write('  Watching network for PDF responses live (will print as they arrive)…\n');
  process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Wait for user to press Enter (or send any line via stdin)
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  // Capture final state + filter to interesting requests
  const allInteresting = network.filter((r) => !/\.(css|png|jpg|gif|svg|ico|woff)\b/.test(r.url));
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'all-network.json'), JSON.stringify(allInteresting, null, 2));

  // Specifically pull anything that returned a PDF, plus anything that looks like a draft/preview/viewer URL
  const pdfs = network.filter((r) => r.isPDF || r.contentType?.includes('pdf'));
  const drafts = network.filter((r) => /draft|preview|getPdf|viewForm|application|download|render/i.test(r.url));
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'pdf-and-draft-urls.json'), JSON.stringify({ pdfs, drafts: drafts.slice(0, 50) }, null, 2));

  process.stderr.write('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stderr.write(`  Total requests captured: ${network.length}\n`);
  process.stderr.write(`  PDF-content-type responses: ${pdfs.length}\n`);
  for (const p of pdfs) process.stderr.write(`    ${p.method} ${p.status} ${p.url}\n`);
  process.stderr.write(`\n  Draft/preview-URL candidates: ${drafts.length}\n`);
  for (const d of drafts.slice(0, 20)) process.stderr.write(`    ${d.method} ${d.status} ${d.url}\n`);
  process.stderr.write(`\n  Artifacts: ${ARTIFACT_DIR}\n`);
  process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await browser.close();
})();
