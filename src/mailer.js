const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
  return transporter;
}

/**
 * Sends an email if SMTP is configured; otherwise logs and returns { sent:false }.
 * attachments: [{ filename, content (Buffer), contentType }]
 */
async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  const from = process.env.SMTP_FROM || 'Sealwright <no-reply@example.com>';
  if (!t) {
    console.log(`[mailer] SMTP not configured — would send to ${to}: ${subject}`);
    return { sent: false, reason: 'smtp-not-configured' };
  }
  try {
    await t.sendMail({ from, to, subject, text, html, attachments });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail };
