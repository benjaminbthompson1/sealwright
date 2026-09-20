const express = require('express');
const { requireAuth } = require('../auth');
const router = express.Router();

function shell(title, bodyInner, extraHead) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Sealwright</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=Dancing+Script:wght@500;700&family=Sacramento&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/sealwright/style.css">
  ${extraHead || ''}
  </head><body>${bodyInner}</body></html>`;
}

// Login/logout/signup now live on the Toolkit AI portal (src/routes/portal.js) —
// Sealwright itself no longer has its own separate login page. requireAuth
// (from ../auth) checks the same platform-wide session, so signing in once on
// the portal is enough to reach this dashboard.

router.get('/', requireAuth, (req, res) => {
  res.send(shell('Dashboard', `<div id="app"></div>`, `
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
    <script defer src="/sealwright/common.js"></script>
    <script defer src="/sealwright/dashboard.js"></script>`));
});

router.get('/sign/:token', (req, res) => {
  res.send(shell('Sign document', `<div id="app"></div>`, `
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
    <script defer src="/sealwright/common.js"></script>
    <script>window.SIGN_TOKEN=${JSON.stringify(req.params.token)};</script>
    <script defer src="/sealwright/sign.js"></script>`));
});

module.exports = router;
