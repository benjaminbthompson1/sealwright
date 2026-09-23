const express = require('express');
const { requireAuth } = require('../auth');
const { isConfigured: aiConfigured } = require('../scanline-ocr');
const router = express.Router();

function shell(title, bodyInner, extraHead) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${title} — Scanline</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/scanline/style.css">
  ${extraHead || ''}
  </head><body>${bodyInner}</body></html>`;
}

// Login/logout/signup live on the Toolkit AI portal (src/routes/portal.js) —
// Scanline has no login page of its own. requireAuth checks the same
// platform-wide session, so signing in once on the portal is enough to reach
// this dashboard too.
router.get('/', requireAuth, (req, res) => {
  res.send(shell('Scans', `<div id="app"></div>`, `
    <script>window.SCANLINE_AI_CONFIGURED = ${aiConfigured() ? 'true' : 'false'};</script>
    <script defer src="/scanline/common.js"></script>
    <script defer src="/scanline/dashboard.js"></script>`));
});

module.exports = router;
