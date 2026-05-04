/**
 * MCA Companies-by-DIN Reverse Lookup CLI
 *
 * Resolves a DIN to its list of associated companies (CINs the director is signatory on).
 *
 * Status: EXPERIMENTAL — the exact `endpointID` for this lookup is not yet confirmed on MCA's
 * V3 portal. Run with `--probe` first to discover the working endpointID, then pin it via
 * `--endpoint <id>` for production use.
 *
 * Usage:
 *   npm run dir:companies -- 11142612
 *   npm run dir:companies -- --probe 11142612                # try all candidate endpointIDs
 *   npm run dir:companies -- --endpoint dir3kycgetdincomp 11142612
 *   npm run dir:companies -- --json --probe 11142612
 *   npm run dir:companies -- --capture --probe 11142612      # also save raw XHR network log
 *
 * Auth: requires a logged-in MCA session (storage-state.json). Run `npm run login` first.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';
import {
  callCommongetapi,
  probeCompaniesByDIN,
  CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS,
  type CompaniesByDINResponse,
} from '../aoc4/prefill-client.js';

interface CliFlags {
  json: boolean;
  probe: boolean;
  capture: boolean;
  endpointID?: string;
  outFile?: string;
  din?: string;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { json: false, probe: false, capture: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--probe') flags.probe = true;
    else if (a === '--capture') flags.capture = true;
    else if (a === '--endpoint') flags.endpointID = argv[++i];
    else if (a === '--out') flags.outFile = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else if (!flags.din) flags.din = a;
    else { console.error(`Multiple DINs provided. Pass exactly one.`); process.exit(2); }
  }
  return flags;
}

function printHelp(): void {
  console.log(`MCA Companies-by-DIN Lookup (experimental)

Usage:
  npm run dir:companies -- <DIN>                          # try the pinned endpointID
  npm run dir:companies -- --probe <DIN>                  # probe all candidate endpointIDs
  npm run dir:companies -- --endpoint <id> <DIN>          # use a specific endpointID
  npm run dir:companies -- --json [--probe] <DIN>         # JSON output
  npm run dir:companies -- --capture --probe <DIN>        # also save raw XHRs to artifact

Candidate endpointIDs probed by --probe:
${CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS.map((e) => '  - ' + e).join('\n')}

Once a candidate is confirmed, pin it in src/aoc4/prefill-client.ts → lookupCompaniesByDIN.
`);
}

interface XhrCapture {
  url: string;
  method: string;
  status: number;
  requestBody?: string | null;
  responseBody: string;
  timestamp: string;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (!flags.din) {
    console.error('No DIN provided. Use --help for usage.');
    process.exit(2);
  }
  if (!/^\d{8}$/.test(flags.din)) {
    console.error(`Invalid DIN format: "${flags.din}" (expected 8 digits)`);
    process.exit(2);
  }
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = `./.artifacts/runs/companies-by-din-${stamp}`;
  if (flags.capture) fs.mkdirSync(artifactDir, { recursive: true });

  const { browser, page } = await launch();

  // Optionally capture every XHR while we run — useful when probing a new endpointID
  const xhrLog: XhrCapture[] = [];
  if (flags.capture) {
    page.on('response', async (resp) => {
      const url = resp.url();
      if (!/\/bin\/commongetapi|\/bin\/mca\//.test(url)) return;
      try {
        xhrLog.push({
          url,
          method: resp.request().method(),
          status: resp.status(),
          requestBody: resp.request().postData(),
          responseBody: await resp.text(),
          timestamp: new Date().toISOString(),
        });
      } catch { /* response already consumed */ }
    });
  }

  try {
    process.stderr.write(`[dir:companies] loading AOC-4 form to bootstrap encrypt() + CSRF...\n`);
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    await page.waitForFunction(
      () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'),
      { timeout: 30_000 },
    );

    if (flags.probe) {
      process.stderr.write(`[dir:companies] probing ${CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS.length} candidate endpointIDs for DIN ${flags.din}...\n`);
      const result = await probeCompaniesByDIN(page, flags.din);
      const out = flags.json
        ? JSON.stringify(result, null, 2)
        : formatProbeResult(result, flags.din);
      writeOut(out, flags.outFile);
      if (!result.winningEndpointID) {
        process.stderr.write(`[dir:companies] no winning endpointID. Try DINPAN payload or new candidates.\n`);
      }
    } else {
      const eid = flags.endpointID ?? CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS[0];
      process.stderr.write(`[dir:companies] calling endpointID="${eid}" with DIN=${flags.din}\n`);
      const r = await callCommongetapi(page, eid, { DIN: flags.din });
      const out = flags.json
        ? JSON.stringify({ endpointID: eid, response: r }, null, 2)
        : formatSingleCall(eid, r, flags.din);
      writeOut(out, flags.outFile);
    }
  } catch (e) {
    console.error('[dir:companies] error:', e);
    process.exitCode = 1;
  } finally {
    if (flags.capture) {
      fs.writeFileSync(path.join(artifactDir, 'xhr-log.json'), JSON.stringify(xhrLog, null, 2));
      process.stderr.write(`[dir:companies] captured ${xhrLog.length} XHRs → ${artifactDir}/xhr-log.json\n`);
    }
    await teardown(browser);
  }
}

