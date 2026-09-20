// Shared branded HTML email layout + individual templates for every email
// Toolkit AI sends. Uses a table-based layout with inline styles throughout —
// not flexbox/grid, not a <style> block — because that's what actually
// renders consistently across real email clients (Outlook in particular
// renders HTML email with Word's engine and ignores most modern CSS).

const BRAND = '#4F46E5';
const TEXT = '#1F2430';
const MUTED = '#6B7280';
const BG = '#F3F4F8';
const BORDER = '#EAEAF0';
const FONT = "Arial, Helvetica, sans-serif";

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout({ preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
</head>
<body style="margin:0; padding:0; background-color:${BG};">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">${escapeHtml(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px; max-width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid ${BORDER};">
        <tr>
          <td style="background-color:${BRAND}; padding:26px 40px;">
            <span style="font-family:${FONT}; font-size:20px; font-weight:bold; color:#ffffff; letter-spacing:-0.3px;">Toolkit AI</span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 8px; font-family:${FONT}; color:${TEXT}; font-size:15px; line-height:1.65;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${BORDER}; padding-top:20px; font-family:${FONT}; font-size:12px; color:${MUTED};">
              Sent by Toolkit AI
            </td></tr></table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr>
    <td style="border-radius:8px; background-color:${BRAND};">
      <a href="${url}" style="display:inline-block; padding:12px 28px; font-family:${FONT}; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:8px;">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

function fingerprintBlock(fingerprint) {
  if (!fingerprint) return '';
  return `<p style="font-family:${FONT}; font-size:12px; color:${MUTED}; margin:18px 0 0;">Document fingerprint (SHA-256), for your records:<br>
    <span style="font-family:'Courier New',monospace; font-size:11px; word-break:break-all;">${escapeHtml(fingerprint)}</span></p>`;
}

function greetName(firstName) {
  return firstName ? escapeHtml(firstName) : 'there';
}

// ---------- 1. Welcome / signup confirmation ----------
function welcomeEmail({ firstName, email, loginUrl }) {
  const subject = 'Welcome to Toolkit AI';
  const html = layout({
    preheader: `Your Toolkit AI account is ready — sign in with ${email}`,
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${greetName(firstName)},</p>
      <p style="margin:0 0 16px;">Your Toolkit AI account has been created. You can sign in anytime with:</p>
      <p style="margin:0 0 16px; font-weight:bold;">${escapeHtml(email)}</p>
      ${button(loginUrl, 'Go to Toolkit AI')}
      <p style="margin:20px 0 0; font-size:13px; color:${MUTED};">If you didn't create this account, you can safely ignore this email.</p>
    `
  });
  const text = `Hi ${firstName || 'there'},\n\nYour Toolkit AI account has been created. You can sign in anytime with: ${email}\n\n${loginUrl}\n\nIf you didn't create this account, you can safely ignore this email.`;
  return { subject, html, text };
}

// ---------- 2. Signature request ----------
function signRequestEmail({ signerName, envelopeTitle, senderName, signUrl }) {
  const subject = `${senderName ? senderName + ' has' : "You've been"} requested to sign: ${envelopeTitle}`;
  const requester = senderName ? escapeHtml(senderName) : 'Someone';
  const html = layout({
    preheader: `${requester} sent you "${envelopeTitle}" to review and sign`,
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${greetName(signerName)},</p>
      <p style="margin:0 0 16px;">${requester} has asked you to review and sign <strong>${escapeHtml(envelopeTitle)}</strong>.</p>
      ${button(signUrl, 'Review & Sign')}
      <p style="margin:20px 0 0; font-size:13px; color:${MUTED};">This link is unique to you — please don't forward it to anyone else.</p>
    `
  });
  const text = `Hi ${signerName || 'there'},\n\n${senderName || 'Someone'} has asked you to review and sign "${envelopeTitle}".\n\nOpen and sign here: ${signUrl}\n\nThis link is unique to you — please don't forward it.`;
  return { subject, html, text };
}

// ---------- 3. Document executed / complete ----------
function completionEmail({ signerName, envelopeTitle, fingerprint }) {
  const subject = `Completed: ${envelopeTitle}`;
  const html = layout({
    preheader: `All parties have signed "${envelopeTitle}" — the executed document is attached`,
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${greetName(signerName)},</p>
      <p style="margin:0 0 16px;">All parties have signed <strong>${escapeHtml(envelopeTitle)}</strong>. The fully executed document is attached to this email.</p>
      ${fingerprintBlock(fingerprint)}
    `
  });
  const text = `Hi ${signerName || 'there'},\n\nAll parties have signed "${envelopeTitle}". The fully executed document is attached.` + (fingerprint ? `\n\nDocument fingerprint (SHA-256): ${fingerprint}` : '');
  return { subject, html, text };
}

// ---------- 4. Password reset link ----------
function resetPasswordLinkEmail({ email, resetUrl }) {
  const subject = 'Reset your Toolkit AI password';
  const html = layout({
    preheader: 'Use this link to set a new password — expires in 1 hour',
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi there,</p>
      <p style="margin:0 0 16px;">We received a request to reset the password for <strong>${escapeHtml(email)}</strong>. Click below to set a new one — this link expires in 1 hour.</p>
      ${button(resetUrl, 'Set a new password')}
      <p style="margin:20px 0 0; font-size:13px; color:${MUTED};">If you didn't request this, you can safely ignore this email — your password won't change unless you click the link above and set a new one.</p>
    `
  });
  const text = `We received a request to reset the password for ${email}.\n\nSet a new password here (expires in 1 hour): ${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`;
  return { subject, html, text };
}

// ---------- 5. Password changed confirmation ----------
function passwordChangedEmail({ firstName, forgotPasswordUrl }) {
  const subject = 'Your Toolkit AI password was changed';
  const html = layout({
    preheader: 'This confirms your password was just changed',
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${greetName(firstName)},</p>
      <p style="margin:0 0 16px;">This confirms the password on your Toolkit AI account was just changed.</p>
      <p style="margin:0; font-size:13px; color:${MUTED};">If you didn't make this change, <a href="${forgotPasswordUrl}" style="color:${BRAND};">reset your password</a> right away.</p>
    `
  });
  const text = `Hi ${firstName || 'there'},\n\nThis confirms the password on your Toolkit AI account was just changed.\n\nIf you didn't make this change, reset your password right away: ${forgotPasswordUrl}`;
  return { subject, html, text };
}

// ---------- 6. Account details updated ----------
function accountUpdatedEmail({ firstName, changes, forgotPasswordUrl }) {
  const subject = 'Your Toolkit AI account details were updated';
  const list = changes.map(c => `<li style="margin:0 0 6px;">${escapeHtml(c)}</li>`).join('');
  const html = layout({
    preheader: 'Your account details were just updated',
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${greetName(firstName)},</p>
      <p style="margin:0 0 12px;">The following changes were just made to your Toolkit AI account:</p>
      <ul style="margin:0 0 16px; padding-left:20px;">${list}</ul>
      <p style="margin:0; font-size:13px; color:${MUTED};">If you didn't make these changes, <a href="${forgotPasswordUrl}" style="color:${BRAND};">reset your password</a> immediately.</p>
    `
  });
  const text = `Hi ${firstName || 'there'},\n\nThe following changes were just made to your Toolkit AI account:\n${changes.map(c => '- ' + c).join('\n')}\n\nIf you didn't make these changes, reset your password immediately: ${forgotPasswordUrl}`;
  return { subject, html, text };
}

module.exports = {
  welcomeEmail, signRequestEmail, completionEmail,
  resetPasswordLinkEmail, passwordChangedEmail, accountUpdatedEmail
};
