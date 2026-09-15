const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');

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
 * envelope: { id, title, source_type, file_name, original_bytes, plain_text, created_at, completed_at }
 * pages: [{ mime_type, image_bytes }] ordered by page_index (image-sourced envelopes only)
 * signers: [{ name, email, method, signed_at, signature_bytes, signature_mime }] ordered by order_index
 */
async function buildFinalPdf(envelope, pages, signers) {
  let pdfDoc;

  if (envelope.source_type === 'pdf' && envelope.original_bytes) {
    pdfDoc = await PDFDocument.load(envelope.original_bytes, { ignoreEncryption: true });
  } else {
    pdfDoc = await PDFDocument.create();
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

    if (envelope.source_type === 'docx' && envelope.plain_text) {
      const paras = envelope.plain_text.split(/\n+/).filter(p => p.trim());
      let page = pdfDoc.addPage([612, 792]);
      let y = 792 - 60;
      const margin = 54, maxW = 612 - margin * 2;
      for (const para of paras) {
        const lines = wrapTextLines(para, helv, 11, maxW);
        for (const line of lines) {
          if (y < 70) { page = pdfDoc.addPage([612, 792]); y = 792 - 60; }
          page.drawText(line, { x: margin, y, size: 11, font: helv, color: rgb(0.11, 0.17, 0.23) });
          y -= 15;
        }
        y -= 8;
      }
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

module.exports = { buildFinalPdf };
