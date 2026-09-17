const nodemailer = require('nodemailer');

// Dokploy's environment box is a plain multi-line text field — a stray trailing
// space or an accidental line break silently copied in from a password manager
// turns "smtp.resend.com" into a different, non-existent hostname. Trim every
// SMTP value defensively so that class of bug can't happen again.
function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : v;
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const host = env('SMTP_HOST');
  if (!host) return null;
  const port = Number(env('SMTP_PORT') || 587);
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined
  });
  return transporter;
}

/**
 * Sends an email if SMTP is configured; otherwise logs and returns { sent:false }.
 * attachments: [{ filename, content (Buffer), contentType }]
 */
async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  const from = env('SMTP_FROM') || 'Sealwright <no-reply@example.com>';
  if (!t) {
    console.log(`[mailer] SMTP not configured — would send to ${to}: ${subject}`);
    return { sent: false, reason: 'smtp-not-configured' };
  }
  try {
    await t.sendMail({ from, to, subject, text, html, attachments });
    return { sent: true };
  } catch (err) {
    // Log the exact host/port as JSON so any invisible whitespace or stray
    // characters show up as visible escape sequences (e.g. "smtp.resend.com\n")
    // instead of being silently swallowed by the log viewer.
    console.error('[mailer] send failed', err.message, 'host:', JSON.stringify(env('SMTP_HOST')), 'port:', JSON.stringify(env('SMTP_PORT')));
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail };
