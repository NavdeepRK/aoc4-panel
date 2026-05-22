/**
 * In-memory job state for AOC-4 filings.
 *
 * Each job represents one in-flight AOC-4 filing for a specific CIN. It carries:
 *   - Current phase (the state machine: PENDING → DRAFT_CREATED → … → FILED)
 *   - Captured Siebel SR Id (assigned on first save)
 *   - Browser handle (kept alive between phases — session reuse avoids re-login)
 *   - Artifacts (draft PDF path, signed PDF buffer, server SRN, errors)
 *
 * Restart behavior: in-memory only. If the service restarts, jobs are lost.
 * Production should persist state to a DB, but for the MVP this matches the
 * INC-20A pattern (which also stores `jobId` in `GovernmentApplication.metadata`
 * and assumes the worker has the in-memory state).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, Page } from 'playwright';

/**
 * On-disk job state cache.
 *
 * Why: an in-memory-only design loses everything when the service restarts —
 * status queries 404, downloaded PDFs become orphaned, the SPOC has to re-trigger
 * from scratch even when MCA already has a valid draft. So we snapshot the
 * serializable fields after every phase transition.
 *
 * What we DON'T persist: `_browser` and `_page` (Playwright handles can't be
 * rehydrated across processes). Hydrated jobs are read-only for actions that
 * need a live browser (upload-signed, PDF re-fetch). The status + saved-PDF
 * endpoints still work.
 */
const STATE_ROOT = process.env.MCA_FILING_ARTIFACT_DIR ?? './.artifacts/runs';
const STATE_FILE = 'state.json';

function _stateFilePath(jobId: string): string {
  return path.join(STATE_ROOT, jobId, STATE_FILE);
}

