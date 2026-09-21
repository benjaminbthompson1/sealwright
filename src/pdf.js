const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');

const DOCX_PAGE_W = 612, DOCX_PAGE_H = 792, DOCX_MARGIN = 54;

function wrapTextLines(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    let width;
    try { width = font.widthOfTextAtSize(test, size); } catch (e) { width = test.length * size * 0.5; }
    if (width > maxWidth && cur) { lines.push(cur); cur = w; } else { cur = test; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function formatDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Flows plain text onto fixed-size (612x792) pages in an existing pdf-lib
 * document, exactly the way it always has. Returns the ordered list of
 * PDFPage objects created — this is the piece that makes field placement
 * trustworthy: the sender places fields against pages rendered from this
 * exact function (via buildDocxDraftPdf, called on demand from plain_text),
 * and final stamping re-runs this exact same function, so page N is
 * guaranteed to be identically laid out both times, with no separate
 * docx-to-PDF rendering step (and no heavy dependency like LibreOffice or
 * headless Chromium) required.
 */
async function flowDocxText(pdfDoc, helv, plainText) {
  const paras = String(plainText || '').split(/\n+/).filter(p => p.trim());
  const pageList = [];
  let page = pdfDoc.addPage([DOCX_PAGE_W, DOCX_PAGE_H]);
  pageList.push(page);
  let y = DOCX_PAGE_H - 60;
  const maxW = DOCX_PAGE_W - DOCX_MARGIN * 2;
  for (const para of paras) {
    const lines = wrapTextLines(para, helv, 11, maxW);
    for (const line of lines) {
      if (y < 70) {
        page = pdfDoc.addPage([DOCX_PAGE_W, DOCX_PAGE_H]);
        pageList.push(page);
        y = DOCX_PAGE_H - 60;
      }
      page.drawText(line, { x: DOCX_MARGIN, y, size: 11, font: helv, color: rgb(0.11, 0.17, 0.23) });
      y -= 15;
    }
    y -= 8;
  }
  if (!pageList.length) pageList.push(page); // empty doc still gets one blank page
  return pageList;
}

/**
 * Unsigned "draft" PDF for a Word-document envelope, regenerated on demand
 * from the stored plain_text — used both by the sender's field-placement
 * editor and the signer's fill-in view, so both see exactly what the final
 * document's pages will look like.
 */
async function buildDocxDraftPdf(plainText) {
  const pdfDoc = await PDFDocument.create();
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  await flowDocxText(pdfDoc, helv, plainText);
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/**
 * Stamps one filled field onto its page at its stored position. x/y/width/height
 * are fractions of the page (0-1); y is measured from the TOP of the page (matching
 * how browsers measure things), so it's converted to PDF's bottom-left origin here.
 */
async function stampField(pdfDoc, page, pageWidth, pageHeight, helv, field) {
  const xPts = field.x * pageWidth;
  const wPts = field.width * pageWidth;
  const hPts = field.height * pageHeight;
  const yPts = pageHeight - (field.y * pageHeight) - hPts;

  if (field.field_type === 'signature' || field.field_type === 'initial') {
    if (!field.filled_image_bytes) return;
    try {
      const img = field.filled_image_mime === 'image/png'
        ? await pdfDoc.embedPng(field.filled_image_bytes)
        : await pdfDoc.embedJpg(field.filled_image_bytes);
      // Unlike the certificate page (a fixed general summary), the sender
      // explicitly sized this box, so the signature should fill it —
      // scaling up a small source image is correct here, not a defect.
      const scale = Math.min(wPts / img.width, hPts / img.height);
      const drawW = img.width * scale, drawH = img.height * scale;
      page.drawImage(img, { x: xPts + (wPts - drawW) / 2, y: yPts + (hPts - drawH) / 2, width: drawW, height: drawH });
    } catch (err) { console.warn('stamp signature/initial field failed', err.message); }
  } else if (field.field_type === 'date' || field.field_type === 'title') {
    const text = field.filled_text || '';
    const maxTextWidth = Math.max(4, wPts - 4);
    let size = Math.max(6, Math.min(hPts * 0.65, 12));
    // The previous version only sized to the box's HEIGHT, so a longer date
    // or title could run past the right edge of a narrow box. Shrinking
    // further until the actual text metrics fit the box's WIDTH too fixes that.
    while (size > 6) {
      let w;
      try { w = helv.widthOfTextAtSize(text, size); } catch (e) { w = text.length * size * 0.5; }
      if (w <= maxTextWidth) break;
      size -= 0.5;
    }
    page.drawText(text, { x: xPts + 2, y: yPts + (hPts - size) / 2, size, font: helv, color: rgb(0.11, 0.17, 0.23) });
  } else if (field.field_type === 'checkbox') {
    page.drawRectangle({ x: xPts, y: yPts, width: wPts, height: hPts, borderColor: rgb(0.11, 0.17, 0.23), borderWidth: 1 });
    if (field.filled_bool) {
      page.drawLine({ start: { x: xPts + 2, y: yPts + 2 }, end: { x: xPts + wPts - 2, y: yPts + hPts - 2 }, thickness: 1.6, color: rgb(0.11, 0.17, 0.23) });
      page.drawLine({ start: { x: xPts + 2, y: yPts + hPts - 2 }, end: { x: xPts + wPts - 2, y: yPts + 2 }, thickness: 1.6, color: rgb(0.11, 0.17, 0.23) });
    }
  }
}

/**
 * envelope: { id, title, source_type, file_name, original_bytes, plain_text, created_at, completed_at }
 * pages: [{ mime_type, image_bytes }] ordered by page_index (image-sourced envelopes only)
 * signers: [{ name, email, method, signed_at, signature_bytes, signature_mime }] ordered by order_index
 * fields: [{ page_index, x, y, width, height, field_type, filled_image_bytes, filled_image_mime,
 *            filled_text, filled_bool }] — optional; only meaningful for docx-sourced envelopes
 *            that used the field-placement editor. Omit/empty for the normal flow.
 */
async function buildFinalPdf(envelope, pages, signers, fields) {
  let pdfDoc;
  let docxPageList = null;

  if (envelope.source_type === 'pdf' && envelope.original_bytes) {
    pdfDoc = await PDFDocument.load(envelope.original_bytes, { ignoreEncryption: true });
  } else {
    pdfDoc = await PDFDocument.create();
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

    if (envelope.source_type === 'docx' && envelope.plain_text) {
      docxPageList = await flowDocxText(pdfDoc, helv, envelope.plain_text);
    } else if (envelope.source_type === 'image' && pages && pages.length) {
      for (const p of pages) {
        try {
          const img = p.mime_type === 'image/png'
            ? await pdfDoc.embedPng(p.image_bytes)
            : await pdfDoc.embedJpg(p.image_bytes);
          const pageW = 612, pageH = 792;
          const scale = Math.min((pageW - 72) / img.width, (pageH - 72) / img.height, 1);
          const w = img.width * scale, h = img.height * scale;
          const page = pdfDoc.addPage([pageW, pageH]);
          page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
        } catch (err) {
          console.warn('embed page image failed', err.message);
        }
      }
    } else {
      const page = pdfDoc.addPage([612, 792]);
      page.drawText('Original document content could not be rendered.', { x: 54, y: 700, size: 12, font: helv });
    }

    // Keep the original uploaded file attached to the package when we have it (e.g. the source .docx)
    if (envelope.original_bytes) {
      try {
        await pdfDoc.attach(envelope.original_bytes, envelope.file_name || 'original', {
          mimeType: envelope.mime_type || 'application/octet-stream',
          description: 'Original uploaded file'
        });
      } catch (err) {
        console.warn('attach original failed', err.message);
      }
    }
  }

  // Stamp any placed, filled fields onto their exact positions on the content
  // pages — additive to (not a replacement for) the certificate page below.
  if (docxPageList && fields && fields.length) {
    const helvPlain = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (const f of fields) {
      const page = docxPageList[f.page_index];
      if (!page) continue;
      await stampField(pdfDoc, page, DOCX_PAGE_W, DOCX_PAGE_H, helvPlain, f);
    }
  }

  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  let cert = pdfDoc.addPage([612, 792]);
  let y = 792 - 70;
  const margin = 54;

  cert.drawText('Certificate of Completion', { x: margin, y, size: 19, font: helvBold, color: rgb(0.11, 0.17, 0.23) });
  y -= 26;
  cert.drawText(envelope.title, { x: margin, y, size: 12, font: helv, color: rgb(0.36, 0.42, 0.47) });
  y -= 20;
  cert.drawText(`Envelope ID: ${envelope.id}`, { x: margin, y, size: 9.5, font: helv, color: rgb(0.55, 0.59, 0.56) });
  y -= 13;
  cert.drawText(`Created: ${formatDateTime(envelope.created_at)}    Completed: ${formatDateTime(envelope.completed_at)}`,
    { x: margin, y, size: 9.5, font: helv, color: rgb(0.55, 0.59, 0.56) });
  y -= 30;

  for (const s of signers) {
    if (y < 170) { cert = pdfDoc.addPage([612, 792]); y = 792 - 70; }
    cert.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: rgb(0.88, 0.86, 0.8) });
    y -= 18;
    cert.drawText(s.name, { x: margin, y, size: 12.5, font: helvBold, color: rgb(0.11, 0.17, 0.23) });
    y -= 15;
    cert.drawText(s.email, { x: margin, y, size: 10, font: helv, color: rgb(0.36, 0.42, 0.47) });
    y -= 15;
    cert.drawText(`Signed via ${s.method || 'electronic signature'} on ${formatDateTime(s.signed_at)}`,
      { x: margin, y, size: 10, font: helv, color: rgb(0.36, 0.42, 0.47) });
    y -= 12;
    if (s.signature_bytes) {
      try {
        const img = s.signature_mime === 'image/png'
          ? await pdfDoc.embedPng(s.signature_bytes)
          : await pdfDoc.embedJpg(s.signature_bytes);
        const boxW = 170, scale = Math.min(boxW / img.width, 55 / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        cert.drawImage(img, { x: margin, y: y - h, width: w, height: h });
        y -= (h + 16);
      } catch (err) {
        console.warn('embed signature image failed', err.message);
        y -= 16;
      }
    } else {
      y -= 10;
    }
  }
  y -= 6;
  cert.drawText('Sealed and executed via Sealwright.', { x: margin, y: Math.max(y, 40), size: 9, font: helv, color: rgb(0.66, 0.5, 0.24) });

  const pdfBytes = await pdfDoc.save();
  const buf = Buffer.from(pdfBytes);
  const fingerprint = crypto.createHash('sha256').update(buf).digest('hex');
  return { bytes: buf, fingerprint };
}

module.exports = { buildFinalPdf, buildDocxDraftPdf, DOCX_PAGE_W, DOCX_PAGE_H };
