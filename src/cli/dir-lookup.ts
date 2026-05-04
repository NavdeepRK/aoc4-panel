/**
 * MCA Director Lookup CLI
 *
 * Fetches the full director master record from MCA's `/bin/commongetapi` endpoint
 * (endpointID="mgt7getDinDetails") for one or many DINs.
 *
 * Usage:
 *   npm run dir:lookup -- 11142612
 *   npm run dir:lookup -- 11142612 11142613
 *   npm run dir:lookup -- --file dins.txt        # one DIN per line
 *   npm run dir:lookup -- --json 11142612         # raw JSON output
 *   npm run dir:lookup -- --include-aadhaar 11142612   # do NOT mask Aadhaar (only with explicit consent)
 *   npm run dir:lookup -- --csv --file dins.txt > directors.csv
 *
 * Auth: requires a logged-in MCA session (storage-state.json). Run `npm run login` first.
 *
 * PII handling: Aadhaar is masked to last-4 by default. Pass --include-aadhaar to disable masking
 * (use only when consent is documented and the data flows directly into a regulated downstream
 * use case under the Aadhaar Act §29).
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, teardown } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';
import { lookupDirectorByDIN, buildDirectorFullName, maskAadhaar, type DirectorRecord, type DirectorLookupResponse } from '../aoc4/prefill-client.js';

interface CliFlags {
  json: boolean;
  csv: boolean;
  includeAadhaar: boolean;
  file?: string;
  outFile?: string;
  dins: string[];
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { json: false, csv: false, includeAadhaar: false, dins: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--csv') flags.csv = true;
    else if (a === '--include-aadhaar') flags.includeAadhaar = true;
    else if (a === '--file') flags.file = argv[++i];
    else if (a === '--out') flags.outFile = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    else flags.dins.push(a);
  }
  return flags;
}

function printHelp(): void {
  console.log(`MCA Director Lookup

Usage:
  npm run dir:lookup -- <DIN> [<DIN>...]
  npm run dir:lookup -- --file <path>          # one DIN per line in the file
  npm run dir:lookup -- --json <DIN>           # raw JSON output (one object per line)
  npm run dir:lookup -- --csv --file dins.txt  # CSV output for spreadsheet import
  npm run dir:lookup -- --out <path>           # write output to file instead of stdout
  npm run dir:lookup -- --include-aadhaar      # disable Aadhaar masking (REGULATED — see notes)

Output formats:
  default = pretty table (human-readable)
  --json  = JSONL — one record per line
  --csv   = CSV with header

PII handling:
  Aadhaar is masked to last-4 by default ("XXXXXXXX1234"). Aadhaar Act §29 prohibits
  unmasked disclosure without documented consent for a specified purpose. Use
  --include-aadhaar only when the receiving system is also Aadhaar-Act compliant.
`);
}

function readDinsFromFile(filePath: string): string[] {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, 'utf-8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

interface NormalizedDirector {
  din: string;
  fullName: string;
  status: string;
  approvedOn: string;
  gender: string;
  dob: string;
  pan: string;
  aadhaar: string | null;
  email: string;
  mobile: string;
  fatherName: string;
  nationality: string;
  residentOfIndia: string;
  lookupOk: boolean;
  error?: string;
  raw?: DirectorRecord;
}

function normalize(din: string, resp: DirectorLookupResponse | { error: string }, opts: { includeAadhaar: boolean }): NormalizedDirector {
  if ('error' in resp) {
    return {
      din, fullName: '', status: '', approvedOn: '', gender: '', dob: '', pan: '',
      aadhaar: null, email: '', mobile: '', fatherName: '', nationality: '', residentOfIndia: '',
      lookupOk: false, error: resp.error,
    };
  }
  if (!resp.data || resp.data.length === 0) {
    return {
      din, fullName: '', status: '', approvedOn: '', gender: '', dob: '', pan: '',
      aadhaar: null, email: '', mobile: '', fatherName: '', nationality: '', residentOfIndia: '',
      lookupOk: false, error: 'No data returned',
    };
  }
  const r = resp.data[0];
  const fullName = buildDirectorFullName(r);
  const fatherName = [r.FatherFirstName, r.FatherMiddleName, r.FatherLastName]
    .filter((p): p is string => !!p && p !== 'null' && p !== '.' && p !== 'NA')
    .join(' ')
    .trim();

  return {
    din: String(r.DIN),
    fullName,
    status: r.DINStatus,
    approvedOn: r.DINApprovalDate,
    gender: r.Gender,
    dob: r.DOB,
    pan: r.PAN,
    aadhaar: opts.includeAadhaar ? (r.AadhaarNumber == null ? null : String(r.AadhaarNumber)) : maskAadhaar(r.AadhaarNumber),
    email: r.EmailAddress,
    mobile: r.MobileNumber,
    fatherName,
    nationality: r.Nationality,
    residentOfIndia: r.ResidentOfIndia,
    lookupOk: true,
    raw: r,
  };
}

function csvEscape(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function emit(rows: NormalizedDirector[], flags: CliFlags): void {
  const out: string[] = [];
  if (flags.json) {
    for (const r of rows) {
      const { raw, ...rest } = r;
      out.push(JSON.stringify(flags.includeAadhaar && raw ? { ...rest, raw } : rest));
    }
  } else if (flags.csv) {
    out.push(['din', 'fullName', 'status', 'approvedOn', 'gender', 'dob', 'pan', 'aadhaar_masked_or_full', 'email', 'mobile', 'fatherName', 'nationality', 'residentOfIndia', 'lookupOk', 'error'].map(csvEscape).join(','));
    for (const r of rows) {
      out.push([r.din, r.fullName, r.status, r.approvedOn, r.gender, r.dob, r.pan, r.aadhaar ?? '', r.email, r.mobile, r.fatherName, r.nationality, r.residentOfIndia, String(r.lookupOk), r.error ?? ''].map(csvEscape).join(','));
    }
  } else {
    // Pretty table
    out.push(`Director lookup — ${rows.length} record(s)\n`);
    out.push(`${'DIN'.padEnd(11)}  ${'Status'.padEnd(13)}  ${'Approved'.padEnd(11)}  ${'Name'.padEnd(40)}  ${'PAN'.padEnd(11)}  ${'Mobile'}`);
    out.push('-'.repeat(120));
    for (const r of rows) {
      if (!r.lookupOk) {
        out.push(`${r.din.padEnd(11)}  ${'(error)'.padEnd(13)}  ${''.padEnd(11)}  ${(r.error ?? '').slice(0, 40).padEnd(40)}`);
        continue;
      }
      out.push(`${r.din.padEnd(11)}  ${r.status.padEnd(13)}  ${r.approvedOn.padEnd(11)}  ${r.fullName.slice(0, 40).padEnd(40)}  ${r.pan.padEnd(11)}  ${r.mobile}`);
    }
    out.push('');
    out.push('Aadhaar (masked unless --include-aadhaar):');
    for (const r of rows) {
      if (!r.lookupOk) continue;
      out.push(`  ${r.din}: ${r.aadhaar ?? '(none on record)'}`);
    }
  }

  const text = out.join('\n') + '\n';
  if (flags.outFile) {
    fs.writeFileSync(flags.outFile, text);
    if (!flags.json && !flags.csv) console.log(`Wrote ${rows.length} record(s) to ${flags.outFile}`);
  } else {
    process.stdout.write(text);
  }
}

(async () => {
  const flags = parseArgs(process.argv.slice(2));

  let dins = flags.dins.slice();
  if (flags.file) dins = dins.concat(readDinsFromFile(flags.file));
  dins = [...new Set(dins.map((d) => d.trim()))].filter((d) => d.length > 0);

  if (dins.length === 0) {
    console.error('No DINs provided. Use --help for usage.');
    process.exit(2);
  }

  // Validate format — DIN is 8 digits; PAN-mode uses 10 chars
  for (const d of dins) {
    if (!/^\d{8}$/.test(d) && !/^[A-Z]{5}\d{4}[A-Z]$/.test(d)) {
      console.error(`Invalid DIN/PAN format: "${d}" (expected 8 digits or 10-char PAN)`);
      process.exit(2);
    }
  }

  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  // Headless honors HEADLESS env var (defaults to false because MCA's anti-bot trips on headless).
  // For server-side runs, set HEADLESS=true and add proxy/UA tweaks if MCA starts blocking.
  const { browser, page } = await launch();

  try {
    // Load any AEM Adaptive Form page so window.encrypt + #csrfToken are available.
    // The AOC-4 form is reliable; could also use any other annual-filing form.
    process.stderr.write(`[dir:lookup] loading form to bootstrap encrypt() + CSRF...\n`);
    await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForBridge(page, 30_000);
    // Wait until window.encrypt exists
    await page.waitForFunction(
      () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'),
      { timeout: 30_000 },
    );

    const rows: NormalizedDirector[] = [];
    for (let i = 0; i < dins.length; i++) {
      const din = dins[i];
      process.stderr.write(`[dir:lookup] (${i + 1}/${dins.length}) ${din}…\n`);
      const resp = await lookupDirectorByDIN(page, din);
      rows.push(normalize(din, resp, { includeAadhaar: flags.includeAadhaar }));
      // Be polite to MCA — small delay between requests
      if (i < dins.length - 1) await page.waitForTimeout(400);
    }

    emit(rows, flags);
  } catch (e) {
    console.error('[dir:lookup] error:', e);
    process.exit(1);
  } finally {
    await teardown(browser);
  }
})();
