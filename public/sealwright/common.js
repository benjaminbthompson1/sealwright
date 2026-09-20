/* global pdfjsLib, mammoth */
window.Sealwright = (function () {
  function escapeHtml(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatDateTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function todayLabel() { return new Date().toLocaleDateString(undefined, { dateStyle: 'medium' }); }

  function downscaleImage(dataUrl, maxDim) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = function () {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(file);
    });
  }
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
    });
  }
  function dataUrlToBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mime = meta.match(/data:(.*);base64/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  let pdfjsReady = false;
  function ensurePdfJs() {
    if (pdfjsReady) return true;
    if (typeof pdfjsLib === 'undefined') return false;
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch (e) {}
    pdfjsReady = true;
    return true;
  }

  async function renderPdfPagesFromArrayBuffer(buf, maxPages) {
    if (!ensurePdfJs()) return [];
    try {
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const n = Math.min(pdf.numPages, maxPages || 5);
      const images = [];
      for (let i = 1; i <= n; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.1 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        images.push(canvas.toDataURL('image/jpeg', 0.82));
      }
      return images;
    } catch (err) { console.warn('pdf render failed', err); return []; }
  }

  function sealSvg(size, extraClass) {
    size = size || 40;
    return `<svg class="seal-svg ${extraClass || ''}" width="${size}" height="${size}" viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="waxg2" cx="35%" cy="30%" r="75%">
        <stop offset="0%" stop-color="#A8404B"/><stop offset="65%" stop-color="#8C2F39"/><stop offset="100%" stop-color="#6E232B"/>
      </radialGradient></defs>
      <path d="M22,86 L30,102 L38,88 Z" fill="#A9803F"/>
      <path d="M78,86 L70,102 L62,88 Z" fill="#A9803F"/>
      <path d="M50,4 C71,4 90,19 92,43 C94,66 79,89 51,94 C26,97 7,74 8,47 C9,21 29,4 50,4 Z" fill="url(#waxg2)"/>
      <g transform="translate(50,49) rotate(-18)">
        <path d="M-2,-30 C6,-30 11,-20 9,-8 L3,26 L-3,26 L-9,-8 C-11,-20 -8,-30 -2,-30 Z" fill="#F7F4EE" opacity="0.95"/>
        <line x1="0" y1="-6" x2="0" y2="26" stroke="#8C2F39" stroke-width="1.4"/>
      </g>
      <circle cx="50" cy="49" r="34" fill="none" stroke="#F7F4EE" stroke-width="1.1" opacity="0.55"/>
    </svg>`;
  }

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    if (!res.ok) {
      let msg = 'Request failed';
      try { const j = await res.json(); msg = j.error || msg; } catch (e) {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res;
  }

  return {
    escapeHtml, formatDateTime, todayLabel, downscaleImage, readFileAsArrayBuffer, readFileAsDataURL,
    dataUrlToBlob, renderPdfPagesFromArrayBuffer, sealSvg, api
  };
})();