/** Strip browser + signal handles + persist to disk. Best-effort. */
function _persistJob(job: Aoc4Job): void {
  try {
    const { _browser: _b, _page: _p, _signals: _s, ...serializable } = job;
    const dir = path.join(STATE_ROOT, job.jobId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_stateFilePath(job.jobId), JSON.stringify(serializable, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[jobs] persist failed for ${job.jobId}: ${(e as Error).message}\n`);
  }
}

/** Build a deferred-promise pair. The worker awaits .promise; the HTTP handler calls .resolve. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Read state.json files from disk on service startup, populating the in-memory map. */
export function hydrateJobsFromDisk(): { hydrated: number; skipped: number } {
  let hydrated = 0;
  let skipped = 0;
  try {
    if (!fs.existsSync(STATE_ROOT)) return { hydrated: 0, skipped: 0 };
    for (const name of fs.readdirSync(STATE_ROOT)) {
      const stateFile = _stateFilePath(name);
      if (!fs.existsSync(stateFile)) { skipped++; continue; }
      try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const parsed = JSON.parse(raw) as Aoc4Job;
        // Browser handles are gone — anything that needs them will fail with a clear error.
        // Other surfaces (status, PDF download from disk) work fine.
        jobs.set(parsed.jobId, parsed);
        hydrated++;
      } catch {
        skipped++;
      }
    }
  } catch (e) {
    process.stderr.write(`[jobs] hydrate failed: ${(e as Error).message}\n`);
  }
  return { hydrated, skipped };
}

export type Aoc4Phase =
  | 'PENDING'             // job created, browser not yet launched
  | 'QUEUED'              // job created but waiting for a concurrency slot
  | 'LOGIN_NEEDED'        // browser launched on MCA login page, awaiting SPOC creds
  | 'LOGGING_IN_CREDS'    // creds received, submitting username/password
  | 'OTP_PENDING'         // login form submitted, waiting for SPOC OTP
  | 'SUBMITTING_OTP'      // OTP received, submitting
  | 'AUTHENTICATED'       // logged in, about to navigate to AOC-4 form
  | 'LOGGING_IN'          // re-using or refreshing the MCA session (legacy shared-session path)
  | 'LOADING_FORM'        // form load + bridge connect
  | 'PREFILLING'          // prefillWithCin in flight
  | 'FILLING_PANEL'       // setProperty calls in progress (panel index in `panelInProgress`)
  | 'SAVING_PANEL'        // commonSaveSubmit in flight
  | 'DRAFT_CREATED'       // panels 1-7 saved, SR id captured, awaiting human DSC step
  | 'PDF_DOWNLOADED'      // draft PDF pulled from MCA, available to client
  | 'AWAITING_SIGNATURE'  // PDF handed off to admin for DSC signing
  | 'UPLOADING_SIGNED'    // signed PDF being pushed to MCA
  | 'FILED'               // MCA accepted the filing, SRN assigned
  | 'INVALID_CREDS'       // MCA rejected the SPOC's username/password
  | 'INVALID_OTP'         // MCA rejected the SPOC's OTP
  | 'FAILED';             // unrecoverable error (see `error`)

export interface Aoc4FormPayload {
  cin: string;
  /** Financial year window — ISO yyyy-MM-dd */
  financialYearFrom: string;
  financialYearTo: string;
  /** Board meeting + signing dates — ISO */
  boardMeetingFsApprovalDate: string;
  boardMeetingReportDate: string;
  auditorSigningDate: string;
  agmDate: string;
  agmDueDate: string;
  numberOfMembers: number;
  /** Directors — DIN strings, the form looks up names + designations via mgt7getDinDetails */
  directors: Array<{ din: string; designation: string }>;
  /** Index of the FS-signing director within `directors[]` (defaults to 0) */
  fsSignerDirectorIndex?: number;
  /** Auditor info — see preset for fields */
  auditor?: {
    srnOfAdt1?: string;
    pan?: string;
    category?: 'Individual' | "Auditor's firm";
    membershipNumber?: string;
    name?: string;
    address?: { line1: string; line2?: string; country: string; pincode: string; city: string; district?: string; state: string };
    signingMember?: { name: string; membershipNumber: string };
  };
  /** Balance sheet (minimum: cash + share capital, balanced) */
  balanceSheet?: { shareCapital: number; reserves: number; cashAndEquivalents: number };
  /**
   * Schedule III balance sheet rows (current FY + previous FY). Field names mirror
   * the AOC-4 form's panel 3 row identifiers — see aoc4-worker.ts → applyPanel3Overrides.
   * Any field omitted falls back to the generic-fill default (0.00).
   */
  scheduleIII?: {
    /** Equity & Liabilities */
    equityShareCapital?: { current: number; previous?: number };
    otherEquity?: { current: number; previous?: number };
    longTermBorrowings?: { current: number; previous?: number };
    shortTermBorrowings?: { current: number; previous?: number };
    tradePayables?: { current: number; previous?: number };
    otherCurrentLiabilities?: { current: number; previous?: number };
    shortTermProvisions?: { current: number; previous?: number };
    /** Assets */
    fixedAssets?: { current: number; previous?: number };        // row 16 — PPE
    propertyPlantEquipment?: { current: number; previous?: number };
    intangibleAssets?: { current: number; previous?: number };
    investments?: { current: number; previous?: number };
    longTermLoansAndAdvances?: { current: number; previous?: number };
    inventories?: { current: number; previous?: number };
    tradeReceivables?: { current: number; previous?: number };
    cashAndCashEquivalents?: { current: number; previous?: number };
    shortTermLoansAndAdvances?: { current: number; previous?: number };
    otherCurrentAssets?: { current: number; previous?: number };
  };
  /** Profit & Loss summary (panel 6 in the live form) */
  profitAndLoss?: {
    revenueFromOperations?: { current: number; previous?: number };
    otherIncome?: { current: number; previous?: number };
    totalRevenue?: { current: number; previous?: number };
    costOfMaterialsConsumed?: { current: number; previous?: number };
    employeeBenefitExpense?: { current: number; previous?: number };
    financeCharges?: { current: number; previous?: number };
    depreciationAndAmortisation?: { current: number; previous?: number };
    otherExpenses?: { current: number; previous?: number };
    totalExpenses?: { current: number; previous?: number };
    profitBeforeTax?: { current: number; previous?: number };
    taxExpense?: { current: number; previous?: number };
    profitAfterTax?: { current: number; previous?: number };
  };
  /**
   * Direct field-name overrides per panel — applied after generic fill, before save.
   * Use this when you know the exact AEM field name + value (e.g. from a live form walk).
   * Field names are the SOM-tree `name` property, not the bound-data names.
   *
   * Example:
   *   panelOverrides: {
   *     panel3: { FiguresAtEndOfCurrentReporting1: '50000', figuresAsEndOfPreviousReporting1: '0' },
   *     panel4: { ... }
   *   }
   */
  panelOverrides?: Partial<Record<'panel1' | 'panel2' | 'panel3' | 'panel4' | 'panel5' | 'panel6' | 'panel7', Record<string, string | number>>>;
  /** Whether to override gb.validate to bypass cross-panel validation. Default true (proven required for partial saves). */
  bypassValidation?: boolean;

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Panel 1 radio / dropdown answers — match the AOC-4 form question numbers. */
  /* All optional with sensible defaults for a typical small-Pvt filing; pass  */
  /* explicit values from the PDF/SPOC form to override. Values are the EXACT  */
  /* strings MCA's form expects (e.g. "Yes", not "1") — set live 2026-05-15.  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /** 4(b)(i) Nature of financial statements. Default 'Adopted Financial statements'. */
  natureOfFinancialStatements?: 'Provisional un-adopted Financial statements' | 'Adopted Financial statements' | 'Revised Financial statements u/s 130' | 'Revised Financial statements u/s 131';
  /** 4(b)(iii) Whether provisional FS filed earlier. Default 'No'. */
  provisionalFsFiledEarlier?: 'Yes' | 'No' | 'Not Applicable';
  /** 4(b)(iv) Whether adopted in adjourned AGM. Default 'No'. */
  adoptedInAdjournedAgm?: 'Yes' | 'No' | 'Not Applicable';
  /** 7(a) Whether AGM held. Default 'Yes' if agmDate present, else 'No'. */
  agmHeld?: 'Yes' | 'No' | 'Not Applicable';
  /** 7(d) Whether any extension for AGM granted. Default 'No'. */
  agmExtensionGranted?: 'Yes' | 'No';
  /** 8(a) Whether the company is a subsidiary. Default 'No'. */
  isSubsidiary?: 'Yes' | 'No';
  /** 8(e) Whether the company HAS a subsidiary/associate/JV. Default 'No'. */
  hasSubsidiaryOrAssociate?: 'Yes' | 'No';
  /** 10(a) Type of Industry. Default 'Commercial & Industrial'. */
  industryType?: 'Commercial & Industrial' | 'Banking Company' | 'Insurance Company' | 'Power Company' | 'Non-banking Financial Company';
  /** 10(b) Whether Schedule III applicable. Default 'Yes'. MUST be 'Yes' when industryType is C&I/NBFC. */
  scheduleIIIApplicable?: 'Yes' | 'No';
  /** 11 Whether consolidated FS required. Default 'No'. */
  consolidatedFsRequired?: 'Yes' | 'No';
  /** 12(a) Whether books maintained electronically. Default 'No'. */
  electronicBooks?: 'Yes' | 'No';

  /**
   * Source-attachment references (PDFs uploaded by the SPOC). The worker downloads
   * each from `url`, then attaches it to the corresponding MCA file-input slot.
   * Slot ids are the schema field IDs (`attachFinancialStatements`, etc.) so the
   * worker can route each file to its correct AEM widget.
   */
  attachments?: Partial<Record<
    'attachFinancialStatements' | 'attachSupplementaryAuditReport' | 'attachCagComments'
    | 'attachSecretarialAuditReport' | 'attachStatementForNotAdopted'
    | 'attachStatementForNotHoldingAgm' | 'attachOptional',
    { s3Key?: string; url: string; originalName?: string; mimetype?: string }
  >>;

  /** Full schema-shaped form data — carried through from the backend for the
   *  worker to inspect any field the panel-N hand-curated functions don't cover. */
  formData?: Record<string, unknown>;

  /** Debug stats from the adapter — how many schema fields actually got
   *  panelOverrides mappings (visible in worker logs for coverage tracking). */
  _aemMappingStats?: { mapped: number; unmappedAem: number };

  /** Saved Playwright storageState from a prior login for this SPOC. When present,
   *  the worker tries the cookies first and skips the LOGIN_NEEDED/OTP_PENDING
   *  prompts. If MCA rejects them (session expired), falls back to fresh login. */
  _storageState?: { cookies?: unknown[]; origins?: unknown[] };
  /** The MCA user id this stored session was captured for — used for admin dashboard
   *  display + sanity check. */
  _savedMcaUserId?: string;
  /** Portal user id — needed by the worker to POST the new storageState back to the
   *  backend after a successful login. */
  _spocUserId?: string | null;
}

export interface Aoc4Job {
  jobId: string;
  cin: string;
  phase: Aoc4Phase;
  /** Siebel SR Id (e.g., "1-BNRAQGG"). Set on first successful panel save. */
  /** Siebel internal id (short, e.g. "1-BNSWT19") — used for backend lookups */
  srId?: string;
  /** MCA reference number (long numeric, e.g. "1-25383887613") — what shows in My Application */
  referenceNumber?: string;
  /**
   * Resume URL — paste into a logged-in MCA browser to open the draft and continue filing.
   * Constructed from { srn, reference, purpose, integrationId } base64-encoded into the
   * `applicationHistory` query param. Discovered live 2026-05-02.
   */
  resumeUrl?: string;
  /** Final SRN assigned after submission. */
  filingSrn?: string;
  /** Last error, if any. Cleared on successful phase transition. */
  error?: string;
  /** UNIX ms timestamp of the most recent state transition. */
  lastEventAt: number;
  createdAt: number;
  payload: Aoc4FormPayload;
  /** Path to the downloaded draft PDF on disk, if available. */
  draftPdfPath?: string;
  /** Path where the admin-uploaded signed PDF is staged. */
  signedPdfPath?: string;
  /** Per-panel save outcomes for diagnostics */
  panelResults: Array<{
    panel: number;
    ok: boolean;
    srId?: string;
    error?: string;
    /** Number of fields actually written during generic fill (0 = panel was force-saved empty) */
    fieldsWritten?: number;
  }>;
  /** Internal: current panel being processed (for monitoring only) */
  panelInProgress?: number;
  /** Internal: live browser handle. Kept alive across HTTP requests. */
  _browser?: Browser;
  _page?: Page;
  /**
   * Internal: deferred-promise signals for the per-job login flow. The worker awaits
   * these at the LOGIN_NEEDED / OTP_PENDING phases; the /jobs/:id/creds + /jobs/:id/otp
   * HTTP endpoints resolve them when the SPOC submits the corresponding input.
   *
   * Never serialized (function references can't go to disk). Re-created on hydrate
   * if needed, but a hydrated job past LOGIN_NEEDED would be stale anyway.
   */
  _signals?: {
    creds?: { promise: Promise<{ userId: string; password: string }>; resolve: (v: { userId: string; password: string }) => void; reject: (e: Error) => void };
    otp?:   { promise: Promise<{ otp: string }>; resolve: (v: { otp: string }) => void; reject: (e: Error) => void };
  };
  /** Per-SPOC login record (the user-id only — password is never persisted). Filled
   *  when the SPOC submits creds. Useful for admin dashboard. */
  mcaUserId?: string;
  /** UI-facing email of the SPOC who triggered this job (for admin dashboard). */
  spocEmail?: string;
}

const jobs = new Map<string, Aoc4Job>();

export function createJob(jobId: string, payload: Aoc4FormPayload): Aoc4Job {
  const now = Date.now();
  const job: Aoc4Job = {
    jobId,
    cin: payload.cin,
    phase: 'PENDING',
    lastEventAt: now,
    createdAt: now,
    payload,
    panelResults: [],
  };
  jobs.set(jobId, job);
  _persistJob(job);
  return job;
}

export function getJob(jobId: string): Aoc4Job | undefined {
  return jobs.get(jobId);
}

export function setPhase(jobId: string, phase: Aoc4Phase, extra?: Partial<Aoc4Job>): Aoc4Job {
  const j = jobs.get(jobId);
  if (!j) throw new Error(`job ${jobId} not found`);
  j.phase = phase;
  j.lastEventAt = Date.now();
  if (extra) Object.assign(j, extra);
  _persistJob(j); // snapshot every phase transition so the service can be restarted safely
  return j;
}

/** Public-safe view (strips internal browser + signal handles) for HTTP responses. */
export function publicView(j: Aoc4Job): Omit<Aoc4Job, '_browser' | '_page' | '_signals'> {
  const { _browser: _b, _page: _p, _signals: _s, ...rest } = j;
  return rest;
}

export function listJobs(): Aoc4Job[] {
  return [...jobs.values()];
}

/** Drop a job + its browser. Idempotent. */
export async function disposeJob(jobId: string): Promise<void> {
  const j = jobs.get(jobId);
  if (!j) return;
  try { await j._browser?.close(); } catch { /* already closed */ }
  jobs.delete(jobId);
}
