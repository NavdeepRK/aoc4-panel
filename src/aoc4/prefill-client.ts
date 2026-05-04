import type { Page } from 'playwright';

/**
 * The form's REAL prefill API — discovered by reverse-engineering window.prefillWithCin().
 *
 * Endpoint:  POST /bin/commongetapi
 * Body:      multipart/form-data
 *   data        = encrypt(JSON.stringify({CIN: "..."}))   // window.encrypt() — AES, key in clientlibs-encrptdecrypt.min.js
 *   endpointID  = "inc12-withoutassociation" | (other IDs for other lookups)
 *   csrfToken   = encrypt(<csrfToken value from #csrfToken hidden input>)
 *   csrfDecode  = "false"
 *
 * Response:  application/json
 *   { resCode: 200, resStr: "<JSON-encoded string>" }
 *
 * After unwrapping resStr:
 *   { error: "", message: "Data fetched Successfully", data: [{ companyInfo: {...} }] }
 *
 * NOT to be confused with:
 *   - POST /content/.../guideContainer.af.dermis (FDM dispatcher — used for lookups, NOT for prefill)
 *   - POST /common/service/companyInfo/1.0.0 (FDM operation — only fetches userInfo + associated companies, NOT full company profile)
 */

export interface CompanyAddress {
  country: string;
  pincode: number | string;
  city: string;
  /** "Registered Address" or "Correspondance Address" (server typo: should be "Correspondence") */
  addressType: string;
  district: string;
  latitude: number | null;
  jurisdictionPoliceStation: string | null;
  addressline2: string;
  addressline1: string;
  arealocality: string;
  state: string;
  longitude: number | null;
}

export interface CompanyInfo {
  CIN: string;
  /** Duplicate of CIN — both populated identically */
  UCIN: string;
  company: string;
  companyIncorporationName: string;
  /** "Active" | "Strike Off" | "Under CIRP" | "Under Liquidation" | "Under Liquidation / CIRP" | ... */
  companyStatus: string;
  /** Same as companyStatus */
  status: string;
  classOfCompany: 'Private' | 'Public' | 'One Person Company' | 'Section 8' | string;
  companyType: string;
  companySubcategory: string;
  companyCategory: string;
  companyOrigin: 'Indian' | 'Foreign' | string;
  /** "Y"/"N" — drives Small Company filing relaxations (Companies Act §2(85)) */
  smallCompanyFlag: 'Y' | 'N' | string;
  /** "Y"/"N" — share-capital company flag. Drives whether authorisedcapital is mandatory. */
  shareCapitalFlag: 'Y' | 'N' | string;
  /** dd-mm-yyyy */
  dateOfIncorporation: string;
  /** dd-mm-yyyy — for non-amalgamated companies, equals dateOfIncorporation */
  amalgmatedDate: string;
  /** dd-mm-yyyy — date when companyStatus last changed */
  statusChangeDate: string;
  authorisedcapital: number;
  /** sic — server returns "paidupCaptail" not "paidUpCapital" */
  paidupCaptail: number;
  unclassifiedAuthShareCap: number;
  numberOfDirectors: number;
  numberOfDesignatedPartners: number;
  numberOfPartners: number;
  numberOfMembers: number | null;
  maximumNumberOfMembers: number | null;
  maxNoOfMembersExcludingProposedEmployees: number | null;
  NoOfMembersExcludingProposedEmployees: number | null;
  registrationNumber: number;
  PAN: string;
  emailAddress: string;
  mobile: number | null;
  phone: string | null;
  fax: string | null;
  ROCName: string;
  ROCCode: string;
  type: string;
  /** "N" = INC-20A (Declaration of Commencement of Business) NOT filed; "Y" = filed */
  inc20AFlag: 'Y' | 'N' | null;
  /** "C" or "P" = INC-24 rectification pending — BLOCKS AOC-4 filing */
  inc24Flag: 'C' | 'P' | string | null;
  inc22AFlag: 'Y' | 'N' | null;
  /** ACTIVE compliance flag — INC-22A */
  companiesINC22Flag: 'Y' | 'N' | null;
  managementDisputeFlag: 'Y' | 'N' | null;
  vanishFlag: 'Y' | 'N' | null;
  whetherListedOrNot: 'Y' | 'N' | null;
  inspectionFlag: 'Y' | 'N' | null;
  obligatedContribution: unknown | null;
  section8LicenseNumber: string | null;
  /** Primary NIC industry code — first 2 digits = businessActivity */
  NICCode1: number;
  NICCode1Desc: string;
  NICCode2: number;
  NICCode2Desc: string;
  NICCode3: number;
  NICCode3Desc: string;
  /** First 2 digits of NICCode1 */
  businessActivity: number;
  /** "Y"/"N" — listed company flag */
  listed: 'Y' | 'N';
  agmDate: string | null;
  dateofbalSheet: string | null;
  /** Foreign companies only — null for Indian companies */
  establishmentDt: string | null;
  holdingCompanyCIN: string | null;
  officeType: string | null;
  otherOfficeType: string | null;
  companyAddress: CompanyAddress[];
  /** Allow extra fields for forward-compat */
  [key: string]: unknown;
}

