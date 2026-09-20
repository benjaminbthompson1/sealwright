const express = require('express');
const {
  isValidEmail, findUserByEmail, createUser, verifyPassword,
  setResetToken, findUserByValidResetToken, resetPassword, countUsers, claimOrphanedEnvelopes
} = require('../auth');
const { sendMail } = require('../mailer');

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
  </body></html>`;
}

function topbar(user) {
  return `<div class="topbar">
    <a href="/" class="brand">${LOGO_SVG(38)}<span class="brand-word">Toolkit AI</span></a>
    <div class="topbar-actions">
      ${user
        ? `<span class="user-email">${escapeHtml(user.email)}</span><form method="POST" action="/logout" style="display:inline;"><button class="btn btn-ghost" type="submit">Sign out</button></form>`
        : `<a href="/login" class="btn btn-ghost">Sign in</a><a href="/signup" class="btn btn-primary">Sign up</a>`}
    </div></div>`;
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- landing page ----------
router.get('/', (req, res) => {
  const user = req.session && req.session.userId ? { email: req.session.userEmail } : null;
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
      <p>One account, a growing set of tools. First up: multi-party electronic signatures with Sealwright.</p>
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

// ---------- signup ----------
router.get('/signup', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.send(shell('Sign up', `${topbar(null)}
    <div class="auth-shell"><div class="auth-card">
      <h2>Create your account</h2>
      <p class="sub">Get access to every app on Toolkit AI.</p>
      ${req.query.err ? `<div class="banner banner-error">${escapeHtml(req.query.err)}</div>` : ''}
      <form method="POST" action="/signup">
        <div class="field"><label>Email</label><input type="email" name="email" required autofocus value="${escapeHtml(req.query.email)}"></div>
        <div class="field"><label>Password</label><input type="password" name="password" required minlength="8">
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
  const fail = (msg) => res.redirect(`/signup?err=${encodeURIComponent(msg)}&email=${encodeURIComponent(email)}`);
  if (!isValidEmail(email)) return fail("That email address doesn't look valid.");
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  const existing = await findUserByEmail(email);
  if (existing) return fail('An account with that email already exists.');

  const user = await createUser(email, password);
  const total = await countUsers();
  if (total === 1) {
    // First account ever created inherits any envelopes made before multi-user
    // accounts existed — there's no ambiguity about whose they were.
    await claimOrphanedEnvelopes(user.id);
  }
  req.session.userId = user.id;
  req.session.userEmail = user.email;
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
        <div class="field"><label>Password</label><input type="password" name="password" required></div>
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
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
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
    sendMail({
      to: user.email,
      subject: 'Reset your Toolkit AI password',
      text: `Reset your password: ${link} (expires in 1 hour)`,
      html: `<p>Click below to set a new password. This link expires in 1 hour.</p><p><a href="${link}">${link}</a></p>`
    }).catch(e => console.error('reset email failed', e.message));
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
        <div class="field"><label>New password</label><input type="password" name="password" required minlength="8"></div>
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
  res.redirect('/login?reset=1');
});

module.exports = router;
