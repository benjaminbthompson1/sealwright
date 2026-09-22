(function () {
  const { escapeHtml, formatDateTime, downscaleImage, readFileAsArrayBuffer, sealSvg, api, renderPdfPagesFromArrayBuffer } = window.Sealwright;
  const app = document.getElementById('app');

  const STATE = { screen: 'list', envelopes: [], draft: null, currentId: null };

  function blankDraft() {
    return { title: '', sourceType: null, fileName: '', docFile: null, pageFiles: [], previewImages: [], htmlPreview: null, signers: [], sequential: true, _uploadTab: 'file', prepareFields: false };
  }

  function topbar() {
    return `<div class="topbar">
      <div class="brand" data-nav="list">${sealSvg(44)}<div class="brand-text"><h1>Sealwright</h1><div class="tag">Where agreements become official</div></div></div>
      <div class="topbar-actions">
        <a class="btn btn-ghost btn-sm" href="/">← Toolkit AI</a>
        ${STATE.screen !== 'list' ? '<button class="btn btn-ghost btn-sm" data-nav="list">All envelopes</button>' : ''}
        <button class="btn btn-primary btn-sm" data-nav="new">New envelope</button>
        <form method="POST" action="/logout" style="display:inline;"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
      </div></div>`;
  }

  function stepRail(activeIdx) {
    const steps = ['Upload document', 'Add signers', 'Review & send'];
    const items = steps.map((label, i) => {
      let cls = 'rail-step'; if (i < activeIdx) cls += ' done'; if (i === activeIdx) cls += ' active';
      return `<div class="${cls}"><div class="rail-num">${i < activeIdx ? '✓' : i + 1}</div><div class="rail-label">${label}</div></div>`;
    }).join('');
    return `<div class="rail">${items}</div><div class="rail-mobile">${items}</div>`;
  }

  async function render() {
    let html = topbar();
    if (STATE.screen === 'list') html += await renderList();
    else if (STATE.screen === 'new-upload') html += renderNewUpload();
    else if (STATE.screen === 'new-signers') html += renderNewSigners();
    else if (STATE.screen === 'new-review') html += renderNewReview();
    else if (STATE.screen === 'field-editor') html += await renderFieldEditor();
    else if (STATE.screen === 'detail') html += await renderDetail();
    app.innerHTML = html;
    wireGlobal();
    if (STATE.screen === 'new-upload') wireUpload();
    if (STATE.screen === 'new-signers') wireSigners();
    if (STATE.screen === 'new-review') wireReview();
    if (STATE.screen === 'field-editor') wireFieldEditor();
    if (STATE.screen === 'detail') wireDetail();
  }

  function wireGlobal() {
    app.querySelectorAll('[data-nav="list"]').forEach(el => el.addEventListener('click', () => { STATE.screen = 'list'; render(); }));
    app.querySelectorAll('[data-nav="new"]').forEach(el => el.addEventListener('click', () => { STATE.draft = blankDraft(); STATE.screen = 'new-upload'; render(); }));
  }

  async function renderList() {
    try { STATE.envelopes = await api('/sealwright/api/envelopes'); } catch (e) { return `<p class="banner banner-warn">Could not load envelopes: ${escapeHtml(e.message)}</p>`; }
    if (!STATE.envelopes.length) {
      return `<div class="empty-state">${sealSvg(60)}<h2 style="margin-top:14px;">No envelopes yet</h2>
        <p class="muted" style="max-width:420px; margin:0 auto 20px;">Upload a document, add the people who need to sign it, and Sealwright will route it to each of them in order.</p>
        <button class="btn btn-primary" data-nav="new">Create your first envelope</button></div>`;
    }
    const rows = STATE.envelopes.map(env => {
      const signedCount = env.signers.filter(s => s.status === 'signed').length;
      const dots = env.signers.map((s, i) => {
        let cls = 'dot'; if (s.status === 'signed') cls += ' signed'; else if (env.sequential && s.order_index === env.current_turn_index) cls += ' turn';
        return `<span class="${cls}" title="${escapeHtml(s.name)}"></span>`;
      }).join('');
      let badge;
      if (env.status === 'completed') badge = '<span class="badge badge-done">Completed</span>';
      else if (env.status === 'cancelled') badge = '<span class="badge" style="background:#EFEAE0; color:var(--ink-faint);">Cancelled</span>';
      else if (env.status === 'preparing') badge = '<span class="badge badge-progress">Draft — placing fields</span>';
      else badge = '<span class="badge badge-progress">In progress</span>';
      const recipientBadge = env.is_owner === false ? '<span class="badge" style="background:var(--brass-tint); color:var(--brass);">Sent to you</span>' : '';
      const cancelBtn = (env.is_owner && (env.status === 'sent' || env.status === 'preparing'))
        ? `<button class="btn btn-ghost btn-sm row-action-btn" data-action="cancel" data-id="${env.id}" data-title="${escapeHtml(env.title)}">Cancel</button>` : '';
      const deleteBtn = env.is_owner
        ? `<button class="btn btn-danger btn-sm row-action-btn" data-action="delete" data-id="${env.id}" data-title="${escapeHtml(env.title)}">Delete</button>` : '';
      return `<div class="env-row" data-id="${env.id}">
        <div class="env-row-main"><h3>${escapeHtml(env.title)}</h3>
          <div class="faint">${env.signers.length} signer${env.signers.length === 1 ? '' : 's'} · created ${formatDateTime(env.created_at)}</div>
          <div class="env-progress">${dots}<span class="faint" style="margin-left:6px;">${signedCount}/${env.signers.length} signed</span></div>
        </div><div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">${recipientBadge}${badge}${cancelBtn}${deleteBtn}</div></div>`;
    }).join('');
    return `<div class="env-list">${rows}</div>`;
  }

  // ---------------- upload step ----------------
  function renderNewUpload() {
    const d = STATE.draft;
    let body;
    if (d.sourceType) {
      body = renderDraftPreview(d);
    } else {
      const tab = d._uploadTab;
      body = `<div class="upload-tabs">
        <button class="tab-btn ${tab === 'file' ? 'active' : ''}" data-tab="file">PDF or Word file</button>
        <button class="tab-btn ${tab === 'photo' ? 'active' : ''}" data-tab="photo">Take a photo</button>
      </div>
      ${tab === 'file' ? `
        <div class="dropzone" id="dropzone"><p style="margin:0 0 12px;">Drag a PDF or Word document here</p>
          <button class="btn btn-primary btn-sm" id="btnChooseFile">Choose a file</button>
          <p class="faint" style="margin-top:12px;">Accepted: .pdf, .doc, .docx</p></div>
      ` : `
        <div class="dropzone"><p style="margin:0 0 12px;">Use your camera to capture a paper document, or upload a photo already on your device.</p>
          <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="btnTakePhoto">Take a photo</button>
            <button class="btn btn-ghost btn-sm" id="btnUploadPhoto">Upload a photo</button>
          </div><p class="faint" style="margin-top:12px;">You can add more pages once the first photo is in.</p></div>
      `}`;
    }
    return `<div class="shell">${stepRail(0)}<div class="page-card">
      <h2 class="section-title">Upload the document</h2>
      <p class="muted" style="margin-bottom:20px;">This is the document your signers will review and sign.</p>
      ${body}
      <input type="file" id="fInputDoc" accept="application/pdf,.doc,.docx" style="display:none">
      <input type="file" id="fInputImg" accept="image/*" style="display:none">
      <input type="file" id="fInputCam" accept="image/*" capture="environment" style="display:none">
    </div></div>`;
  }

  function renderDraftPreview(d) {
    let inner = '';
    if (d.sourceType === 'pdf') {
      inner = d.previewImages.length ? d.previewImages.map(src => `<img class="doc-page-img" src="${src}">`).join('') : `<div class="doc-fallback">📄 ${escapeHtml(d.fileName)}</div>`;
    } else if (d.sourceType === 'docx') {
      inner = d.htmlPreview ? `<div class="doc-html-preview">${d.htmlPreview}</div>` : `<div class="doc-fallback">📝 ${escapeHtml(d.fileName)}</div>`;
    } else if (d.sourceType === 'image') {
      inner = d.previewImages.map(src => `<img class="doc-page-img" src="${src}">`).join('');
    }
    const fieldsToggle = d.sourceType === 'docx' ? `
      <div class="toggle-row">
        <label class="switch"><input type="checkbox" id="prepareFieldsToggle" ${d.prepareFields ? 'checked' : ''}><span class="slider"></span></label>
        <div><div style="font-weight:600; font-size:13.5px;">Place signature, date, and checkbox fields on the document</div>
        <div class="faint">Instead of a signature block at the end, drag fields onto the exact spots on the page. Word documents only.</div></div>
      </div>` : '';
    return `<div class="file-chip">📎 ${escapeHtml(d.fileName)} <button class="link-btn" id="btnRemoveDoc" style="margin-left:6px;">Remove</button></div>
    <div class="doc-preview" style="margin-top:16px;">${inner}</div>
    ${d.sourceType === 'image' ? `<div style="text-align:center; margin-top:12px;"><button class="btn btn-ghost btn-sm" id="btnAddPage">Add another page</button></div>` : ''}
    <div class="field" style="margin-top:22px;"><label>Document title</label>
      <input type="text" id="draftTitle" value="${escapeHtml(d.title)}" placeholder="e.g. Consulting Agreement — Acme Corp"></div>
    ${fieldsToggle}
    <div style="display:flex; justify-content:flex-end; margin-top:10px;"><button class="btn btn-primary" id="btnUploadContinue">Continue to signers</button></div>`;
  }

  function wireUpload() {
    const d = STATE.draft;
    app.querySelectorAll('.tab-btn').forEach(el => el.addEventListener('click', () => { d._uploadTab = el.getAttribute('data-tab'); render(); }));
    const dz = document.getElementById('dropzone');
    const fInputDoc = document.getElementById('fInputDoc'), fInputImg = document.getElementById('fInputImg'), fInputCam = document.getElementById('fInputCam');
    if (dz) {
      document.getElementById('btnChooseFile').addEventListener('click', () => fInputDoc.click());
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) handleDocFile(e.dataTransfer.files[0]); });
    }
    const btnTake = document.getElementById('btnTakePhoto'); if (btnTake) btnTake.addEventListener('click', () => fInputCam.click());
    const btnUp = document.getElementById('btnUploadPhoto'); if (btnUp) btnUp.addEventListener('click', () => fInputImg.click());
    fInputDoc.onchange = e => { if (e.target.files[0]) handleDocFile(e.target.files[0]); fInputDoc.value = ''; };
    fInputImg.onchange = e => { if (e.target.files[0]) handlePhotoFile(e.target.files[0]); fInputImg.value = ''; };
    fInputCam.onchange = e => { if (e.target.files[0]) handlePhotoFile(e.target.files[0]); fInputCam.value = ''; };
    const btnRemove = document.getElementById('btnRemoveDoc'); if (btnRemove) btnRemove.addEventListener('click', () => { STATE.draft = blankDraft(); render(); });
    const btnAddPage = document.getElementById('btnAddPage'); if (btnAddPage) btnAddPage.addEventListener('click', () => fInputCam.click());
    const titleInput = document.getElementById('draftTitle'); if (titleInput) titleInput.addEventListener('input', e => { d.title = e.target.value; });
    const prepToggle = document.getElementById('prepareFieldsToggle'); if (prepToggle) prepToggle.addEventListener('change', e => { d.prepareFields = e.target.checked; });
    const btnCont = document.getElementById('btnUploadContinue');
    if (btnCont) btnCont.addEventListener('click', () => {
      if (!d.title.trim()) d.title = d.fileName || 'Untitled document';
      if (!d.signers.length) d.signers = [{ name: '', email: '' }];
      STATE.screen = 'new-signers'; render();
    });
  }

  async function handleDocFile(file) {
    const d = STATE.draft;
    const name = file.name || 'document';
    const lower = name.toLowerCase();
    d.fileName = name; d.docFile = file;
    if (lower.endsWith('.pdf')) {
      d.sourceType = 'pdf';
      try { const buf = await readFileAsArrayBuffer(file); d.previewImages = await renderPdfPagesFromArrayBuffer(buf.slice(0), 5); } catch (e) { console.warn(e); }
    } else if (lower.endsWith('.doc') || lower.endsWith('.docx')) {
      d.sourceType = 'docx';
      try {
        const buf = await readFileAsArrayBuffer(file);
        if (typeof mammoth !== 'undefined') { const r = await mammoth.convertToHtml({ arrayBuffer: buf }); d.htmlPreview = r.value; }
      } catch (e) { console.warn(e); }
    } else { alert('Please choose a PDF or Word (.doc/.docx) file.'); return; }
    render();
  }

  async function handlePhotoFile(file) {
    const d = STATE.draft;
    d.sourceType = 'image'; if (!d.fileName) d.fileName = 'Scanned document';
    try {
      const raw = await window.Sealwright.readFileAsDataURL(file);
      const small = await downscaleImage(raw, 1400);
      d.pageFiles.push(window.Sealwright.dataUrlToBlob(small));
      d.previewImages.push(small);
    } catch (e) { console.warn(e); }
    render();
  }

  // ---------------- signers step ----------------
  function renderNewSigners() {
    const d = STATE.draft;
    const rows = d.signers.map((s, i) => `<div class="signer-row" data-i="${i}">
      <div class="order-num">${i + 1}</div>
      <input type="text" placeholder="Full name" class="s-name" value="${escapeHtml(s.name)}">
      <input type="email" placeholder="Email address" class="s-email" value="${escapeHtml(s.email)}">
      <div class="row-actions">
        <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="down" ${i === d.signers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn" data-act="remove">✕</button>
      </div></div>`).join('');
    return `<div class="shell">${stepRail(1)}<div class="page-card">
      <h2 class="section-title">Who needs to sign?</h2>
      <p class="muted" style="margin-bottom:18px;">Add each signing party. The order below is the order they'll sign in.</p>
      <div id="signerRows">${rows}</div>
      <button class="btn btn-ghost btn-sm" id="btnAddSigner" style="margin-top:14px;">+ Add another signer</button>
      <div class="toggle-row"><label class="switch"><input type="checkbox" id="seqToggle" ${d.sequential ? 'checked' : ''}><span class="slider"></span></label>
        <div><div style="font-weight:600; font-size:13.5px;">Sign in order</div>
        <div class="faint">${d.sequential ? 'Each signer is notified only after the one before them signs.' : "All signers can sign as soon as it's sent, in any order."}</div></div></div>
      <div id="signerError" class="warn-text" style="display:none;"></div>
      <hr class="hr"><div style="display:flex; justify-content:space-between;">
        <button class="btn btn-ghost" id="btnBackUpload">Back</button>
        <button class="btn btn-primary" id="btnSignersContinue">Continue to review</button></div>
    </div></div>`;
  }

  function wireSigners() {
    const d = STATE.draft;
    function sync() {
      app.querySelectorAll('.signer-row').forEach(row => {
        const i = Number(row.getAttribute('data-i'));
        d.signers[i].name = row.querySelector('.s-name').value;
        d.signers[i].email = row.querySelector('.s-email').value;
      });
    }
    app.querySelectorAll('.s-name, .s-email').forEach(inp => inp.addEventListener('input', sync));
    app.querySelectorAll('.signer-row [data-act]').forEach(btn => btn.addEventListener('click', () => {
      sync();
      const i = Number(btn.closest('.signer-row').getAttribute('data-i'));
      const act = btn.getAttribute('data-act');
      if (act === 'remove') d.signers.splice(i, 1);
      else if (act === 'up' && i > 0) { const t = d.signers[i - 1]; d.signers[i - 1] = d.signers[i]; d.signers[i] = t; }
      else if (act === 'down' && i < d.signers.length - 1) { const t = d.signers[i + 1]; d.signers[i + 1] = d.signers[i]; d.signers[i] = t; }
      render();
    }));
    document.getElementById('btnAddSigner').addEventListener('click', () => { sync(); d.signers.push({ name: '', email: '' }); render(); });
    document.getElementById('seqToggle').addEventListener('change', e => { sync(); d.sequential = e.target.checked; render(); });
    document.getElementById('btnBackUpload').addEventListener('click', () => { sync(); STATE.screen = 'new-upload'; render(); });
    document.getElementById('btnSignersContinue').addEventListener('click', () => {
      sync();
      const errBox = document.getElementById('signerError');
      const filled = d.signers.filter(s => s.name.trim() && s.email.trim());
      const emailOk = filled.every(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim()));
      if (d.signers.length < 1) { errBox.textContent = 'Add at least one signer.'; errBox.style.display = 'block'; return; }
      if (filled.length !== d.signers.length) { errBox.textContent = 'Give every signer a name and an email address.'; errBox.style.display = 'block'; return; }
      if (!emailOk) { errBox.textContent = "One of the email addresses doesn't look valid."; errBox.style.display = 'block'; return; }
      errBox.style.display = 'none';
      STATE.screen = 'new-review'; render();
    });
  }

  // ---------------- review step ----------------
  function renderNewReview() {
    const d = STATE.draft;
    let preview = '';
    if (d.sourceType === 'pdf') preview = d.previewImages.length ? d.previewImages.map(s => `<img class="doc-page-img" src="${s}">`).join('') : `<div class="doc-fallback">📄 ${escapeHtml(d.fileName)}</div>`;
    else if (d.sourceType === 'docx') preview = d.htmlPreview ? `<div class="doc-html-preview">${d.htmlPreview}</div>` : `<div class="doc-fallback">📝 ${escapeHtml(d.fileName)}</div>`;
    else preview = d.previewImages.map(s => `<img class="doc-page-img" src="${s}">`).join('');
    const cards = d.signers.map((s, i) => `<div class="sig-block"><div class="sig-block-head">
      <div class="sig-who"><div class="order-num">${i + 1}</div><div><div style="font-weight:600;">${escapeHtml(s.name)}</div><div class="faint">${escapeHtml(s.email)}</div></div></div>
      <span class="sig-status pending">Will be notified ${d.sequential ? (i === 0 ? 'first' : 'after signer ' + i) : 'immediately'}</span>
    </div></div>`).join('');
    return `<div class="shell">${stepRail(2)}<div class="page-card">
      <h2 class="section-title">Review before sending</h2>
      <p class="muted" style="margin-bottom:6px;"><strong>${escapeHtml(d.title)}</strong></p>
      <p class="faint" style="margin-bottom:18px;">${d.sequential ? 'Signers will be routed in order.' : 'All signers can sign in any order.'}</p>
      <div class="doc-preview">${preview}</div>
      <div class="sig-block-panel">${cards}</div>
      <div id="sendError" class="warn-text" style="display:none;"></div>
      <hr class="hr"><div style="display:flex; justify-content:space-between;">
        <button class="btn btn-ghost" id="btnBackSigners">Back</button>
        <button class="btn btn-primary" id="btnSendEnvelope">${d.prepareFields ? 'Continue to place fields' : 'Send for signature'}</button></div>
    </div></div>`;
  }

  function wireReview() {
    document.getElementById('btnBackSigners').addEventListener('click', () => { STATE.screen = 'new-signers'; render(); });
    document.getElementById('btnSendEnvelope').addEventListener('click', STATE.draft.prepareFields ? createEnvelopeForFieldPlacement : sendEnvelope);
  }

  async function createEnvelopeForFieldPlacement() {
    const d = STATE.draft;
    const btn = document.getElementById('btnSendEnvelope');
    btn.disabled = true; btn.textContent = 'Preparing…';
    const fd = new FormData();
    fd.append('title', d.title);
    fd.append('sequential', d.sequential ? 'true' : 'false');
    fd.append('prepareFields', 'true');
    fd.append('signers', JSON.stringify(d.signers.map(s => ({ name: s.name.trim(), email: s.email.trim() }))));
    fd.append('document', d.docFile);
    try {
      const result = await api('/sealwright/api/envelopes', { method: 'POST', body: fd });
      STATE.currentId = result.id;
      STATE.screen = 'field-editor';
      render();
    } catch (e) {
      const errBox = document.getElementById('sendError');
      errBox.textContent = e.message || 'Could not create the envelope.'; errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Continue to place fields';
    }
  }

  async function sendEnvelope() {
    const d = STATE.draft;
    const btn = document.getElementById('btnSendEnvelope');
    btn.disabled = true; btn.textContent = 'Sending…';
    const fd = new FormData();
    fd.append('title', d.title);
    fd.append('sequential', d.sequential ? 'true' : 'false');
    fd.append('signers', JSON.stringify(d.signers.map(s => ({ name: s.name.trim(), email: s.email.trim() }))));
    if (d.sourceType === 'image') { d.pageFiles.forEach((blob, i) => fd.append('pages', blob, `page-${i}.jpg`)); }
    else if (d.docFile) { fd.append('document', d.docFile); }
    try {
      const result = await api('/sealwright/api/envelopes', { method: 'POST', body: fd });
      STATE.currentId = result.id;
      STATE.screen = 'detail';
      render();
    } catch (e) {
      const errBox = document.getElementById('sendError');
      errBox.textContent = e.message || 'Could not send the envelope.'; errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Send for signature';
    }
  }

  // ---------------- field placement editor (docx envelopes only) ----------------
  const FIELD_DEFAULTS = {
    signature: { width: 0.22, height: 0.045, label: 'Signature' },
    initial: { width: 0.08, height: 0.035, label: 'Initials' },
    date: { width: 0.14, height: 0.03, label: 'Date' },
    title: { width: 0.18, height: 0.03, label: 'Title' },
    checkbox: { width: 0.025, height: 0.02, label: 'Checkbox' }
  };
  const SIGNER_COLORS = ['#8C2F39', '#2F6B8C', '#3F6C51', '#A9803F', '#6B4C9A', '#B0554A'];
  let fieldEditorState = null; // { envelope, signers, pageImages, activeSignerId, activeType }

  async function renderFieldEditor() {
    let env;
    try { env = await api('/sealwright/api/envelopes/' + STATE.currentId); } catch (e) { return `<p class="banner banner-warn">${escapeHtml(e.message)}</p>`; }
    let pageImages = [];
    try {
      const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/draft-pdf`, { credentials: 'same-origin' })).arrayBuffer();
      pageImages = await renderPdfPagesFromArrayBuffer(buf, 20);
    } catch (e) { console.warn('draft pdf render failed', e); }

    fieldEditorState = {
      envelope: env, signers: env.signers, pageImages,
      activeSignerId: env.signers[0] && env.signers[0].id,
      activeType: 'signature'
    };

    const signerOptions = env.signers.map((s, i) =>
      `<option value="${s.id}" ${i === 0 ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    const typeButtons = Object.keys(FIELD_DEFAULTS).map(t =>
      `<button class="tab-btn field-type-btn ${t === 'signature' ? 'active' : ''}" data-type="${t}">${FIELD_DEFAULTS[t].label}</button>`).join('');

    const pagesHtml = pageImages.length
      ? pageImages.map((src, i) => `
        <div class="field-page" data-page-index="${i}" style="position:relative; display:block; margin:0 auto 16px; max-width:700px;">
          <img src="${src}" style="display:block; width:100%; border:1px solid var(--paper-line);" draggable="false">
          <div class="field-overlay" data-page-index="${i}" style="position:absolute; inset:0; cursor:crosshair;"></div>
        </div>`).join('')
      : `<div class="doc-fallback">Preview unavailable</div>`;

    return `<div class="page-card">
      <h2 class="section-title">Place fields</h2>
      <p class="muted" style="margin-bottom:6px;"><strong>${escapeHtml(env.title)}</strong></p>
      <p class="faint" style="margin-bottom:18px;">Pick a signer and a field type below, then click anywhere on the document to place it. Click a placed field to remove it.</p>
      <div class="upload-tabs" style="align-items:center; gap:14px;">
        <select id="fieldSignerSelect" style="padding:8px 10px; border:1.5px solid var(--paper-line); border-radius:4px; font-size:13.5px;">${signerOptions}</select>
        <div style="display:flex; gap:8px;">${typeButtons}</div>
      </div>
      <div id="fieldEditorError" class="warn-text" style="display:none; margin-top:10px;"></div>
      <div class="doc-preview" id="fieldPagesContainer" style="margin-top:16px; background:#EFEAE0;">${pagesHtml}</div>
      <hr class="hr">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <button class="btn btn-ghost" id="btnSaveForLater">Save and finish later</button>
        <button class="btn btn-primary" id="btnFinishSend">Finish &amp; send</button>
      </div>
    </div>`;
  }

  async function refreshFieldOverlays() {
    let fields;
    try { fields = await api('/sealwright/api/envelopes/' + fieldEditorState.envelope.id + '/fields'); } catch (e) { return; }
    const bySigner = {};
    fieldEditorState.signers.forEach((s, i) => { bySigner[s.id] = { name: s.name, color: SIGNER_COLORS[i % SIGNER_COLORS.length] }; });
    app.querySelectorAll('.field-overlay').forEach(layer => {
      const pageIdx = Number(layer.getAttribute('data-page-index'));
      const onPage = fields.filter(f => f.page_index === pageIdx);
      layer.innerHTML = onPage.map(f => {
        const info = bySigner[f.signer_id] || { name: '?', color: '#888' };
        const label = FIELD_DEFAULTS[f.field_type].label;
        return `<div class="placed-field" data-field-id="${f.id}" data-x="${f.x}" data-y="${f.y}" data-width="${f.width}" data-height="${f.height}"
          style="position:absolute; left:${f.x * 100}%; top:${f.y * 100}%; width:${f.width * 100}%; height:${f.height * 100}%;
          border:2px dashed ${info.color}; background:${info.color}22; border-radius:3px; cursor:move; user-select:none;
          display:flex; align-items:center; justify-content:center; overflow:hidden;">
          <span style="font-size:10px; font-weight:700; color:${info.color}; background:#fff; padding:1px 4px; border-radius:3px; white-space:nowrap; pointer-events:none;">${escapeHtml(info.name.split(' ')[0])} · ${label}</span>
          <button type="button" class="field-delete-btn" data-field-id="${f.id}" title="Remove field"
            style="position:absolute; top:-9px; right:-9px; width:18px; height:18px; border-radius:50%; border:1.5px solid ${info.color};
            background:#fff; color:${info.color}; font-size:11px; line-height:1; font-weight:700; cursor:pointer; padding:0;">✕</button>
        </div>`;
      }).join('');
    });
  }

  function wireFieldDragging() {
    app.querySelectorAll('.field-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await api('/sealwright/api/envelopes/' + fieldEditorState.envelope.id + '/fields/' + btn.getAttribute('data-field-id'), { method: 'DELETE' }); }
        catch (err) { /* ignore */ }
        await refreshFieldOverlays();
        wireFieldDragging();
      });
    });

    app.querySelectorAll('.placed-field').forEach(fieldEl => {
      let dragging = false, moved = false;
      let startX, startY, startFracX, startFracY, layerRect, fieldW, fieldH, fieldId;

      function pointerPos(e) {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
      }
      function onStart(e) {
        if (e.target.closest('.field-delete-btn')) return;
        e.preventDefault();
        const p = pointerPos(e);
        dragging = true; moved = false;
        startX = p.x; startY = p.y;
        startFracX = parseFloat(fieldEl.getAttribute('data-x'));
        startFracY = parseFloat(fieldEl.getAttribute('data-y'));
        fieldW = parseFloat(fieldEl.getAttribute('data-width'));
        fieldH = parseFloat(fieldEl.getAttribute('data-height'));
        fieldId = fieldEl.getAttribute('data-field-id');
        layerRect = fieldEl.parentElement.getBoundingClientRect();
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchend', onEnd);
      }
      function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        const p = pointerPos(e);
        if (Math.abs(p.x - startX) > 3 || Math.abs(p.y - startY) > 3) moved = true;
        const dxFrac = (p.x - startX) / layerRect.width;
        const dyFrac = (p.y - startY) / layerRect.height;
        const newX = Math.max(0, Math.min(1 - fieldW, startFracX + dxFrac));
        const newY = Math.max(0, Math.min(1 - fieldH, startFracY + dyFrac));
        fieldEl.style.left = (newX * 100) + '%';
        fieldEl.style.top = (newY * 100) + '%';
        fieldEl.setAttribute('data-pending-x', newX);
        fieldEl.setAttribute('data-pending-y', newY);
      }
      async function onEnd() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchend', onEnd);
        if (!dragging) return;
        dragging = false;
        if (moved) {
          const newX = parseFloat(fieldEl.getAttribute('data-pending-x'));
          const newY = parseFloat(fieldEl.getAttribute('data-pending-y'));
          try {
            await api('/sealwright/api/envelopes/' + fieldEditorState.envelope.id + '/fields/' + fieldId, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ x: newX, y: newY })
            });
          } catch (err) { /* ignore — the refresh below re-syncs to whatever the server actually has */ }
          await refreshFieldOverlays();
          wireFieldDragging();
        }
      }
      fieldEl.addEventListener('mousedown', onStart);
      fieldEl.addEventListener('touchstart', onStart, { passive: false });
    });
  }

  function wireFieldEditor() {
    if (!fieldEditorState) return;
    refreshFieldOverlays();

    document.getElementById('fieldSignerSelect').addEventListener('change', e => { fieldEditorState.activeSignerId = e.target.value; });
    app.querySelectorAll('.field-type-btn').forEach(btn => btn.addEventListener('click', () => {
      fieldEditorState.activeType = btn.getAttribute('data-type');
      app.querySelectorAll('.field-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }));

    app.querySelectorAll('.field-overlay').forEach(layer => {
      // Click-to-place a NEW field — skipped entirely when the click is on an
      // existing field, since that field's own handlers (drag / delete button)
      // own that interaction instead.
      layer.addEventListener('click', async (e) => {
        if (e.target.closest('.placed-field')) return;
        const rect = layer.getBoundingClientRect();
        const def = FIELD_DEFAULTS[fieldEditorState.activeType];
        let x = (e.clientX - rect.left) / rect.width - def.width / 2;
        let y = (e.clientY - rect.top) / rect.height - def.height / 2;
        x = Math.max(0, Math.min(1 - def.width, x));
        y = Math.max(0, Math.min(1 - def.height, y));
        const pageIndex = Number(layer.getAttribute('data-page-index'));
        try {
          await api('/sealwright/api/envelopes/' + fieldEditorState.envelope.id + '/fields', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signer_id: fieldEditorState.activeSignerId, field_type: fieldEditorState.activeType, page_index: pageIndex, x, y, width: def.width, height: def.height })
          });
          await refreshFieldOverlays();
          wireFieldDragging();
        } catch (err) {
          const errBox = document.getElementById('fieldEditorError');
          errBox.textContent = err.message || 'Could not place that field.'; errBox.style.display = 'block';
        }
      });
    });

    wireFieldDragging();

    document.getElementById('btnSaveForLater').addEventListener('click', () => { STATE.screen = 'list'; render(); });
    document.getElementById('btnFinishSend').addEventListener('click', async () => {
      const btn = document.getElementById('btnFinishSend');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await api('/sealwright/api/envelopes/' + fieldEditorState.envelope.id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        STATE.currentId = fieldEditorState.envelope.id;
        STATE.screen = 'detail';
        render();
      } catch (err) {
        const errBox = document.getElementById('fieldEditorError');
        errBox.textContent = err.message || 'Could not send the envelope.'; errBox.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Finish & send';
      }
    });
  }

  // ---------------- detail / tracking ----------------
  async function renderDetail() {
    let env;
    try { env = await api('/sealwright/api/envelopes/' + STATE.currentId); } catch (e) { return `<p class="banner banner-warn">${escapeHtml(e.message)}</p>`; }
    STATE._currentEnv = env;
    let preview = '<div class="doc-fallback">Loading preview…</div>';
    const rows = env.signers.map((s, i) => {
      let status, link = '';
      if (s.status === 'signed') status = `<span class="sig-status signed">Signed ${formatDateTime(s.signed_at)}</span>`;
      else if (env.status === 'cancelled') status = `<span class="sig-status waiting">Cancelled</span>`;
      else if (!env.sequential || s.order_index === env.current_turn_index) {
        status = `<span class="sig-status pending">Ready to sign</span>`;
        link = s.sign_token ? `<button class="btn btn-sm btn-ghost" data-copy="${location.origin}/sealwright/sign/${s.sign_token}">Copy signing link</button>` : '';
      } else status = `<span class="sig-status waiting">Waiting for turn</span>`;
      const sigImg = s.has_signature ? `<img class="sig-img" src="/sealwright/api/envelopes/${env.id}/signers/${s.id}/signature">` : '';
      return `<div class="sig-block ${(!env.sequential || s.order_index === env.current_turn_index) && s.status !== 'signed' ? 'is-active' : ''}">
        <div class="sig-block-head"><div class="sig-who"><div class="order-num">${i + 1}</div>
        <div><div style="font-weight:600;">${escapeHtml(s.name)}</div><div class="faint">${escapeHtml(s.email)}</div></div></div>
        <div style="display:flex; gap:10px; align-items:center;">${status}${link}</div></div>${sigImg}</div>`;
    }).join('');
    const auditRows = env.audit.slice().reverse().map(a => `<div class="audit-item"><div class="audit-time">${formatDateTime(a.ts)}</div><div>${escapeHtml(a.text)}</div></div>`).join('');
    const completedBlock = env.status === 'completed' ? `
      <div class="banner banner-info" style="margin-top:22px;"><strong>Document executed.</strong> All parties have signed.
      ${env.fingerprint ? `<div class="fingerprint" style="margin-top:8px;">SHA-256 fingerprint: ${env.fingerprint}</div>` : ''}</div>
      <div style="margin-top:14px;"><a class="btn btn-primary" href="/sealwright/api/envelopes/${env.id}/download">Download executed document</a></div>` : '';
    const cancelledBlock = env.status === 'cancelled' ? `
      <div class="banner banner-warn" style="margin-top:22px;"><strong>Envelope cancelled.</strong> Signers can no longer sign this document.</div>` : '';
    const manageSection = env.is_owner ? `
      <hr class="hr">
      <div id="deleteError" class="warn-text" style="display:none;"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        ${(env.status === 'sent' || env.status === 'preparing') ? `<button class="btn btn-ghost btn-sm" id="btnCancelEnvelope" data-id="${env.id}" data-title="${escapeHtml(env.title)}">Cancel this envelope</button>` : ''}
        <button class="btn btn-danger btn-sm" id="btnDeleteEnvelope" data-id="${env.id}" data-title="${escapeHtml(env.title)}">Delete this envelope</button>
      </div>
      <p class="faint" style="margin-top:8px;">Cancel stops signing but keeps the record. Delete permanently removes the document, every signature, and the activity log. Both cannot be undone.</p>` : '';
    setTimeout(() => loadDetailPreview(env), 0);
    let headerBadge;
    if (env.status === 'completed') headerBadge = '<span class="badge badge-done">Completed</span>';
    else if (env.status === 'cancelled') headerBadge = '<span class="badge" style="background:#EFEAE0; color:var(--ink-faint);">Cancelled</span>';
    else headerBadge = '<span class="badge badge-progress">In progress</span>';
    return `<div class="page-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
        <div><h2 class="section-title">${escapeHtml(env.title)}</h2><p class="faint">Created ${formatDateTime(env.created_at)} · ${env.sequential ? 'Sequential' : 'Parallel'} routing${env.is_owner === false ? ' · Sent to you' : ''}</p></div>
        ${headerBadge}
      </div>
      <div class="doc-preview" id="detailPreview" style="margin-top:18px;">${preview}</div>
      <h3 style="margin-top:26px; font-size:16px;">Signers</h3><div class="sig-block-panel">${rows}</div>
      ${completedBlock}${cancelledBlock}<hr class="hr"><h3 style="font-size:16px;">Activity</h3><div class="audit-log">${auditRows}</div>
      ${manageSection}
    </div>`;
  }

  async function loadDetailPreview(env) {
    const el = document.getElementById('detailPreview');
    if (!el) return;
    try {
      if (env.source_type === 'pdf') {
        const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/file`, { credentials: 'same-origin' })).arrayBuffer();
        const imgs = await renderPdfPagesFromArrayBuffer(buf, 5);
        el.innerHTML = imgs.length ? imgs.map(s => `<img class="doc-page-img" src="${s}">`).join('') : `<div class="doc-fallback">📄 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'docx') {
        const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/file`, { credentials: 'same-origin' })).arrayBuffer();
        if (typeof mammoth !== 'undefined') {
          const r = await mammoth.convertToHtml({ arrayBuffer: buf });
          el.innerHTML = `<div class="doc-html-preview">${r.value}</div>`;
        } else el.innerHTML = `<div class="doc-fallback">📝 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'image') {
        let html = '';
        for (let i = 0; i < env.page_count; i++) html += `<img class="doc-page-img" src="/sealwright/api/envelopes/${env.id}/pages/${i}">`;
        el.innerHTML = html;
      }
    } catch (e) { el.innerHTML = `<div class="doc-fallback">Preview unavailable</div>`; }
  }

  function wireDetail() {
    app.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.getAttribute('data-copy')); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy signing link', 1500); }
      catch (e) { prompt('Copy this link:', btn.getAttribute('data-copy')); }
    }));
    const btnDelete = document.getElementById('btnDeleteEnvelope');
    if (btnDelete) btnDelete.addEventListener('click', async () => {
      const title = btnDelete.getAttribute('data-title');
      if (!confirm(`Delete "${title}"? This permanently removes the document, all signatures, and the activity log. This cannot be undone.`)) return;
      btnDelete.disabled = true; btnDelete.textContent = 'Deleting…';
      try {
        await api('/sealwright/api/envelopes/' + btnDelete.getAttribute('data-id'), { method: 'DELETE' });
        STATE.screen = 'list'; render();
      } catch (e) {
        const errBox = document.getElementById('deleteError');
        errBox.textContent = e.message || 'Could not delete this envelope.'; errBox.style.display = 'block';
        btnDelete.disabled = false; btnDelete.textContent = 'Delete this envelope';
      }
    });
    const btnCancel = document.getElementById('btnCancelEnvelope');
    if (btnCancel) btnCancel.addEventListener('click', async () => {
      const title = btnCancel.getAttribute('data-title');
      if (!confirm(`Cancel "${title}"? Signers will no longer be able to sign it, and anyone who already received it will be notified it was cancelled. This cannot be undone.`)) return;
      btnCancel.disabled = true; btnCancel.textContent = 'Cancelling…';
      try {
        await api('/sealwright/api/envelopes/' + btnCancel.getAttribute('data-id') + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        render();
      } catch (e) {
        const errBox = document.getElementById('deleteError');
        errBox.textContent = e.message || 'Could not cancel this envelope.'; errBox.style.display = 'block';
        btnCancel.disabled = false; btnCancel.textContent = 'Cancel this envelope';
      }
    });
  }

  window.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('.row-action-btn');
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.getAttribute('data-id');
      const title = actionBtn.getAttribute('data-title');
      const action = actionBtn.getAttribute('data-action');
      if (action === 'delete') {
        if (!confirm(`Delete "${title}"? This permanently removes the document, every signature, and the activity log. This cannot be undone.`)) return;
        try { await api('/sealwright/api/envelopes/' + id, { method: 'DELETE' }); }
        catch (err) { alert(err.message || 'Could not delete this envelope.'); return; }
      } else if (action === 'cancel') {
        if (!confirm(`Cancel "${title}"? Signers will no longer be able to sign it, and anyone who already received it will be notified it was cancelled. This cannot be undone.`)) return;
        try { await api('/sealwright/api/envelopes/' + id + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
        catch (err) { alert(err.message || 'Could not cancel this envelope.'); return; }
      }
      if (STATE.screen === 'list') render();
      return;
    }
    const row = e.target.closest('.env-row');
    if (row && STATE.screen === 'list') {
      const id = row.getAttribute('data-id');
      const env = STATE.envelopes.find(x => x.id === id);
      STATE.currentId = id;
      STATE.screen = (env && env.status === 'preparing') ? 'field-editor' : 'detail';
      render();
    }
  });

  render();
})();