export interface PrefillResponseUnwrapped {
  error: '' | string;
  message: 'Data fetched Successfully' | string;
  data: Array<{ companyInfo: CompanyInfo }>;
}

export interface PrefillResponseRaw {
  resCode: number;
  resStr: string;
}

/**
 * Invokes the form's own `window.prefillWithCin(cin)` function — the same path the
 * "Pre-fill" button uses. Synchronously fires `POST /bin/commongetapi` and populates
 * a subset of bound data fields based on the company's status, INC-20A flag, etc.
 *
 * Returns whatever the page captures via `page.on('response', ...)` — call `setupCapture`
 * on the page first if you want to inspect the raw response.
 */
export async function invokePrefillWithCin(page: Page, cin: string): Promise<{ ok: boolean; error?: string }> {
  return await page.evaluate((c) => {
    try {
      const fn = (window as unknown as { prefillWithCin?: (cin: string) => void }).prefillWithCin;
      if (typeof fn !== 'function') return { ok: false, error: 'prefillWithCin not on window' };
      fn(c);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, cin);
}

/**
 * Direct-call variant: replicates `prefillWithCin`'s POST without using the form's
 * helper. Returns the parsed unwrapped response. Useful when you want the data without
 * letting the form's prefill logic mutate your in-progress filing.
 */
export async function fetchCompanyInfoDirect(page: Page, cin: string): Promise<PrefillResponseUnwrapped | { error: string }> {
  return await page.evaluate(async (c) => {
    const winT = window as unknown as {
      encrypt?: (s: string) => string;
      fnGetCSRFToken?: () => string;
    };
    if (typeof winT.encrypt !== 'function') return { error: 'encrypt() not available' };

    const csrfTokenEl = document.querySelector('#csrfToken') as HTMLInputElement | null;
    const csrfToken = csrfTokenEl?.value;
    if (!csrfToken) return { error: 'CSRF token not found in DOM' };

    const form = new FormData();
    form.append('data', winT.encrypt(JSON.stringify({ CIN: c })));
    form.append('endpointID', 'inc12-withoutassociation');
    form.append('csrfToken', winT.encrypt(csrfToken));
    form.append('csrfDecode', 'false');

    const resp = await fetch('/bin/commongetapi', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const text = await resp.text();
    let outer: { resCode?: number; resStr?: string };
    try { outer = JSON.parse(text); } catch (e) { return { error: 'outer parse: ' + (e as Error).message }; }
    if (outer.resCode !== 200) return { error: `resCode=${outer.resCode}` };
    if (typeof outer.resStr !== 'string') return { error: 'resStr missing' };
    let inner: { error?: string; message?: string; data?: unknown };
    try { inner = JSON.parse(outer.resStr); } catch (e) { return { error: 'inner parse: ' + (e as Error).message }; }
    return inner as unknown as { error: string; message: string; data: Array<{ companyInfo: CompanyInfo }> };
  }, cin);
}

// ─── Director (DIN) lookup via the same /bin/commongetapi endpoint ──────────────

export interface DirectorRecord {
  DIN: number;
  /** "Approved" | "Pending" | "Surrendered" | "Disqualified" | "Suspended" — only Approved can sign filings */
  DINStatus: string;
  /** dd/MM/yyyy */
  DINApprovalDate: string;
  /** "." or "NA" for single-name directors — filter on read */
  FirstName: string;
  MiddleName: string | null;
  LastName: string;
  FatherFirstName: string;
  FatherMiddleName: string | null;
  FatherLastName: string;
  Gender: 'Male' | 'Female' | 'Other' | string;
  /** dd/MM/yyyy */
  DOB: string;
  Nationality: string;
  /** "Y"/"N" */
  ResidentOfIndia: 'Y' | 'N' | string;
  /** "Y"/"N" */
  CitizenOfIndia: 'Y' | 'N' | string;
  ContactNationalityCountry: string;
  EmailAddress: string;
  MobileNumber: string;
  PAN: string;
  /**
   * Full 12-digit Aadhaar number from MCA master.
   * ⚠️ PII — must be masked (all-but-last-4) before any persistence or logging.
   * Aadhaar disclosure is regulated under the Aadhaar Act §29.
   */
  AadhaarNumber: number | string | null;
  PassportNumber: string | null;
  DrivingLicenseNumber: string | null;
  VotersIdNumber: string | null;
  MembershipNumber: string | null;
}

export interface DirectorLookupResponse {
  message: 'Data fetched Successfully' | string;
  data: DirectorRecord[];
}

/**
 * Looks up a director by DIN (or PAN — the field is `DINPAN`).
 *
 * Same wire format as `fetchCompanyInfoDirect` but with `endpointID="mgt7getDinDetails"`.
 *
 * **PII WARNING**: the response includes the director's FULL 12-digit Aadhaar number.
 * Mask it via `maskAadhaar()` before persisting or logging anywhere.
 */
export async function lookupDirectorByDIN(page: Page, din: string): Promise<DirectorLookupResponse | { error: string }> {
  return await page.evaluate(async (d) => {
    const winT = window as unknown as { encrypt?: (s: string) => string };
    if (typeof winT.encrypt !== 'function') return { error: 'encrypt() not available' };

    const csrfTokenEl = document.querySelector('#csrfToken') as HTMLInputElement | null;
    const csrfToken = csrfTokenEl?.value;
    if (!csrfToken) return { error: 'CSRF token not found in DOM' };

    const form = new FormData();
    form.append('data', winT.encrypt(JSON.stringify({ DINPAN: d })));
    form.append('endpointID', 'mgt7getDinDetails');
    form.append('csrfToken', winT.encrypt(csrfToken));
    form.append('csrfDecode', 'false');

    const resp = await fetch('/bin/commongetapi', { method: 'POST', credentials: 'include', body: form });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const text = await resp.text();
    let outer: { resCode?: number; resStr?: string };
    try { outer = JSON.parse(text); } catch (e) { return { error: 'outer parse: ' + (e as Error).message }; }
    if (outer.resCode !== 200) return { error: `resCode=${outer.resCode}` };
    if (typeof outer.resStr !== 'string') return { error: 'resStr missing' };
    let inner: { message?: string; data?: unknown };
    try { inner = JSON.parse(outer.resStr); } catch (e) { return { error: 'inner parse: ' + (e as Error).message }; }
    return inner as unknown as { message: string; data: DirectorRecord[] };
  }, din);
}

/**
 * Reproduces the form's name-construction logic from the AEM valueCommitScript on table2.Row1.din:
 *   (FirstName + " " + MiddleName + " " + LastName).trim()
 * with FirstName/MiddleName/LastName filtered out when they are null, '', '.', or 'NA'.
 */
export function buildDirectorFullName(rec: Pick<DirectorRecord, 'FirstName' | 'MiddleName' | 'LastName'>): string {
  return [rec.FirstName, rec.MiddleName, rec.LastName]
    .filter((p): p is string => !!p && p !== 'null' && p !== '.' && p !== 'NA')
    .join(' ')
    .trim();
}

/**
 * Aadhaar masker — keeps last 4 digits only. Apply IMMEDIATELY on receipt to anything
 * destined for disk, logs, or non-essential code paths. The unmasked value should only
 * exist transiently in memory during the form-fill pipeline.
 */
export function maskAadhaar(aadhaar: number | string | null | undefined): string | null {
  if (aadhaar == null) return null;
  const s = String(aadhaar);
  if (s.length < 4) return s;
  return 'X'.repeat(s.length - 4) + s.slice(-4);
}

/**
 * Populate one row of the AOC-4 director table (`table2.Row1._instances[i]`) given a
 * DirectorRecord (from lookupDirectorByDIN) plus designation + signing date.
 * Uses guideBridge.resolveNode to traverse to the row instance.
 *
 * NOTE: AEM keeps a min of 3 rows. To populate fewer than 3 directors, leave trailing
 * rows empty; do NOT delete them. To populate more, call
 * `gb.resolveNode('table2').Row1._instanceManager.addInstance()`.
 */
export async function populateDirectorRow(
  page: Page,
  rowIndex: number,
  director: { din: string; designation: string; dateOfSigning: string; record: DirectorRecord },
): Promise<{ ok: boolean; error?: string; written?: { din: string; name: string; designation: string; date: string } }> {
  return await page.evaluate(({ rowIndex: idx, din, designation, dateOfSigning, fullName }) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
    const table = gb.resolveNode('table2') as { Row1: { _instanceManager: { _instances: Array<Record<string, { value: unknown; resetData?: () => void }>>; addInstance?: () => void; instanceCount?: number } } } | null;
    if (!table) return { ok: false, error: 'table2 not found' };
    const im = table.Row1._instanceManager;
    while ((im.instanceCount ?? im._instances.length) <= idx) {
      if (typeof im.addInstance === 'function') im.addInstance();
      else return { ok: false, error: `cannot add row ${idx} — addInstance not exposed` };
    }
    const inst = im._instances[idx];
    if (!inst) return { ok: false, error: `row ${idx} still missing after addInstance` };
    try {
      inst.din.value = din;
      inst.name1.value = fullName;
      inst.designation1.value = designation;
      const dateNode = inst.DateOfSigningOfBoard ?? inst.DateOfSigning;
      if (dateNode) dateNode.value = dateOfSigning;
      return {
        ok: true,
        written: {
          din: String(inst.din.value),
          name: String(inst.name1.value),
          designation: String(inst.designation1.value),
          date: String(dateNode?.value ?? ''),
        },
      };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, {
    rowIndex,
    din: director.din,
    designation: director.designation,
    dateOfSigning: director.dateOfSigning,
    fullName: buildDirectorFullName(director.record),
  });
}

/**
 * Other known endpointIDs (discovered from form scripts + AEM jsonModel scripts):
 * - "inc12-withoutassociation": company info by CIN, no auth association required
 * - "mgt7getDinDetails":        director master record by DIN or PAN (despite "mgt7" prefix, used by AOC-4 too)
 * - "fetchAOC4SRN":             fetch a previously-filed AOC-4 SRN (for revisions / linked filings)
 * - "dpt3FetchSrn":              fetch DPT-3 form SRN
 * - "onloadDpt3":                DPT-3 onload data
 * - "adt1_onload":               ADT-1 (Auditor appointment) onload data
 * - "23BOnload":                 Form 23B (legacy auditor appointment intimation) onload
 * - "gnl2Onload":                GNL-2 onload data
 * - "GET_GNL1_DETAILS":          GNL-1 details
 *
 * All use the same /bin/commongetapi endpoint with the same multipart body shape.
 * Add to this list as you discover more endpointIDs in other MCA form scripts.
 */
export const KNOWN_ENDPOINT_IDS = [
  'inc12-withoutassociation',
  'mgt7getDinDetails',
  'fetchAOC4SRN',
  'dpt3FetchSrn',
  'onloadDpt3',
  'adt1_onload',
  '23BOnload',
  'gnl2Onload',
  'GET_GNL1_DETAILS',
] as const;

// ─── Companies-by-DIN reverse lookup (experimental — endpoint TBD) ──────────────

/**
 * Candidate endpointID names to probe for a DIN→companies reverse lookup.
 *
 * MCA does not document `/bin/commongetapi` endpointIDs publicly; the names below are
 * educated guesses based on naming conventions observed in `KNOWN_ENDPOINT_IDS` plus the
 * known purposes of upstream forms (DIR-3 KYC, MGT-7 "other directorships").
 *
 * On first live run, use {@link probeCompaniesByDIN} (CLI: `npm run dir:companies -- --probe <DIN>`)
 * to call each in turn and capture which one returns a populated companies array. Once
 * confirmed, hardcode that ID in {@link lookupCompaniesByDIN}.
 */
export const CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS = [
  // DIR-3 KYC's own onload — populates "list of companies on which DIN is signatory"
  'dir3kycgetdincomp',
  'dir3KycGetDinComp',
  'dir3kyc_onload',
  'getDirectorCompanies',
  'getDinCompanies',
  // MGT-7's other-directorships table fetch
  'mgt7getDirectorOtherCompanies',
  'mgt7GetDirCompanies',
  // Generic
  'dirIndvAssCompanyDetails',
  'getCompaniesByDin',
] as const;

/** Shape returned by any DIN→companies endpoint, when it works. Field names vary per endpoint. */
export interface CompaniesByDINResponse {
  message?: string;
  data?: Array<{
    CIN?: string;
    cin?: string;
    companyName?: string;
    company?: string;
    designation?: string;
    role?: string;
    appointmentDate?: string;
    cessationDate?: string | null;
    /** Pass-through for any other fields */
    [key: string]: unknown;
  }>;
  /** Pass-through */
  [key: string]: unknown;
}

/**
 * Calls `/bin/commongetapi` with the given `endpointID` and `payload`. Generic dispatcher
 * — used by the named lookups (`fetchCompanyInfoDirect`, `lookupDirectorByDIN`) and by
 * the DIN→companies probe.
 *
 * Returns `{ok: false, error}` if the request fails at any layer (transport, encryption
 * setup, outer envelope, inner JSON). Returns `{ok: true, raw}` with the parsed inner
 * payload otherwise — the caller is responsible for shape-checking.
 */
export async function callCommongetapi(
  page: Page,
  endpointID: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> {
  return await page.evaluate(async ({ endpointID: eid, payload: p }) => {
    const winT = window as unknown as { encrypt?: (s: string) => string };
    if (typeof winT.encrypt !== 'function') return { ok: false as const, error: 'encrypt() not available' };
    const csrfTokenEl = document.querySelector('#csrfToken') as HTMLInputElement | null;
    const csrfToken = csrfTokenEl?.value;
    if (!csrfToken) return { ok: false as const, error: 'CSRF token not found in DOM' };

    const form = new FormData();
    form.append('data', winT.encrypt(JSON.stringify(p)));
    form.append('endpointID', eid);
    form.append('csrfToken', winT.encrypt(csrfToken));
    form.append('csrfDecode', 'false');

    const resp = await fetch('/bin/commongetapi', { method: 'POST', credentials: 'include', body: form });
    if (!resp.ok) return { ok: false as const, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    let outer: { resCode?: number; resStr?: string };
    try { outer = JSON.parse(text); } catch (e) { return { ok: false as const, error: 'outer parse: ' + (e as Error).message }; }
    if (outer.resCode !== 200) return { ok: false as const, error: `resCode=${outer.resCode}` };
    if (typeof outer.resStr !== 'string') return { ok: false as const, error: 'resStr missing' };
    let inner: unknown;
    try { inner = JSON.parse(outer.resStr); } catch (e) { return { ok: false as const, error: 'inner parse: ' + (e as Error).message }; }
    return { ok: true as const, raw: inner };
  }, { endpointID, payload });
}

/**
 * Probe each candidate endpointID with the same DIN payload. Returns the first response
 * that looks like a populated companies list (`data` array with at least one CIN-like
 * entry), plus the full attempt log so callers can debug.
 *
 * Use this once on a known-good DIN (e.g., AYUSH RONELD's `11142612`, who is a director
 * of SCALEVERGE) to identify which endpointID actually works on the MCA portal. Save the
 * resulting endpointID and hardcode it in {@link lookupCompaniesByDIN}.
 */
export async function probeCompaniesByDIN(
  page: Page,
  din: string,
  candidates: readonly string[] = CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS,
): Promise<{
  attempts: Array<{ endpointID: string; ok: boolean; error?: string; sample?: unknown }>;
  winningEndpointID?: string;
  winningResponse?: CompaniesByDINResponse;
}> {
  const attempts: Array<{ endpointID: string; ok: boolean; error?: string; sample?: unknown }> = [];
  let winning: { id: string; resp: CompaniesByDINResponse } | undefined;
  // Most endpoints in this family accept either { DIN } or { DINPAN }.
  // Try DIN first; if the endpoint rejects, the caller can re-probe with DINPAN.
  for (const eid of candidates) {
    const r = await callCommongetapi(page, eid, { DIN: din });
    if (!r.ok) { attempts.push({ endpointID: eid, ok: false, error: r.error }); continue; }
    const inner = r.raw as CompaniesByDINResponse | undefined;
    const dataArr = Array.isArray(inner?.data) ? inner!.data : undefined;
    const looksLikeCompanies = !!dataArr && dataArr.length > 0
      && dataArr.some((d) => typeof d === 'object' && d !== null && ('CIN' in d || 'cin' in d || 'companyName' in d));
    attempts.push({ endpointID: eid, ok: looksLikeCompanies, sample: dataArr?.slice(0, 1) });
    if (looksLikeCompanies && !winning) winning = { id: eid, resp: inner! };
  }
  return winning
    ? { attempts, winningEndpointID: winning.id, winningResponse: winning.resp }
    : { attempts };
}

/**
 * Reverse lookup: returns the list of companies a DIN is a signatory on. Once
 * {@link probeCompaniesByDIN} has identified the working endpointID, pin it here.
 *
 * Until then, this function probes all candidates and returns the first working response.
 */
export async function lookupCompaniesByDIN(
  page: Page,
  din: string,
  opts: { endpointID?: string } = {},
): Promise<CompaniesByDINResponse | { error: string; attempts?: unknown }> {
  if (opts.endpointID) {
    const r = await callCommongetapi(page, opts.endpointID, { DIN: din });
    if (!r.ok) return { error: r.error };
    return r.raw as CompaniesByDINResponse;
  }
  const result = await probeCompaniesByDIN(page, din);
  if (!result.winningEndpointID) {
    return { error: 'no candidate endpointID returned a companies list', attempts: result.attempts };
  }
  return result.winningResponse!;
}
