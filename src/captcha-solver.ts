import OpenAI from 'openai';

const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash';

/**
 * 2Captcha (2captcha.com) — primary solver. Human-backed, ~95%+ accuracy on these
 * distorted-character captchas. Needs APIKEY_2CAPTCHA env var (set in `.env`).
 *
 * Uses the classic in.php/res.php HTTP API directly (no SDK dependency): submit the
 * base64 PNG, then poll res.php until the worker returns the text. MCA's captcha is 6
 * alphanumeric chars, so we don't constrain to numeric.
 */
async function solveCaptchaWith2Captcha(pngBase64: string): Promise<string> {
  const apikey = process.env.APIKEY_2CAPTCHA;
  if (!apikey) throw new Error('APIKEY_2CAPTCHA not set');

  // Submit
  const inResp = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: apikey, method: 'base64', body: pngBase64, json: '1' }),
  });
  if (!inResp.ok) throw new Error(`2Captcha in.php: HTTP ${inResp.status} ${inResp.statusText}`);
  const inJson = await inResp.json() as { status: number; request: string };
  if (inJson.status !== 1) throw new Error(`2Captcha submit failed: ${inJson.request}`);
  const id = inJson.request;

  // Poll (2captcha needs ~5-20s; cap at ~120s)
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(
      `https://2captcha.com/res.php?key=${apikey}&action=get&id=${id}&json=1`,
    );
    const j = await res.json() as { status: number; request: string };
    if (j.status === 1) {
      const cleaned = j.request.replace(/[^A-Za-z0-9]/g, '');
      if (cleaned.length !== 6) {
        throw new Error(`2Captcha returned ${cleaned.length} chars, expected 6: "${j.request}"`);
      }
      return cleaned;
    }
    if (j.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha poll failed: ${j.request}`);
  }
  throw new Error('2Captcha: timed out waiting for result');
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
 *   1. 2Captcha (2captcha.com) when APIKEY_2CAPTCHA is set.
 *      Human-backed, ~95%+ accuracy on alphanumeric captchas.
 *   2. OpenRouter vision model (default: google/gemini-2.5-flash) when OPENROUTER_API_KEY is set.
 *
 * Throws if neither is configured or both fail.
 */
export async function solveCaptchaWithVision(pngBase64: string): Promise<string> {
  // Primary: 2Captcha if configured
  if (process.env.APIKEY_2CAPTCHA) {
    try { return await solveCaptchaWith2Captcha(pngBase64); }
    catch (e) {
      // Fall through to vision LLM if available; otherwise propagate
      if (!process.env.OPENROUTER_API_KEY) throw e;
      // eslint-disable-next-line no-console
      console.warn('[captcha] 2Captcha failed, falling back to vision LLM:', (e as Error).message);
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
