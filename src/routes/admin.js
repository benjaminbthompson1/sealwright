const express = require('express');
const { requireAdmin, listAllUsers, deleteUser, findUserById, isValidEmail, emailTakenByAnotherUser, updateUserProfile } = require('../auth');
const { sendMail } = require('../mailer');
const { accountUpdatedEmail } = require('../emailTemplates');

const router = express.Router();

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; }
}

const LOGO_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="tkGradA" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#6366F1"/><stop offset="100%" stop-color="#22D3EE"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="96" height="96" rx="24" fill="#12182B" stroke="url(#tkGradA)" stroke-width="2"/>
  <rect x="20" y="20" width="26" height="26" rx="8" fill="#EAEEF7" opacity="0.9"/>
  <rect x="54" y="20" width="26" height="26" rx="8" fill="url(#tkGradA)"/>
  <rect x="20" y="54" width="26" height="26" rx="8" fill="url(#tkGradA)" opacity="0.55"/>
  <rect x="54" y="54" width="26" height="26" rx="8" fill="#EAEEF7" opacity="0.9"/>
</svg>`;

function shell(title, bodyInner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Toolkit AI Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/portal-assets/style.css">
  </head><body>
  <div class="bg-glow"></div><div class="bg-grid"></div>
  <div id="app">${bodyInner}</div>
  </body></html>`;
}

router.get('/', requireAdmin, async (req, res) => {
  const users = await listAllUsers();
  const rows = users.map(u => {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
    const isSelf = u.id === req.adminUser.id;
    return `<tr>
      <td>${escapeHtml(name)}${u.is_admin ? ' <span class="admin-badge">Admin</span>' : ''}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.phone) || '—'}</td>
      <td>${formatDateTime(u.created_at)}</td>
      <td>${u.envelope_count}</td>
      <td>
        <div style="display:flex; gap:8px; align-items:center;">
          <a class="btn btn-ghost btn-sm" href="/admin/users/${u.id}/edit">Edit</a>
          ${isSelf
            ? '<span class="faint">This is you</span>'
            : `<form method="POST" action="/admin/users/${u.id}/delete" onsubmit="return confirm('Delete the account for ${escapeHtml(name)} (${escapeHtml(u.email)})? This also deletes every envelope they own. This cannot be undone.');">
                 <button class="btn btn-danger btn-sm" type="submit">Delete</button>
               </form>`}
        </div>
      </td>
    </tr>`;
  }).join('');

  res.send(shell('Admin', `
    <div class="topbar">
      <a href="/" class="brand">${LOGO_SVG(38)}<span class="brand-word">Toolkit AI Admin</span></a>
      <div class="topbar-actions">
        <a href="/" class="btn btn-ghost">← Back to Toolkit AI</a>
        <form method="POST" action="/logout" style="display:inline;"><button class="btn btn-ghost" type="submit">Sign out</button></form>
      </div>
    </div>
    <div class="section-label">All accounts (${users.length})</div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Signed up</th><th>Envelopes</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `));
});

router.post('/users/:id/delete', requireAdmin, async (req, res) => {
  if (req.params.id === req.adminUser.id) {
    return res.status(400).send('You cannot delete your own account from here.');
  }
  const target = await findUserById(req.params.id);
  if (!target) return res.redirect('/admin');
  await deleteUser(req.params.id);
  console.log(`Admin ${req.adminUser.email} deleted user account: ${target.email}`);
  res.redirect('/admin');
});

router.get('/users/:id/edit', requireAdmin, async (req, res) => {
  const target = await findUserById(req.params.id);
  if (!target) return res.redirect('/admin');
  const q = req.query;
  res.send(shell('Edit user', `
    <div class="topbar">
      <a href="/" class="brand">${LOGO_SVG(38)}<span class="brand-word">Toolkit AI Admin</span></a>
      <div class="topbar-actions"><a href="/admin" class="btn btn-ghost">← All accounts</a></div>
    </div>
    <div class="auth-shell"><div class="auth-card">
      <h2>Edit account</h2>
      <p class="sub">${target.id === req.adminUser.id ? 'This is your own account.' : `Signed up ${formatDateTime(target.created_at)}`}</p>
      ${q.err ? `<div class="banner banner-error">${escapeHtml(q.err)}</div>` : ''}
      <form method="POST" action="/admin/users/${target.id}/edit">
        <div class="field"><label>First name</label><input type="text" name="firstName" required value="${escapeHtml(q.firstName !== undefined ? q.firstName : target.first_name)}"></div>
        <div class="field"><label>Last name</label><input type="text" name="lastName" required value="${escapeHtml(q.lastName !== undefined ? q.lastName : target.last_name)}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" required value="${escapeHtml(q.email !== undefined ? q.email : target.email)}"></div>
        <div class="field"><label>Phone number</label><input type="tel" name="phone" required value="${escapeHtml(q.phone !== undefined ? q.phone : target.phone)}"></div>
        <button class="btn btn-primary btn-block" type="submit">Save changes</button>
      </form>
    </div></div>
  `));
});

router.post('/users/:id/edit', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const email = (req.body.email || '').trim();
  const phone = (req.body.phone || '').trim();
  const fail = (msg) => {
    const qs = new URLSearchParams({ err: msg, firstName, lastName, email, phone }).toString();
    res.redirect(`/admin/users/${req.params.id}/edit?${qs}`);
  };
  const target = await findUserById(req.params.id);
  if (!target) return res.redirect('/admin');
  if (!firstName) return fail('First name is required.');
  if (!lastName) return fail('Last name is required.');
  if (!isValidEmail(email)) return fail("That email address doesn't look valid.");
  if (!phone) return fail('Phone number is required.');
  if (await emailTakenByAnotherUser(email, target.id)) return fail('Another account already uses that email.');

  await updateUserProfile(target.id, { firstName, lastName, email, phone });
  console.log(`Admin ${req.adminUser.email} updated user account: ${target.email} → ${email}`);

  const changes = [];
  if (target.email !== email) changes.push(`Email changed to ${email}`);
  if (target.phone !== phone) changes.push('Phone number updated');
  if (target.first_name !== firstName || target.last_name !== lastName) changes.push('Name updated');
  if (changes.length) {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const n = accountUpdatedEmail({ firstName, changes, forgotPasswordUrl: `${base}/forgot-password` });
    // Notify the address on file BEFORE this edit, same reasoning as the
    // self-service path: that's what actually reaches the real account
    // owner if email itself was the field that got changed.
    sendMail({ to: target.email, subject: n.subject, text: n.text, html: n.html }).catch(e => console.error('account-updated email failed', e.message));
  }

  res.redirect('/admin');
});

module.exports = router;
