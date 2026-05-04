import OpenAI from 'openai';

const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';

/**
 * TrueCaptcha (api.apitruecaptcha.org) — primary solver. Same service the GST automation
 * uses; ~95% accuracy on these distorted-character captchas. Needs TRUECAPTCHA_USER and
 * TRUECAPTCHA_KEY env vars (set in `.env`).
 *
 * MCA's captcha is 6 alphanumeric characters (not numeric like GST), so we DON'T pass
 * `numeric:true` here — let TrueCaptcha return the full alphanumeric result.
 */
async function solveCaptchaWithTrueCaptcha(pngBase64: string): Promise<string> {
  const userid = process.env.TRUECAPTCHA_USER;
  const apikey = process.env.TRUECAPTCHA_KEY;
  if (!userid || !apikey) throw new Error('TRUECAPTCHA_USER / TRUECAPTCHA_KEY not set');

  const body = {
    userid,
    apikey,
    data: pngBase64,
    mode: process.env.TRUECAPTCHA_MODE ?? 'human',
    // numeric: false — MCA captcha is alphanumeric
  };

  const r = await fetch('https://api.apitruecaptcha.org/one/gettext', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`TrueCaptcha: HTTP ${r.status} ${r.statusText}`);
  const j = await r.json() as { result?: string; conf?: number; error_message?: string };
  if (j.error_message) throw new Error(`TrueCaptcha: ${j.error_message}`);
  if (!j.result) throw new Error(`TrueCaptcha: no result in response: ${JSON.stringify(j)}`);

  // Strip whitespace and any non-alphanumeric noise the OCR adds.
  const cleaned = j.result.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length !== 6) {
    throw new Error(`TrueCaptcha returned ${cleaned.length} chars, expected 6: "${j.result}"`);
  }
  return cleaned;
}

const SYSTEM_PROMPT = [
  'You are an OCR model for a 6-character alphanumeric captcha image (~200x80 px).',
  'The image has random crossing lines for noise but the characters themselves are plain text — no warping or rotation.',
  "Be careful with case-sensitive look-alikes: 'I' vs 'l' vs '1', 'O' vs '0', 'B' vs '8', 'S' vs '5', 'Z' vs '2'. Lowercase letters render at lowercase x-height.",
  'Reply with EXACTLY 6 characters from [A-Za-z0-9]. No spaces, no punctuation, no preamble, no quotes, no explanation.',
].join('\n');

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — required for vision captcha solver');
  }
  _client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://registerkaro.in',
      'X-Title': process.env.OPENROUTER_TITLE ?? 'mca-filing-service captcha solver',
    },
  });
  return _client;
}

/**
 * Sends a captcha PNG (base64) to whichever solver is configured and returns the 6-character solution.
 *
 * Resolution order:
 *   1. TrueCaptcha (api.apitruecaptcha.org) when TRUECAPTCHA_USER + TRUECAPTCHA_KEY are set.
 *      ~95% accuracy on alphanumeric captchas, what the GST automation uses.
 *   2. OpenRouter vision model (default: google/gemini-2.5-flash) when OPENROUTER_API_KEY is set.
 *
 * Throws if neither is configured or both fail.
 */
export async function solveCaptchaWithVision(pngBase64: string): Promise<string> {
  // Primary: TrueCaptcha if configured
  if (process.env.TRUECAPTCHA_USER && process.env.TRUECAPTCHA_KEY) {
    try { return await solveCaptchaWithTrueCaptcha(pngBase64); }
    catch (e) {
      // Fall through to vision LLM if available; otherwise propagate
      if (!process.env.OPENROUTER_API_KEY) throw e;
      // eslint-disable-next-line no-console
      console.warn('[captcha] TrueCaptcha failed, falling back to vision LLM:', (e as Error).message);
    }
  }

  // Fallback: OpenRouter vision model
  const response = await client().chat.completions.create({
    model: MODEL,
    max_tokens: 32,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${pngBase64}` },
          },
          { type: 'text', text: 'Read the captcha and reply with exactly 6 characters.' },
        ],
      },
    ],
  });

  const text = (response.choices[0]?.message?.content ?? '')
    .toString()
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

  if (!/^[A-Za-z0-9]{6}$/.test(text)) {
    throw new Error(`captcha solver returned invalid output: ${JSON.stringify(text)}`);
  }
  return text;
}
