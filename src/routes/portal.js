const express = require('express');
const {
  isValidEmail, findUserByEmail, findUserById, createUser, verifyPassword,
  setResetToken, findUserByValidResetToken, resetPassword, countUsers,
  claimOrphanedEnvelopes, ensureFirstAdmin, requireAuth,
  emailTakenByAnotherUser, updateUserProfile
} = require('../auth');
const { sendMail } = require('../mailer');
const {
  welcomeEmail, resetPasswordLinkEmail, passwordChangedEmail, accountUpdatedEmail
} = require('../emailTemplates');

const router = express.Router();

const LOGO_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tkGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366F1"/>
      <stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="96" height="96" rx="24" fill="#12182B" stroke="url(#tkGrad)" stroke-width="2"/>
  <rect x="20" y="20" width="26" height="26" rx="8" fill="#EAEEF7" opacity="0.9"/>
  <rect x="54" y="20" width="26" height="26" rx="8" fill="url(#tkGrad)"/>
  <rect x="20" y="54" width="26" height="26" rx="8" fill="url(#tkGrad)" opacity="0.55"/>
  <rect x="54" y="54" width="26" height="26" rx="8" fill="#EAEEF7" opacity="0.9"/>
</svg>`;

const EYE_OPEN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Renders a password input with a show/hide eye-icon button. The toggle script
// lives once in shell() and wires up every .pw-toggle on the page — nothing
// page-specific needed beyond using this helper.
function passwordField(id, name, opts) {
  opts = opts || {};
  const extra = opts.minlength ? ` minlength="${opts.minlength}"` : '';
  const autofocus = opts.autofocus ? ' autofocus' : '';
  return `<div class="password-wrap">
    <input type="password" id="${id}" name="${name}" required${extra}${autofocus}>
    <button type="button" class="pw-toggle" data-target="${id}" aria-label="Show password">
      <span class="icon-eye">${EYE_OPEN}</span><span class="icon-eye-off" style="display:none;">${EYE_OFF}</span>
    </button>
  </div>`;
}

function shell(title, bodyInner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Toolkit AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/portal-assets/style.css">
  </head><body>
  <div class="bg-glow"></div><div class="bg-grid"></div>
  <div id="app">${bodyInner}</div>
  <script>
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.pw-toggle');
      if (!btn) return;
      var input = document.getElementById(btn.getAttribute('data-target'));
      if (!input) return;
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.querySelector('.icon-eye').style.display = showing ? '' : 'none';
      btn.querySelector('.icon-eye-off').style.display = showing ? 'none' : '';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  </script>
  </body></html>`;
}

function topbar(user) {
  return `<div class="topbar">
    <a href="/" class="brand">${LOGO_SVG(38)}<span class="brand-word">Toolkit AI</span></a>
    <div class="topbar-actions">
      ${user
        ? `${user.isAdmin ? '<a href="/admin" class="btn btn-ghost">Admin</a>' : ''}<a href="/profile" class="btn btn-ghost">Profile</a><span class="user-email">${escapeHtml(user.email)}</span><form method="POST" action="/logout" style="display:inline;"><button class="btn btn-ghost" type="submit">Sign out</button></form>`
        : `<a href="/login" class="btn btn-ghost">Sign in</a><a href="/signup" class="btn btn-primary">Sign up</a>`}
    </div></div>`;
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- landing page ----------
router.get('/', (req, res) => {
  const user = req.session && req.session.userId ? { email: req.session.userEmail, isAdmin: !!req.session.isAdmin } : null;
  let body = topbar(user);
  if (user) {
    body += `
    <div class="section-label">Your apps</div>
    <div class="app-grid">
      <a href="/sealwright/" class="app-tile">
        ${sealwrightIcon(44)}
        <h3>Sealwright</h3>
        <p>Multi-party electronic signatures</p>
      </a>
      <a href="/scanline/" class="app-tile">
        ${scanlineIcon(44)}
        <h3>Scanline</h3>
        <p>Scan documents, receipts &amp; IDs from your camera</p>
      </a>
      <div class="app-tile app-tile-soon">
        <span class="soon-badge">Coming soon</span>
        <h3>More tools</h3>
        <p>Additional apps will appear here as they launch.</p>
      </div>
    </div>`;
  } else {
    body += `
    <div class="hero">
      <h1>A <span class="accent-text">toolkit</span> of small,<br>focused apps.</h1>
      <p>One account, a growing set of tools — multi-party electronic signatures with Sealwright, and document scanning with Scanline.</p>
      <div class="hero-actions">
        <a href="/signup" class="btn btn-primary">Create an account</a>
        <a href="/login" class="btn btn-ghost">Sign in</a>
      </div>
    </div>`;
  }
  res.send(shell('Toolkit AI', body));
});

function sealwrightIcon(size) {
  return `<svg class="app-tile-icon" width="${size}" height="${size}" viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="waxg3" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#A8404B"/><stop offset="65%" stop-color="#8C2F39"/><stop offset="100%" stop-color="#6E232B"/>
    </radialGradient></defs>
    <path d="M50,4 C71,4 90,19 92,43 C94,66 79,89 51,94 C26,97 7,74 8,47 C9,21 29,4 50,4 Z" fill="url(#waxg3)"/>
    <g transform="translate(50,49) rotate(-18)">
      <path d="M-2,-30 C6,-30 11,-20 9,-8 L3,26 L-3,26 L-9,-8 C-11,-20 -8,-30 -2,-30 Z" fill="#F7F4EE" opacity="0.95"/>
    </g>
  </svg>`;
}

function scanlineIcon(size) {
  return `<svg class="app-tile-icon" width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="scanGradTile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F0B44E"/><stop offset="100%" stop-color="#C97F2B"/>
    </linearGradient></defs>
    <rect x="4" y="4" width="92" height="92" rx="20" fill="#1B1D22" stroke="url(#scanGradTile)" stroke-width="2"/>
    <path d="M26 32h48a4 4 0 0 1 4 4v34" fill="none" stroke="#4B4E58" stroke-width="3" stroke-linecap="round"/>
    <path d="M22 30 L22 66 A6 6 0 0 0 28 72 L72 72" fill="none" stroke="url(#scanGradTile)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="28" cy="30" r="3.5" fill="url(#scanGradTile)"/>
    <circle cx="72" cy="72" r="3.5" fill="url(#scanGradTile)"/>
    <line x1="34" y1="50" x2="66" y2="50" stroke="#F0B44E" stroke-width="3" stroke-linecap="round" opacity="0.9"/>
  </svg>`;
}

// ---------- signup ----------
router.get('/signup', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const q = req.query;
  res.send(shell('Sign up', `${topbar(null)}
    <div class="auth-shell"><div class="auth-card">
      <h2>Create your account</h2>
      <p class="sub">Get access to every app on Toolkit AI.</p>
      ${q.err ? `<div class="banner banner-error">${escapeHtml(q.err)}</div>` : ''}
      <form method="POST" action="/signup">
        <div class="field"><label>First name</label><input type="text" name="firstName" required autofocus value="${escapeHtml(q.firstName)}"></div>
        <div class="field"><label>Last name</label><input type="text" name="lastName" required value="${escapeHtml(q.lastName)}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" required value="${escapeHtml(q.email)}"></div>
        <div class="field"><label>Phone number</label><input type="tel" name="phone" required value="${escapeHtml(q.phone)}"></div>
        <div class="field"><label>Password</label>${passwordField('pw-signup', 'password', { minlength: 8 })}
          <div class="field-hint">At least 8 characters.</div>
        </div>
        <button class="btn btn-primary btn-block" type="submit">Create account</button>
      </form>
      <div class="auth-foot">Already have an account? <a class="link" href="/login">Sign in</a></div>
    </div></div>`));
});

router.post('/signup', express.urlencoded({ extended: false }), async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const phone = (req.body.phone || '').trim();
  const fail = (msg) => {
    const qs = new URLSearchParams({ err: msg, email, firstName, lastName, phone }).toString();
    res.redirect(`/signup?${qs}`);
  };
  if (!firstName) return fail('First name is required.');
  if (!lastName) return fail('Last name is required.');
  if (!isValidEmail(email)) return fail("That email address doesn't look valid.");
  if (!phone) return fail('Phone number is required.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  const existing = await findUserByEmail(email);
  if (existing) return fail('An account with that email already exists.');

  const user = await createUser(email, password, { firstName, lastName, phone });
  const total = await countUsers();
  if (total === 1) {
    // First account ever created inherits any envelopes made before multi-user
    // accounts existed — there's no ambiguity about whose they were.
    await claimOrphanedEnvelopes(user.id);
  }
  // No-op once an admin already exists; otherwise promotes whoever's oldest,
  // which on a brand-new deployment is the account that was just created.
  await ensureFirstAdmin();
  const fresh = await findUserByEmail(email);
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.isAdmin = fresh.is_admin;

  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const w = welcomeEmail({ firstName, email: user.email, loginUrl: base });
  sendMail({ to: user.email, subject: w.subject, text: w.text, html: w.html }).catch(e => console.error('welcome email failed', e.message));

  res.redirect('/');
});

// ---------- login ----------
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.send(shell('Sign in', `${topbar(null)}
    <div class="auth-shell"><div class="auth-card">
      <h2>Sign in</h2>
      <p class="sub">Welcome back to Toolkit AI.</p>
      ${req.query.err ? `<div class="banner banner-error">That email or password didn't match.</div>` : ''}
      ${req.query.reset ? `<div class="banner banner-success">Password updated — sign in with your new password.</div>` : ''}
      <form method="POST" action="/login">
        <div class="field"><label>Email</label><input type="email" name="email" required autofocus></div>
        <div class="field"><label>Password</label>${passwordField('pw-login', 'password')}</div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <div class="auth-foot">
        <a class="link" href="/forgot-password">Forgot your password?</a><br><br>
        Don't have an account? <a class="link" href="/signup">Sign up</a>
      </div>
    </div></div>`));
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const email = (req.body.email || '').trim();
  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
    return res.redirect('/login?err=1');
  }
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.isAdmin = user.is_admin;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- profile ----------
router.get('/profile', requireAuth, async (req, res) => {
  const user = await findUserById(req.session.userId);
  const q = req.query;
  res.send(shell('Your profile', `${topbar({ email: req.session.userEmail, isAdmin: !!req.session.isAdmin })}
    <div class="auth-shell"><div class="auth-card">
      <h2>Your profile</h2>
      <p class="sub">Update your account details.</p>
      ${q.err ? `<div class="banner banner-error">${escapeHtml(q.err)}</div>` : ''}
      ${q.saved ? `<div class="banner banner-success">Your profile has been updated.</div>` : ''}
      <form method="POST" action="/profile">
        <div class="field"><label>First name</label><input type="text" name="firstName" required value="${escapeHtml(q.firstName !== undefined ? q.firstName : user.first_name)}"></div>
        <div class="field"><label>Last name</label><input type="text" name="lastName" required value="${escapeHtml(q.lastName !== undefined ? q.lastName : user.last_name)}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" required value="${escapeHtml(q.email !== undefined ? q.email : user.email)}"></div>
        <div class="field"><label>Phone number</label><input type="tel" name="phone" required value="${escapeHtml(q.phone !== undefined ? q.phone : user.phone)}"></div>
        <button class="btn btn-primary btn-block" type="submit">Save changes</button>
      </form>
      <div class="auth-foot"><a class="link" href="/forgot-password">Change your password</a></div>
    </div></div>`));
});

router.post('/profile', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const firstName = (req.body.firstName || '').trim();
  const lastName = (req.body.lastName || '').trim();
  const email = (req.body.email || '').trim();
  const phone = (req.body.phone || '').trim();
  const fail = (msg) => {
    const qs = new URLSearchParams({ err: msg, firstName, lastName, email, phone }).toString();
    res.redirect(`/profile?${qs}`);
  };
  if (!firstName) return fail('First name is required.');
  if (!lastName) return fail('Last name is required.');
  if (!isValidEmail(email)) return fail("That email address doesn't look valid.");
  if (!phone) return fail('Phone number is required.');
  if (await emailTakenByAnotherUser(email, req.session.userId)) return fail('Another account already uses that email.');

  const before = await findUserById(req.session.userId);
  await updateUserProfile(req.session.userId, { firstName, lastName, email, phone });
  req.session.userEmail = email;

  const changes = [];
  if (before.email !== email) changes.push(`Email changed to ${email}`);
  if (before.phone !== phone) changes.push('Phone number updated');
  if (before.first_name !== firstName || before.last_name !== lastName) changes.push('Name updated');
  if (changes.length) {
    // Notify the address on file BEFORE the change — if email itself was the
    // thing that changed, this is what actually alerts the real account
    // owner even if someone changed it to an address they don't control.
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const n = accountUpdatedEmail({ firstName, changes, forgotPasswordUrl: `${base}/forgot-password` });
    sendMail({ to: before.email, subject: n.subject, text: n.text, html: n.html }).catch(e => console.error('account-updated email failed', e.message));
  }

  res.redirect('/profile?saved=1');
});

// ---------- forgot / reset password ----------
router.get('/forgot-password', (req, res) => {
  res.send(shell('Forgot password', `${topbar(null)}
    <div class="auth-shell"><div class="auth-card">
      <h2>Reset your password</h2>
      <p class="sub">We'll email you a link to set a new one.</p>
      ${req.query.sent ? `<div class="banner banner-success">If that email has an account, a reset link is on its way.</div>` : ''}
      <form method="POST" action="/forgot-password">
        <div class="field"><label>Email</label><input type="email" name="email" required autofocus></div>
        <button class="btn btn-primary btn-block" type="submit">Send reset link</button>
      </form>
      <div class="auth-foot"><a class="link" href="/login">Back to sign in</a></div>
    </div></div>`));
});

router.post('/forgot-password', express.urlencoded({ extended: false }), async (req, res) => {
  const email = (req.body.email || '').trim();
  const user = await findUserByEmail(email);
  // Always show the same response whether or not the account exists, so this
  // form can't be used to discover which emails are registered.
  if (user) {
    const token = await setResetToken(user.id);
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/reset-password/${token}`;
    const r = resetPasswordLinkEmail({ email: user.email, resetUrl: link });
    sendMail({ to: user.email, subject: r.subject, text: r.text, html: r.html }).catch(e => console.error('reset email failed', e.message));
  }
  res.redirect('/forgot-password?sent=1');
});

router.get('/reset-password/:token', async (req, res) => {
  const user = await findUserByValidResetToken(req.params.token);
  if (!user) {
    return res.send(shell('Reset password', `${topbar(null)}
      <div class="auth-shell"><div class="auth-card">
        <h2>Link expired</h2>
        <p class="sub">This password reset link is invalid or has expired.</p>
        <a class="btn btn-primary btn-block" href="/forgot-password">Request a new link</a>
      </div></div>`));
  }
  res.send(shell('Reset password', `${topbar(null)}
    <div class="auth-shell"><div class="auth-card">
      <h2>Set a new password</h2>
      <p class="sub">For ${escapeHtml(user.email)}</p>
      ${req.query.err ? `<div class="banner banner-error">${escapeHtml(req.query.err)}</div>` : ''}
      <form method="POST" action="/reset-password/${req.params.token}">
        <div class="field"><label>New password</label>${passwordField('pw-reset', 'password', { minlength: 8 })}</div>
        <button class="btn btn-primary btn-block" type="submit">Update password</button>
      </form>
    </div></div>`));
});

router.post('/reset-password/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const user = await findUserByValidResetToken(req.params.token);
  if (!user) return res.redirect('/forgot-password');
  const password = req.body.password || '';
  if (password.length < 8) {
    return res.redirect(`/reset-password/${req.params.token}?err=${encodeURIComponent('Password must be at least 8 characters.')}`);
  }
  await resetPassword(user.id, password);

  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const p = passwordChangedEmail({ firstName: user.first_name, forgotPasswordUrl: `${base}/forgot-password` });
  sendMail({ to: user.email, subject: p.subject, text: p.text, html: p.html }).catch(e => console.error('password-changed email failed', e.message));

  res.redirect('/login?reset=1');
});

module.exports = router;
