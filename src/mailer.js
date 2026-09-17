// Sends email through Resend's HTTPS API (https://api.resend.com/emails)
// instead of SMTP. This runs entirely over port 443 — the same port the app
// itself is already served on — which sidesteps a common VPS restriction
// where outbound SMTP-specific ports (465/587) are blocked by default to
// prevent spam-relay abuse, separately from general internet/DNS access.
//
// Re-uses the same SMTP_PASS and SMTP_FROM env vars that were already set
// (SMTP_PASS holds the Resend API key; SMTP_FROM is the "From" address) so
// no environment variables need to change to pick this up.

const RESEND_API_URL = 'https://api.resend.com/emails';

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : v;
}

function apiKey() {
  return env('RESEND_API_KEY') || env('SMTP_PASS');
}

/**
 * Sends an email if a Resend API key is configured; otherwise logs and
 * returns { sent:false }.
 * attachments: [{ filename, content (Buffer), contentType }]
 */
async function sendMail({ to, subject, text, html, attachments }) {
  const key = apiKey();
  const from = env('SMTP_FROM') || env('RESEND_FROM') || 'Sealwright <no-reply@example.com>';
  if (!key) {
    console.log(`[mailer] No Resend API key configured — would send to ${to}: ${subject}`);
    return { sent: false, reason: 'not-configured' };
  }

  const payload = { from, to: [to], subject };
  if (text) payload.text = text;
  if (html) payload.html = html;
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }));
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('[mailer] Resend API rejected the send:', res.status, bodyText);
      return { sent: false, reason: `${res.status}: ${bodyText}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Resend API request failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail };
