(function () {
  const { escapeHtml, formatDateTime, todayLabel, dataUrlToBlob, sealSvg, renderPdfPagesFromArrayBuffer } = window.Sealwright;
  const app = document.getElementById('app');
  const TOKEN = window.SIGN_TOKEN;

  let ctx = null; // context from server
  let activeMethod = 'draw', activeFont = "'Dancing Script', cursive", uploadedDataUrl = null;
  let padCtx = null, padHasInk = false, padDrawing = false;

  // Once any signature/initial field is filled by any method within this
  // document, remember it here so the NEXT field of the same type can be
  // filled with one click instead of drawing/typing/uploading all over again.
  let sessionFillCache = { signature: null, initial: null }; // {kind:'useSaved'} | {kind:'image', blob, previewUrl}

  // ---------------- field-based fill-in view ----------------
  const FIELD_LABELS = { signature: 'Signature', initial: 'Initials', date: 'Date', title: 'Title', checkbox: 'Checkbox' };
  let fillValues = {}; // { [fieldId]: {kind:'image', blob} | {kind:'text', value} | {kind:'bool', value} }
  let activeFillField = null;
  let fillPadCtx = null, fillPadHasInk = false, fillActiveMethod = 'draw', fillUploadedDataUrl = null;

  async function renderFieldFillView(env, you) {
    const myFields = ctx.fields.filter(f => f.signer_id === you.id);
    const canAct = ctx.myTurn && you.status !== 'signed';

    let pageImages = [];
    try {
      const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/draft-pdf?token=${TOKEN}`)).arrayBuffer();
      pageImages = await renderPdfPagesFromArrayBuffer(buf, 20);
    } catch (e) { console.warn('draft pdf failed', e); }

    const signerNames = {}; ctx.signers.forEach(s => { signerNames[s.id] = s.name; });

    const pagesHtml = pageImages.length ? pageImages.map((src, i) => `
      <div class="field-page" data-page-index="${i}" style="position:relative; display:block; margin:0 auto 16px; max-width:700px;">
        <img src="${src}" style="display:block; width:100%; border:1px solid var(--paper-line);" draggable="false">
        <div class="field-overlay-view" data-page-index="${i}" style="position:absolute; inset:0;">${
          ctx.fields.filter(f => f.page_index === i).map(f => fieldBoxHtml(f, you, canAct, signerNames)).join('')
        }</div>
      </div>`).join('') : `<div class="doc-fallback">Preview unavailable</div>`;

    const allMineFilled = myFields.every(f => fillValues[f.id] || f.filled_text !== null || f.filled_bool !== null || f.has_filled_image);
    const hasImageFields = myFields.some(f => f.field_type === 'signature' || f.field_type === 'initial');

    app.innerHTML = `${topbar()}<div class="page-card">
      <h2 class="section-title">${escapeHtml(env.title)}</h2>
      <p class="faint" style="margin-bottom:6px;">Viewing as ${escapeHtml(you.name)}</p>
      ${!canAct ? `<div class="banner banner-info">${you.status === 'signed' ? 'You already completed your fields on this document.' : 'Waiting on an earlier signer before it\'s your turn.'}</div>` : `<p class="faint" style="margin-bottom:14px;">Fields with your name are yours to fill — click one to get started. Other signers' fields are shown for reference.</p>`}
      <div class="doc-preview" id="fieldFillPages" style="background:#EFEAE0;">${pagesHtml}</div>
      <div id="fillPanelHost"></div>
      ${canAct ? `
        ${hasImageFields ? `<label style="display:flex; align-items:center; gap:8px; margin-top:14px; font-size:13px;">
          <input type="checkbox" id="fillSaveForFutureChk"> Save my signature and initials for future documents
        </label>` : ''}
        <div class="consent"><input type="checkbox" id="fillConsentChk">
          <span>I intend the fields I've filled as my electronic signature and agree they're legally binding for "${escapeHtml(env.title)}", signed on ${todayLabel()}.</span></div>
        <div id="fillSubmitError" class="warn-text" style="display:none;"></div>
        <div style="margin-top:16px;"><button class="btn btn-primary" id="btnSubmitFields" ${allMineFilled ? '' : 'disabled'}>Submit</button></div>
      ` : ''}
    </div>`;

    if (canAct) wireFieldFillView(env, you, myFields);
  }

  function fieldBoxHtml(f, you, canAct, signerNames) {
    const isMine = f.signer_id === you.id;
    const filled = fillValues[f.id] || f.filled_text !== null || f.filled_bool !== null || f.has_filled_image;
    const label = FIELD_LABELS[f.field_type];
    const color = isMine ? '#8C2F39' : '#8B968F';
    let content = '';
    if (f.field_type === 'checkbox') {
      const checked = fillValues[f.id] ? fillValues[f.id].value : f.filled_bool;
      content = checked ? '✕' : '';
    } else if (f.field_type === 'date' || f.field_type === 'title') {
      content = fillValues[f.id] ? escapeHtml(fillValues[f.id].value) : escapeHtml(f.filled_text || '');
    } else if (f.has_filled_image) {
      content = `<img src="/sealwright/api/envelopes/${ctx.envelope.id}/fields/${f.id}/image?token=${TOKEN}" style="max-width:100%; max-height:100%;">`;
    } else if (fillValues[f.id] && fillValues[f.id].kind === 'image') {
      content = `<img src="${fillValues[f.id].previewUrl}" style="max-width:100%; max-height:100%;">`;
    } else if (fillValues[f.id] && fillValues[f.id].kind === 'useSaved') {
      content = `<img src="/sealwright/api/sign/${TOKEN}/saved-image?type=${f.field_type === 'initial' ? 'initial' : 'signature'}" style="max-width:100%; max-height:100%;">`;
    }
    const clickable = isMine && canAct && !filled;
    return `<div class="fill-field ${clickable ? 'fill-field-clickable' : ''}" data-field-id="${f.id}" data-field-type="${f.field_type}"
      style="position:absolute; left:${f.x * 100}%; top:${f.y * 100}%; width:${f.width * 100}%; height:${f.height * 100}%;
      border:2px ${isMine ? 'solid' : 'dashed'} ${color}; background:${filled ? 'transparent' : color + '15'};
      border-radius:3px; ${clickable ? 'cursor:pointer;' : ''} display:flex; align-items:center; justify-content:center; overflow:hidden;">
      ${content || (isMine ? `<span style="font-size:10px; font-weight:700; color:${color};">${label}</span>` : `<span style="font-size:9px; color:${color};">${escapeHtml((signerNames[f.signer_id] || '').split(' ')[0])}</span>`)}
    </div>`;
  }

  function wireFieldFillView(env, you, myFields) {
    app.querySelectorAll('.fill-field-clickable').forEach(box => {
      box.addEventListener('click', () => openFillPanel(box.getAttribute('data-field-id'), box.getAttribute('data-field-type'), env, you, myFields));
    });
    const btnSubmit = document.getElementById('btnSubmitFields');
    if (btnSubmit) btnSubmit.addEventListener('click', () => submitFields(env, myFields));
    const consentChk = document.getElementById('fillConsentChk');
    if (consentChk) consentChk.addEventListener('change', updateSubmitEnabled);
    updateSubmitEnabled();

    function updateSubmitEnabled() {
      const allFilled = myFields.every(f => fillValues[f.id] || f.filled_text !== null || f.filled_bool !== null || f.has_filled_image);
      const consent = document.getElementById('fillConsentChk') && document.getElementById('fillConsentChk').checked;
      const btn = document.getElementById('btnSubmitFields');
      if (btn) btn.disabled = !(allFilled && consent);
    }
    window._sealwrightUpdateSubmitEnabled = updateSubmitEnabled;
  }

  function openFillPanel(fieldId, fieldType, env, you, myFields, forceFullPanel) {
    activeFillField = fieldId;
    const host = document.getElementById('fillPanelHost');
    const currentField = myFields.find(f => f.id === fieldId);
    if (fieldType === 'checkbox') {
      const current = fillValues[fieldId] ? fillValues[fieldId].value : false;
      fillValues[fieldId] = { kind: 'bool', value: !current };
      renderFieldFillView(env, you); // cheap full refresh; keeps this simple and correct
      return;
    }
    if (fieldType === 'date' || fieldType === 'title') {
      const isDate = fieldType === 'date';
      const heading = isDate ? 'Enter a date' : 'Enter your title';
      const placeholder = isDate ? 'MM/DD/YYYY' : 'e.g. Chief Executive Officer';
      const defaultValue = fillValues[fieldId] ? fillValues[fieldId].value : (isDate ? todayLabel() : '');
      host.innerHTML = `<div class="sig-block is-active" style="margin-top:14px;">
        <div style="font-weight:600; margin-bottom:8px;">${heading}</div>
        <input type="text" id="textFillInput" placeholder="${placeholder}" value="${escapeHtml(defaultValue)}" style="padding:9px 12px; border:1.5px solid var(--paper-line); border-radius:4px; font-size:14px; width:260px;">
        <div style="margin-top:10px;"><button class="btn btn-primary btn-sm" id="btnSaveText">Use this</button> <button class="btn btn-ghost btn-sm" id="btnCancelFill">Cancel</button></div>
      </div>`;
      document.getElementById('btnSaveText').addEventListener('click', () => {
        const val = document.getElementById('textFillInput').value.trim();
        if (!val) return;
        fillValues[fieldId] = { kind: 'text', value: val };
        host.innerHTML = '';
        renderFieldFillView(env, you);
      });
      document.getElementById('btnCancelFill').addEventListener('click', () => { host.innerHTML = ''; });
      return;
    }

    // signature / initial — offer a one-click reuse first: whatever was used
    // earlier for this same type in THIS document takes priority (most
    // relevant), falling back to a signature/initials saved from a previous
    // document if this is the first field of that type encountered here.
    const cacheKey = fieldType === 'initial' ? 'initial' : 'signature';
    const hasServerSaved = fieldType === 'initial' ? (ctx.savedSignature && ctx.savedSignature.hasInitial) : (ctx.savedSignature && ctx.savedSignature.hasSignature);
    const quickFill = sessionFillCache[cacheKey] || (hasServerSaved ? { kind: 'useSaved' } : null);

    if (quickFill && !forceFullPanel) {
      const previewSrc = quickFill.kind === 'useSaved'
        ? `/sealwright/api/sign/${TOKEN}/saved-image?type=${cacheKey}`
        : quickFill.previewUrl;
      const label = sessionFillCache[cacheKey] ? `the ${FIELD_LABELS[fieldType].toLowerCase()} you just used` : `your saved ${FIELD_LABELS[fieldType].toLowerCase()}`;
      host.innerHTML = `<div class="sig-block is-active" style="margin-top:14px;">
        <div style="font-weight:600; margin-bottom:8px;">${FIELD_LABELS[fieldType]}</div>
        <img class="sig-img" src="${previewSrc}">
        <p class="faint" style="margin-top:6px;">Use ${label}?</p>
        <div style="margin-top:10px;">
          <button class="btn btn-primary btn-sm" id="btnUseQuickFill">Use this</button>
          <button class="btn btn-ghost btn-sm" id="btnDrawDifferent">Use a different one</button>
          <button class="btn btn-ghost btn-sm" id="btnCancelFill">Cancel</button>
        </div>
      </div>`;
      document.getElementById('btnUseQuickFill').addEventListener('click', () => {
        fillValues[fieldId] = quickFill.kind === 'useSaved' ? { kind: 'useSaved' } : quickFill;
        sessionFillCache[cacheKey] = fillValues[fieldId];
        host.innerHTML = '';
        renderFieldFillView(env, you);
      });
      document.getElementById('btnDrawDifferent').addEventListener('click', () => openFillPanel(fieldId, fieldType, env, you, myFields, true));
      document.getElementById('btnCancelFill').addEventListener('click', () => { host.innerHTML = ''; });
      return;
    }

    // full draw/type/upload panel — same pattern as the classic flow
    fillActiveMethod = 'draw'; fillPadHasInk = false; fillUploadedDataUrl = null;
    host.innerHTML = `<div class="sig-block is-active" style="margin-top:14px;">
      <div style="font-weight:600; margin-bottom:8px;">${FIELD_LABELS[fieldType]}</div>
      <div class="sign-method-tabs">
        <button class="tab-btn fill-method-tab active" data-method="draw" type="button">Draw</button>
        <button class="tab-btn fill-method-tab" data-method="type" type="button">Type</button>
        <button class="tab-btn fill-method-tab" data-method="upload" type="button">Upload image</button>
      </div>
      <div class="fill-method-panel" data-panel="draw"><canvas class="pad" id="fillCanvas" width="360" height="120"></canvas>
        <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" id="btnClearFillPad" type="button">Clear</button></div></div>
      <div class="fill-method-panel" data-panel="type" style="display:none;">
        <div class="field"><input type="text" id="fillTypedName" value="${escapeHtml(you.name)}"></div>
        <div class="typed-preview" id="fillTypedPreview" style="font-family:'Dancing Script', cursive; font-size:30px;">${escapeHtml(you.name)}</div>
      </div>
      <div class="fill-method-panel" data-panel="upload" style="display:none;">
        <input type="file" id="fillUploadInput" accept="image/*" style="display:none">
        <button class="btn btn-ghost btn-sm" id="btnPickFillImage" type="button">Choose an image file</button>
        <div id="fillUploadedPreview" style="margin-top:8px;"></div>
      </div>
      <div style="margin-top:10px;"><button class="btn btn-primary btn-sm" id="btnUseFillValue" disabled>Use this ${FIELD_LABELS[fieldType].toLowerCase()}</button> <button class="btn btn-ghost btn-sm" id="btnCancelFill">Cancel</button></div>
    </div>`;

    const canvas = document.getElementById('fillCanvas');
    fillPadCtx = canvas.getContext('2d');
    fillPadCtx.lineWidth = 2; fillPadCtx.lineCap = 'round'; fillPadCtx.strokeStyle = '#1C2B3A';
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * (canvas.width / r.width), y: cy * (canvas.height / r.height) };
    }
    function start(e) { e.preventDefault(); fillPadCtx._drawing = true; const p = pos(e); fillPadCtx.beginPath(); fillPadCtx.moveTo(p.x, p.y); }
    function move(e) { if (!fillPadCtx._drawing) return; e.preventDefault(); const p = pos(e); fillPadCtx.lineTo(p.x, p.y); fillPadCtx.stroke(); fillPadHasInk = true; updateUseEnabled(); }
    function end() { fillPadCtx._drawing = false; }
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
    document.getElementById('btnClearFillPad').addEventListener('click', () => { fillPadCtx.clearRect(0, 0, canvas.width, canvas.height); fillPadHasInk = false; updateUseEnabled(); });

    host.querySelectorAll('.fill-method-tab').forEach(btn => btn.addEventListener('click', () => {
      fillActiveMethod = btn.getAttribute('data-method');
      host.querySelectorAll('.fill-method-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      host.querySelectorAll('.fill-method-panel').forEach(p => p.style.display = p.getAttribute('data-panel') === fillActiveMethod ? 'block' : 'none');
      updateUseEnabled();
    }));
    document.getElementById('fillTypedName').addEventListener('input', e => { document.getElementById('fillTypedPreview').textContent = e.target.value; updateUseEnabled(); });
    document.getElementById('btnPickFillImage').addEventListener('click', () => document.getElementById('fillUploadInput').click());
    document.getElementById('fillUploadInput').onchange = async (e) => {
      if (e.target.files[0]) {
        const raw = await window.Sealwright.readFileAsDataURL(e.target.files[0]);
        fillUploadedDataUrl = await window.Sealwright.downscaleImage(raw, 400);
        document.getElementById('fillUploadedPreview').innerHTML = `<img class="sig-img" src="${fillUploadedDataUrl}">`;
        updateUseEnabled();
      }
    };
    document.getElementById('btnCancelFill').addEventListener('click', () => { host.innerHTML = ''; });
    document.getElementById('btnUseFillValue').addEventListener('click', async () => {
      let dataUrl;
      if (fillActiveMethod === 'draw') dataUrl = canvas.toDataURL('image/png');
      else if (fillActiveMethod === 'type') {
        const text = document.getElementById('fillTypedName').value.trim();
        try { await document.fonts.load(`40px 'Dancing Script'`); } catch (e) {}
        // 612x792 matches the fixed docx page size used everywhere else in
        // the app (src/pdf.js) — converting the field's stored fraction
        // width/height into points gives the real box shape to render into.
        const boxWpt = currentField ? currentField.width * 612 : null;
        const boxHpt = currentField ? currentField.height * 792 : null;
        dataUrl = renderTypedSignatureImage(text, "'Dancing Script', cursive", boxWpt, boxHpt);
      } else dataUrl = fillUploadedDataUrl;
      fillValues[fieldId] = { kind: 'image', blob: dataUrlToBlob(dataUrl), previewUrl: dataUrl };
      sessionFillCache[cacheKey] = fillValues[fieldId];
      host.innerHTML = '';
      renderFieldFillView(env, you);
    });

    function updateUseEnabled() {
      let ready = false;
      if (fillActiveMethod === 'draw') ready = fillPadHasInk;
      else if (fillActiveMethod === 'type') ready = !!document.getElementById('fillTypedName').value.trim();
      else if (fillActiveMethod === 'upload') ready = !!fillUploadedDataUrl;
      document.getElementById('btnUseFillValue').disabled = !ready;
    }
  }

  async function submitFields(env, myFields) {
    const btn = document.getElementById('btnSubmitFields');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const fd = new FormData();
    fd.append('consent', 'true');
    const saveChk = document.getElementById('fillSaveForFutureChk');
    if (saveChk && saveChk.checked) fd.append('saveForFuture', 'true');
    for (const f of myFields) {
      const v = fillValues[f.id];
      if (!v) continue; // already filled server-side from an earlier partial attempt
      if (v.kind === 'image') fd.append('image_' + f.id, v.blob, 'field.png');
      else if (v.kind === 'useSaved') fd.append('useSaved_' + f.id, 'true');
      else if (v.kind === 'text') fd.append('text_' + f.id, v.value);
      else if (v.kind === 'bool') fd.append('bool_' + f.id, v.value ? 'true' : 'false');
    }
    try {
      const res = await fetch(`/sealwright/api/sign/${TOKEN}/fields`, { method: 'POST', body: fd });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not submit your fields.'); }
      const result = await res.json();
      fillValues = {};
      sessionFillCache = { signature: null, initial: null };
      if (result.allSigned) showSealed(env);
      else { await load(); }
    } catch (e) {
      const errBox = document.getElementById('fillSubmitError');
      if (errBox) { errBox.textContent = e.message; errBox.style.display = 'block'; }
      btn.disabled = false; btn.textContent = 'Submit';
    }
  }

  async function load() {
    try {
      const res = await fetch(`/sealwright/api/sign/${TOKEN}/context`);
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
    if (ctx.hasFields) { renderFieldFillView(env, you); return; }
    const blocks = ctx.signers.map(s => {
      const isYou = s.id === you.id;
      let statusHtml;
      if (s.status === 'signed') statusHtml = `<span class="sig-status signed">Signed ${formatDateTime(s.signed_at)}</span>`;
      else if (isYou) statusHtml = `<span class="sig-status pending">${ctx.myTurn ? 'Your turn' : 'Waiting'}</span>`;
      else statusHtml = `<span class="sig-status waiting">Not yet signed</span>`;
      const sigImg = s.has_signature ? `<img class="sig-img" src="/sealwright/api/envelopes/${env.id}/signers/${s.id}/signature?token=${TOKEN}">` : '';
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
        const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/file?token=${TOKEN}`)).arrayBuffer();
        const imgs = await renderPdfPagesFromArrayBuffer(buf, 5);
        el.innerHTML = imgs.length ? imgs.map(s => `<img class="doc-page-img" src="${s}">`).join('') : `<div class="doc-fallback">📄 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'docx') {
        const buf = await (await fetch(`/sealwright/api/envelopes/${env.id}/file?token=${TOKEN}`)).arrayBuffer();
        if (typeof mammoth !== 'undefined') { const r = await mammoth.convertToHtml({ arrayBuffer: buf }); el.innerHTML = `<div class="doc-html-preview">${r.value}</div>`; }
        else el.innerHTML = `<div class="doc-fallback">📝 ${escapeHtml(env.file_name)}</div>`;
      } else if (env.source_type === 'image') {
        let html = '';
        for (let i = 0; i < env.page_count; i++) html += `<img class="doc-page-img" src="/sealwright/api/envelopes/${env.id}/pages/${i}?token=${TOKEN}">`;
        el.innerHTML = html;
      }
    } catch (e) { el.innerHTML = `<div class="doc-fallback">Preview unavailable</div>`; }
  }

  function signingPanelHtml(env, you) {
    const hasSaved = ctx.savedSignature && ctx.savedSignature.hasSignature;
    return `<div class="sign-method-tabs">
      ${hasSaved ? '<button class="tab-btn method-tab active" data-method="saved">Use saved signature</button>' : ''}
      <button class="tab-btn method-tab ${hasSaved ? '' : 'active'}" data-method="draw">Draw</button>
      <button class="tab-btn method-tab" data-method="type">Type</button>
      <button class="tab-btn method-tab" data-method="upload">Upload image</button>
    </div>
    ${hasSaved ? `<div class="method-panel" data-panel="saved">
      <img class="sig-img" src="/sealwright/api/sign/${TOKEN}/saved-image?type=signature">
      <p class="faint" style="margin-top:6px;">Your saved signature.</p>
    </div>` : ''}
    <div class="method-panel" data-panel="draw" style="display:${hasSaved ? 'none' : 'block'};"><canvas class="pad" id="sigCanvas" width="420" height="150"></canvas>
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
    <label id="saveForFutureRow" style="display:${hasSaved ? 'none' : 'flex'}; align-items:center; gap:8px; margin-top:14px; font-size:13px;">
      <input type="checkbox" id="saveForFutureChk"> Save this as my signature for next time
    </label>
    <div class="consent"><input type="checkbox" id="consentChk">
      <span>I intend this as my electronic signature and agree it's legally binding for "${escapeHtml(env.title)}", signed on ${todayLabel()}.</span></div>
    <div id="signError" class="warn-text" style="display:none;"></div>
    <div style="margin-top:16px;"><button class="btn btn-primary" id="btnAdoptSign" ${hasSaved ? '' : 'disabled'}>Adopt &amp; sign</button></div>`;
  }

  function wirePanel(env, you) {
    const hasSaved = ctx.savedSignature && ctx.savedSignature.hasSignature;
    activeMethod = hasSaved ? 'saved' : 'draw'; padHasInk = false; uploadedDataUrl = null;
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
        const saveRow = document.getElementById('saveForFutureRow');
        if (saveRow) saveRow.style.display = method === 'saved' ? 'none' : 'flex';
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
      if (activeMethod === 'saved') ready = true;
      else if (activeMethod === 'draw') ready = padHasInk;
      else if (activeMethod === 'type') ready = !!(document.getElementById('typedName') && document.getElementById('typedName').value.trim());
      else if (activeMethod === 'upload') ready = !!uploadedDataUrl;
      const btn = document.getElementById('btnAdoptSign');
      if (btn) btn.disabled = !(ready && consent);
    }
  }

  function renderTypedSignatureImage(text, font, boxWidthPts, boxHeightPts) {
    // Match the canvas's aspect ratio to the actual field it'll be stamped
    // into — a fixed canvas shape scaled to fit a much smaller/narrower box
    // (like initials) shrinks the text far more than into a signature box,
    // which is why initials were coming out nearly unreadable before this.
    const ratio = (boxWidthPts && boxHeightPts) ? (boxWidthPts / boxHeightPts) : (480 / 150);
    const canvasH = 200;
    const canvasW = Math.max(80, Math.round(canvasH * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = canvasW; canvas.height = canvasH;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#1C2B3A'; c.textBaseline = 'middle';
    // Font size is a fixed proportion of canvas height, so it reads at a
    // consistent, comfortable size no matter which field type it lands in —
    // then shrinks further only if this particular text is too wide to fit.
    let size = Math.round(canvasH * 0.5);
    c.font = `${size}px ${font}`;
    const maxWidth = canvasW - 20;
    while (size > 10 && c.measureText(text).width > maxWidth) {
      size -= 2;
      c.font = `${size}px ${font}`;
    }
    c.fillText(text, 10, canvas.height / 2);
    return canvas.toDataURL('image/png');
  }

  async function submitSignature(env, you) {
    const btn = document.getElementById('btnAdoptSign');
    btn.disabled = true; btn.textContent = 'Signing…';
    let blob, method;
    try {
      const fd = new FormData();
      if (activeMethod === 'saved') {
        fd.append('useSaved', 'true');
      } else {
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
        fd.append('signature', blob, 'signature.png');
        fd.append('method', method);
        const saveChk = document.getElementById('saveForFutureChk');
        if (saveChk && saveChk.checked) fd.append('saveForFuture', 'true');
      }
      fd.append('consent', 'true');
      const res = await fetch(`/sealwright/api/sign/${TOKEN}`, { method: 'POST', body: fd });
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
