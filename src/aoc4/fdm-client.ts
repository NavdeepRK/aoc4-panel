import type { Page } from 'playwright';
import { AOC4_GUIDE_PATH } from './bridge.js';

/**
 * All form-side data lookups go through one AEM endpoint:
 *
 *   POST /content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.af.dermis
 *
 * Body (URL-encoded):
 *   functionToExecute=invokeFDMOperation
 *   formDataModelId=<jcr-path>
 *   input=<URL-encoded JSON>
 *   operationName=<HTTP verb> <REST path>/<version>
 *   guideNodePath=<path of triggering field>
 *
 * This module wraps each known operation as a typed call. The fetch runs IN the page
 * context (via page.evaluate) so cookies + same-origin + AEM's own session checks Just Work.
 */

const FDM_ENDPOINT = `${AOC4_GUIDE_PATH}.af.dermis`;

interface InvokeArgs {
  formDataModelId: string;
  operationName: string;
  input: unknown;
  guideNodePath?: string;
}

async function invokeFDM<TResp = unknown>(page: Page, args: InvokeArgs): Promise<{ status: number; body: TResp | null; raw: string }> {
  return await page.evaluate(async (a) => {
    const body = new URLSearchParams({
      functionToExecute: 'invokeFDMOperation',
      formDataModelId: a.formDataModelId,
      input: JSON.stringify(a.input),
      operationName: a.operationName,
      guideNodePath: a.guideNodePath ?? a.defaultGuideNodePath,
    });
    const r = await fetch(a.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const raw = await r.text();
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    return { status: r.status, raw, body: parsed as unknown };
  }, {
    endpoint: FDM_ENDPOINT,
    defaultGuideNodePath: AOC4_GUIDE_PATH,
    ...args,
  }) as { status: number; body: TResp | null; raw: string };
}

// ─── Typed responses ────────────────────────────────────────────────────────────

export interface UserPersonalAddress {
  addressLine1: string;
  addressLine2: string;
  pincode: string;
  city: string;
  country: string;
  state: string;
  jurisdictionOfPoliceStation: string;
}

export interface UserInfo {
  personalAddress: UserPersonalAddress;
  userCategory: 'Registered user' | 'Business User' | string;
  userRole: string[];
  incomeTaxPAN: string;
  DIN_DPIN: string;
  institute: string;
  membershipNumber: string;
  firstName: string;
  middleName: string;
  lastName: string;
  /** MM/dd/yyyy */
  dateOfBirth: string;
  gender: 'Male' | 'Female' | 'Other' | string;
  profession: string;
  other: string;
  professionalMembershipNo: string;
  industryOfOperation: string;
  telephoneNoResidence: string;
  telephoneNoOffice: string;
  mobileNo: string;
  emailId: string;
  mcaUserType: 'Individual' | 'Director' | 'CA' | 'CS' | 'CMA' | string;
}

export interface CompanyEntry {
  /** Present when the user is associated with this company (Business User flow). */
  CIN?: string;
  name?: string;
  registeredAddress: Partial<UserPersonalAddress> | Record<string, never>;
  status: string;
  otherAddress: Partial<UserPersonalAddress> | Record<string, never>;
  dateOfIncorporation?: string;
  classOfCompany?: string;
  subCategory?: string;
  authorizedCapital?: string | number;
  paidUpCapital?: string | number;
  /** Allow extra fields — populated companies have more keys we haven't fully mapped. */
  [key: string]: unknown;
}

export interface CompanyInfoResponse {
  error: string;
  message: string;
  data: {
    userInfo: UserInfo;
    companyInfo: CompanyEntry[];
  };
}

export interface LookupHintResponse {
  Message: string | null;
  data: Array<{ name: string }>;
  error: string;
}

export interface LookupHighResponse {
  data: Array<{ name: string }> | null;
  error: string;
  message?: string;
  Message?: string | null;
}

export interface LinkedFormsResponse {
  data: unknown;
  message: string;
}

// ─── Operation wrappers ─────────────────────────────────────────────────────────

/**
 * Primary prefill API. Returns the logged-in user's profile and any associated companies.
 * - Registered Users (Individual): companyInfo[] is empty.
 * - Business Users: companyInfo[] is populated with one entry per associated CIN.
 */
export async function fetchCompanyInfo(page: Page, userId: string): Promise<CompanyInfoResponse | null> {
  const r = await invokeFDM<CompanyInfoResponse>(page, {
    formDataModelId: '/content/dam/formsanddocuments-fdm/aoc4/cmpnyinfo',
    operationName: 'POST /common/service/companyInfo/1.0.0',
    input: { COMPANY_INFO_REQ: { requestBody: { userId } } },
  });
  return r.body;
}

/** Generic enum lookup. */
export async function fetchUserHint(page: Page, type: string): Promise<LookupHintResponse | null> {
  const r = await invokeFDM<LookupHintResponse>(page, {
    formDataModelId: '/content/dam/formsanddocuments-fdm/aoc4/userreq',
    operationName: 'GET /userregistration/service/lookup/userhintquestion/1.0.0',
    input: { type },
  });
  return r.body;
}

/** Industry list (top-level AOC-4 categories). */
export async function fetchIndustryList(page: Page): Promise<LookupHighResponse | null> {
  const r = await invokeFDM<LookupHighResponse>(page, {
    formDataModelId: '/content/dam/formsanddocuments-fdm/user-resigtration-login/get-industry-list',
    operationName: 'GET /common/service/lookup/high/1.0.0',
    input: { type: 'MCA_AOC4_INDUSTRY_TYPE' },
  });
  return r.body;
}

/** Alternate country list (different formatting from userhintquestion COUNTRY). */
export async function fetchCommonLookupCountry(page: Page): Promise<LookupHighResponse | null> {
  const r = await invokeFDM<LookupHighResponse>(page, {
    formDataModelId: '/content/dam/formsanddocuments-fdm/aoc4/commonlookuphigh',
    operationName: 'GET /common/service/lookup/high/1.0.0',
    input: { type: 'COUNTRY' },
  });
  return r.body;
}

/** Linked forms by SRN (e.g. AOC-4 → CSR-2). Empty SRN returns `{data:null,message:'No Data'}`. */
export async function fetchLinkedForms(page: Page, referenceNumber: string): Promise<LinkedFormsResponse | null> {
  const r = await invokeFDM<LinkedFormsResponse>(page, {
    formDataModelId: '/content/dam/formsanddocuments-fdm/aoc4/getdmsid',
    operationName: 'GET /interactivedashboard/service/getdocumentlinkedforms/1.0.0',
    input: { referenceNumber },
  });
  return r.body;
}

// ─── Known lookup type strings ──────────────────────────────────────────────────

export const HINT_TYPES = {
  /** Nature of financial statements (Provisional / Adopted / Revised u/s 130 / Revised u/s 131) */
  NATURE_CONSOL: 'MCA_NATURE_CONSOL',
  /** Revision scope (Financial Statement / Director Report / Both) */
  NAT_REVISION: 'MCA_NAT_REVISION',
  /** Subsidiary classification (Section 2(87)(i) / (ii)). Note server-side typo 'SUBSIDARY'. */
  SUBSIDARY: 'MCA_SUBSIDARY',
  /** Signatory designation (Director / Manager / Secretary / CEO / CFO / IRP_RP_Liquidator) */
  AOC_DESIG: 'MCA_AOC_DESIG',
  /** Industry classification (Commercial & Industrial / Banking / Insurance / Power / NBFC) */
  AOC4_INDUSTRY_TYPE: 'MCA_AOC4_INDUSTRY_TYPE',
  /** Country list (note: aoc4/userreq and aoc4/commonlookuphigh return DIFFERENT lists) */
  COUNTRY: 'COUNTRY',
} as const;

/** Snapshot all known lookups in one call — useful for offline reference / regression tests. */
export async function snapshotAllLookups(page: Page): Promise<Record<string, LookupHintResponse | LookupHighResponse | null>> {
  const out: Record<string, LookupHintResponse | LookupHighResponse | null> = {};
  for (const [, type] of Object.entries(HINT_TYPES)) {
    if (type === 'MCA_AOC4_INDUSTRY_TYPE') {
      out[`industry_${type}`] = await fetchIndustryList(page);
    } else {
      out[`hint_${type}`] = await fetchUserHint(page, type);
    }
  }
  out['common_COUNTRY'] = await fetchCommonLookupCountry(page);
  return out;
}
