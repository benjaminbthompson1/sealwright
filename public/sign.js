(function () {
  const { escapeHtml, formatDateTime, todayLabel, dataUrlToBlob, sealSvg, renderPdfPagesFromArrayBuffer } = window.Sealwright;
  const app = document.getElementById('app');
  const TOKEN = window.SIGN_TOKEN;

  let ctx = null; // context from server
  let activeMethod = 'draw', activeFont = "'Dancing Script', cursive", uploadedDataUrl = null;
  let padCtx = null, padHasInk = false, padDrawing = false;

  async function load() {
    try {
      const res = await fetch(`/api/sign/${TOKEN}/context`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'This link is invalid or has expired.'); }
      ctx = await res.json();
    } catch (e) {
      app.innerHTML = topbar() + `<div class="page-card"><div class="banner banner-warn">${escapeHtml(e.message)}</div></div>`;
      return;
    }
    render();
  }

  function topbar() {
    return `<div class="topbar"><div class="brand">${sealSvg(44)}<div class="brand-text"><h1>Sealwright</h1><div class="tag">Where agreements become official</div></div></div></div>`;
  }

  function render() {
    const env = ctx.envelope, you = ctx.you;
    const blocks = ctx.signers.map(s => {
      const isYou = s.id === you.id;
      let statusHtml;
      if (s.status === 'signed') statusHtml = `<span class="sig-status signed">Signed ${formatDateTime(s.signed_at)}</span>`;
      else if (isYou) statusHtml = `<span class="sig-status pending">${ctx.myTurn ? 'Your turn' : 'Waiting'}</span>`;
      else statusHtml = `<span class="sig-status waiting">Not yet signed</span>`;
      const sigImg = s.has_signature ? `<img class="sig-img" src="/api/envelopes/${env.id}/signers/${s.id}/signature?token=${TOKEN}">` : '';
      const inner = isYou && s.status !== 'signed'
        ? (ctx.myTurn ? signingPanelHtml(env, you) : `<p class="faint" style="margin-top:10px;">Waiting on an earlier signer before you can sign.</p>`)
        : '';
      return `<div class="sig-block ${isYou && s.status !== 'signed' ? 'is-active' : ''}" id="${isYou ? 'mySigBlock' : ''}">
        <div class="sig-block-head"><div class="sig-who"><div class="order-num">${s.order_index}</div>
        <div><div style="font-weight:600;">${escapeHtml(s.name)}${isYou ? ' (you)' : ''}</div><div class="faint">${escapeHtml(s.email)}</div></div></div>
        ${statusHtml}</div>${sigImg}${inner}</div>`;
    }).join('');

    app.innerHTML = `${topbar()}<div class="page-card">
      <h2 class="section-title">${escapeHtml(env.title)}</h2>
      <p class="faint" style="margin-bottom:18px;">Viewing as ${escapeHtml(you.name)}</p>
      <div class="doc-preview" id="signPreview"><div class="doc-fallback">Loading document…</div></div>
      <h3 style="margin-top:26px; font-size:16px;">Signature block</h3>
      <div class="sig-block-panel">${blocks}</div>
    </div>`;
    loadPreview(env);
    wirePanel(env, you);
  }

  async function loadPreview(env) {
    const el = document.getElementById('signPreview');
    try {
      if (env.source_type === 'pdf') {
        const buf = await (await fetch(`/api/envelopes/${env.id}/file?token=${TOKEN}`)).arrayBuffer();
        const imgs = await renderPdfPagesFromArrayBuffer(buf, 5);
        el.innerHTML = imgs.length ? imgs.map(s => `<img class="doc-page-img" src="${s}">`).join('') : `<div class="doc-fallback">📄 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'docx') {
        const buf = await (await fetch(`/api/envelopes/${env.id}/file?token=${TOKEN}`)).arrayBuffer();
        if (typeof mammoth !== 'undefined') { const r = await mammoth.convertToHtml({ arrayBuffer: buf }); el.innerHTML = `<div class="doc-html-preview">${r.value}</div>`; }
        else el.innerHTML = `<div class="doc-fallback">📝 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'image') {
        let html = '';
        for (let i = 0; i < env.page_count; i++) html += `<img class="doc-page-img" src="/api/envelopes/${env.id}/pages/${i}?token=${TOKEN}">`;
        el.innerHTML = html;
      }
    } catch (e) { el.innerHTML = `<div class="doc-fallback">Preview unavailable</div>`; }
  }

  function signingPanelHtml(env, you) {
    return `<div class="sign-method-tabs">
      <button class="tab-btn method-tab active" data-method="draw">Draw</button>
      <button class="tab-btn method-tab" data-method="type">Type</button>
      <button class="tab-btn method-tab" data-method="upload">Upload image</button>
    </div>
    <div class="method-panel" data-panel="draw"><canvas class="pad" id="sigCanvas" width="420" height="150"></canvas>
      <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" id="btnClearPad" type="button">Clear</button></div></div>
    <div class="method-panel" data-panel="type" style="display:none;">
      <div class="field"><input type="text" id="typedName" value="${escapeHtml(you.name)}" placeholder="Type your name"></div>
      <div class="typed-preview" id="typedPreview" style="font-family:'Dancing Script', cursive;">${escapeHtml(you.name)}</div>
      <div class="font-choice">
        <button class="btn btn-sm tab-btn active" data-font="'Dancing Script', cursive" type="button">Script 1</button>
        <button class="btn btn-sm tab-btn" data-font="'Sacramento', cursive" type="button">Script 2</button>
      </div>
    </div>
    <div class="method-panel" data-panel="upload" style="display:none;">
      <input type="file" id="sigUploadInput" accept="image/*" style="display:none">
      <button class="btn btn-ghost btn-sm" id="btnPickSigImage" type="button">Choose an image file</button>
      <div id="uploadedSigPreview" style="margin-top:10px;"></div>
    </div>
    <div class="consent"><input type="checkbox" id="consentChk">
      <span>I intend this as my electronic signature and agree it's legally binding for "${escapeHtml(env.title)}", signed on ${todayLabel()}.</span></div>
    <div id="signError" class="warn-text" style="display:none;"></div>
    <div style="margin-top:16px;"><button class="btn btn-primary" id="btnAdoptSign" disabled>Adopt &amp; sign</button></div>`;
  }

  function wirePanel(env, you) {
    activeMethod = 'draw'; padHasInk = false; uploadedDataUrl = null;
    const canvas = document.getElementById('sigCanvas');
    if (canvas) {
      padCtx = canvas.getContext('2d');
      padCtx.lineWidth = 2.2; padCtx.lineCap = 'round'; padCtx.strokeStyle = '#1C2B3A';
      function pos(e) {
        const r = canvas.getBoundingClientRect();
        const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
        return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
      }
      function start(e) { e.preventDefault(); padDrawing = true; const p = pos(e); padCtx.beginPath(); padCtx.moveTo(p.x, p.y); }
      function move(e) { if (!padDrawing) return; e.preventDefault(); const p = pos(e); padCtx.lineTo(p.x, p.y); padCtx.stroke(); padHasInk = true; updateEnabled(); }
      function end() { padDrawing = false; }
      canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
      canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
      const clearBtn = document.getElementById('btnClearPad');
      if (clearBtn) clearBtn.addEventListener('click', () => { padCtx.clearRect(0, 0, canvas.width, canvas.height); padHasInk = false; updateEnabled(); });
    }
    app.querySelectorAll('.method-tab').forEach(btn => btn.addEventListener('click', () => {
      const method = btn.getAttribute('data-method');
      if (method) {
        activeMethod = method;
        app.querySelectorAll('.method-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        app.querySelectorAll('.method-panel').forEach(p => p.style.display = (p.getAttribute('data-panel') === method) ? 'block' : 'none');
        updateEnabled();
      }
      const font = btn.getAttribute('data-font');
      if (font) {
        activeFont = font;
        app.querySelectorAll('[data-font]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tp = document.getElementById('typedPreview'); if (tp) tp.style.fontFamily = font;
      }
    }));
    const typedName = document.getElementById('typedName');
    if (typedName) typedName.addEventListener('input', e => { document.getElementById('typedPreview').textContent = e.target.value; updateEnabled(); });
    const btnPick = document.getElementById('btnPickSigImage');
    const sigUploadInput = document.getElementById('sigUploadInput');
    if (btnPick) btnPick.addEventListener('click', () => sigUploadInput.click());
    if (sigUploadInput) sigUploadInput.onchange = async (e) => {
      if (e.target.files[0]) {
        const raw = await window.Sealwright.readFileAsDataURL(e.target.files[0]);
        uploadedDataUrl = await window.Sealwright.downscaleImage(raw, 500);
        document.getElementById('uploadedSigPreview').innerHTML = `<img class="sig-img" src="${uploadedDataUrl}">`;
        updateEnabled();
      }
    };
    const consentChk = document.getElementById('consentChk');
    if (consentChk) consentChk.addEventListener('change', updateEnabled);
    const btnAdopt = document.getElementById('btnAdoptSign');
    if (btnAdopt) btnAdopt.addEventListener('click', () => submitSignature(env, you));

    function updateEnabled() {
      const consent = document.getElementById('consentChk') && document.getElementById('consentChk').checked;
      let ready = false;
      if (activeMethod === 'draw') ready = padHasInk;
      else if (activeMethod === 'type') ready = !!(document.getElementById('typedName') && document.getElementById('typedName').value.trim());
      else if (activeMethod === 'upload') ready = !!uploadedDataUrl;
      const btn = document.getElementById('btnAdoptSign');
      if (btn) btn.disabled = !(ready && consent);
    }
  }

  function renderTypedSignatureImage(text, font) {
    const canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = 150;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#1C2B3A'; c.font = `52px ${font}`; c.textBaseline = 'middle';
    c.fillText(text, 16, canvas.height / 2);
    return canvas.toDataURL('image/png');
  }

  async function submitSignature(env, you) {
    const btn = document.getElementById('btnAdoptSign');
    btn.disabled = true; btn.textContent = 'Signing…';
    let blob, method;
    try {
      if (activeMethod === 'draw') {
        method = 'drawn';
        blob = await new Promise(resolve => document.getElementById('sigCanvas').toBlob(resolve, 'image/png'));
      } else if (activeMethod === 'type') {
        method = 'typed';
        const text = document.getElementById('typedName').value.trim();
        try { await document.fonts.load(`52px ${activeFont}`); } catch (e) {}
        blob = dataUrlToBlob(renderTypedSignatureImage(text, activeFont));
      } else if (activeMethod === 'upload') {
        method = 'uploaded image';
        blob = dataUrlToBlob(uploadedDataUrl);
      }
      const fd = new FormData();
      fd.append('signature', blob, 'signature.png');
      fd.append('method', method);
      fd.append('consent', 'true');
      const res = await fetch(`/api/sign/${TOKEN}`, { method: 'POST', body: fd });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not record your signature.'); }
      const result = await res.json();
      if (result.allSigned) showSealed(env);
      else { await load(); }
    } catch (e) {
      const errBox = document.getElementById('signError');
      if (errBox) { errBox.textContent = e.message; errBox.style.display = 'block'; }
      btn.disabled = false; btn.textContent = 'Adopt & sign';
    }
  }

  function showSealed(env) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal"><div class="seal-reveal">
      <div class="stamp-anim">${sealSvg(90)}</div><h2 style="margin-top:6px;">Sealed</h2>
      <p class="muted" style="text-align:center;">Every party has signed "${escapeHtml(env.title)}". You'll receive a confirmation email with the executed document.</p>
      <div style="display:flex; gap:10px; margin-top:10px;"><button class="btn btn-primary btn-sm" id="btnClose">Close</button></div>
    </div></div>`;
    document.body.appendChild(overlay);
    document.getElementById('btnClose').addEventListener('click', () => { document.body.removeChild(overlay); load(); });
  }

  load();
})();