function formatProbeResult(
  result: Awaited<ReturnType<typeof probeCompaniesByDIN>>,
  din: string,
): string {
  const lines: string[] = [];
  lines.push(`Companies-by-DIN probe — DIN ${din}\n`);
  lines.push(`${'endpointID'.padEnd(36)}  ok      sample`);
  lines.push('-'.repeat(80));
  for (const a of result.attempts) {
    const status = a.ok ? 'YES' : 'no';
    const detail = a.error ? `(${a.error.slice(0, 30)})` : (a.sample ? JSON.stringify(a.sample).slice(0, 30) : '');
    lines.push(`${a.endpointID.padEnd(36)}  ${status.padEnd(6)}  ${detail}`);
  }
  lines.push('');
  if (result.winningEndpointID) {
    lines.push(`✅ Winner: ${result.winningEndpointID}`);
    const data = (result.winningResponse?.data ?? []) as Array<Record<string, unknown>>;
    lines.push(`   Returned ${data.length} compan${data.length === 1 ? 'y' : 'ies'}:`);
    for (const c of data.slice(0, 50)) {
      const cin = c.CIN ?? c.cin ?? '(no CIN)';
      const name = c.companyName ?? c.company ?? c.name ?? '(no name)';
      const role = c.designation ?? c.role ?? '';
      lines.push(`   - ${cin}  ${name}  ${role ? `(${role})` : ''}`);
    }
  } else {
    lines.push(`❌ No candidate endpointID returned a populated companies list.`);
    lines.push(`   Next steps:`);
    lines.push(`   1. Re-run with --capture to record raw XHRs from the form load (look for any /bin/commongetapi calls with companies in the response).`);
    lines.push(`   2. Open MCA's DIR-3 KYC or MGT-7 form in a real browser, watch DevTools → Network for the relevant POST.`);
    lines.push(`   3. Add the discovered ID to CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS.`);
  }
  return lines.join('\n') + '\n';
}

function formatSingleCall(
  eid: string,
  r: { ok: true; raw: unknown } | { ok: false; error: string },
  din: string,
): string {
  if (!r.ok) return `endpointID="${eid}" DIN=${din} → ERROR: ${r.error}\n`;
  const inner = r.raw as CompaniesByDINResponse;
  const data = inner.data ?? [];
  const lines = [`endpointID="${eid}" DIN=${din} → ${data.length} compan${data.length === 1 ? 'y' : 'ies'}:`];
  for (const c of data) {
    const cin = c.CIN ?? c.cin ?? '(no CIN)';
    const name = c.companyName ?? c.company ?? '(no name)';
    const role = c.designation ?? c.role ?? '';
    lines.push(`  - ${cin}  ${name}  ${role ? `(${role})` : ''}`);
  }
  if (data.length === 0) lines.push(`  (raw response: ${JSON.stringify(inner).slice(0, 300)})`);
  return lines.join('\n') + '\n';
}

function writeOut(text: string, outFile?: string): void {
  if (outFile) {
    fs.writeFileSync(outFile, text);
    process.stderr.write(`[dir:companies] wrote ${outFile}\n`);
  } else {
    process.stdout.write(text);
  }
}

main();
