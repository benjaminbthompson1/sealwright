// Runs OCR/summarization for scanned pages through the Claude API
// (https://api.anthropic.com/v1/messages). Mirrors mailer.js: reads its key
// from an env var, and if that key isn't set, returns a clear "not
// configured" result instead of throwing — so a deployment without AI
// features configured still runs fine; the Scanline UI just hides those
// buttons.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : v;
}

function apiKey() {
  return env('ANTHROPIC_API_KEY');
}

function isConfigured() {
  return !!apiKey();
}

function model() {
  return env('ANTHROPIC_MODEL') || 'claude-sonnet-5';
}

// pages: [{ image_bytes: Buffer, mime_type: string }], in document order.
// Sends at most 10 pages per call to keep the request a reasonable size.
async function askAboutPages(pages, promptText) {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'not-configured' };
  const use = pages.slice(0, 10);
  if (!use.length) return { ok: false, reason: 'no-pages' };

  const content = use.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mime_type || 'image/jpeg', data: p.image_bytes.toString('base64') }
  }));
  content.push({ type: 'text', text: promptText });

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model(),
        max_tokens: 2000,
        messages: [{ role: 'user', content }]
      })
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('[scanline-ocr] Claude API rejected the request:', res.status, bodyText);
      return { ok: false, reason: `${res.status}: ${bodyText}` };
    }
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) return { ok: false, reason: 'empty-response' };
    return { ok: true, text, truncatedPages: pages.length > use.length };
  } catch (err) {
    console.error('[scanline-ocr] Claude API request failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

function extractText(pages) {
  return askAboutPages(pages,
    `These ${Math.min(pages.length, 10)} image(s) are pages of a scanned document, in order. ` +
    `Transcribe all legible text exactly as it appears, page by page, using "--- Page N ---" headers ` +
    `between pages. If a page has no legible text, write "(no legible text)" for that page. ` +
    `Output plain text only, no commentary.`);
}

function summarize(pages) {
  return askAboutPages(pages,
    `These ${Math.min(pages.length, 10)} image(s) are pages of a scanned document, in order. Write a concise ` +
    `summary: 1) a one-sentence overview of what the document is, 2) 3-6 bullet points of key details ` +
    `(names, dates, amounts, key facts actually visible in the images — do not invent any), 3) note if ` +
    `anything is illegible or cut off. Plain text only.`);
}

module.exports = { isConfigured, extractText, summarize };
