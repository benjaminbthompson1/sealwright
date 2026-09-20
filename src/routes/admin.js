const express = require('express');
const { requireAdmin, listAllUsers, deleteUser, findUserById } = require('../auth');

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
      <td>${isSelf
        ? '<span class="faint">This is you</span>'
        : `<form method="POST" action="/admin/users/${u.id}/delete" onsubmit="return confirm('Delete the account for ${escapeHtml(name)} (${escapeHtml(u.email)})? This also deletes every envelope they own. This cannot be undone.');">
             <button class="btn btn-danger btn-sm" type="submit">Delete</button>
           </form>`}
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

module.exports = router;
