const express = require('express');
const { checkPassword, requireAuth } = require('../auth');
const router = express.Router();

const SEAL_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="waxg" cx="35%" cy="30%" r="75%">
    <stop offset="0%" stop-color="#A8404B"/><stop offset="65%" stop-color="#8C2F39"/><stop offset="100%" stop-color="#6E232B"/>
  </radialGradient></defs>
  <path d="M22,86 L30,102 L38,88 Z" fill="#A9803F"/>
  <path d="M78,86 L70,102 L62,88 Z" fill="#A9803F"/>
  <path d="M50,4 C71,4 90,19 92,43 C94,66 79,89 51,94 C26,97 7,74 8,47 C9,21 29,4 50,4 Z" fill="url(#waxg)"/>
  <g transform="translate(50,49) rotate(-18)">
    <path d="M-2,-30 C6,-30 11,-20 9,-8 L3,26 L-3,26 L-9,-8 C-11,-20 -8,-30 -2,-30 Z" fill="#F7F4EE" opacity="0.95"/>
    <line x1="0" y1="-6" x2="0" y2="26" stroke="#8C2F39" stroke-width="1.4"/>
  </g>
  <circle cx="50" cy="49" r="34" fill="none" stroke="#F7F4EE" stroke-width="1.1" opacity="0.55"/>
</svg>`;

function shell(title, bodyInner, extraHead) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Sealwright</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=Dancing+Script:wght@500;700&family=Sacramento&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  ${extraHead || ''}
  </head><body>${bodyInner}</body></html>`;
}

router.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  const err = req.query.err ? `<div class="banner banner-warn">That password didn't match.</div>` : '';
  res.send(shell('Sign in', `
    <div id="app"><div class="page-card" style="max-width:380px; margin:80px auto;">
      <div style="text-align:center; margin-bottom:18px;">${SEAL_SVG(56)}<h1 style="margin-top:8px;">Sealwright</h1><p class="muted">Where agreements become official</p></div>
      ${err}
      <form method="POST" action="/login">
        <div class="field"><label>Password</label><input type="password" name="password" autofocus required></div>
        <button class="btn btn-primary" type="submit" style="width:100%;">Sign in</button>
      </form>
    </div></div>`));
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (checkPassword(req.body.password)) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?err=1');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/', requireAuth, (req, res) => {
  res.send(shell('Dashboard', `<div id="app"></div>`, `
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
    <script src="/common.js"></script>
    <script src="/dashboard.js"></script>`));
});

router.get('/sign/:token', (req, res) => {
  res.send(shell('Sign document', `<div id="app"></div>`, `
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
    <script src="/common.js"></script>
    <script>window.SIGN_TOKEN=${JSON.stringify(req.params.token)};</script>
    <script src="/sign.js"></script>`));
});

module.exports = router;
