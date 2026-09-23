const { PDFDocument } = require('pdf-lib');
const crypto = require('crypto');

/**
 * document: { title }
 * pages: [{ mime_type, image_bytes }] already in the document's display order
 */
async function buildScanPdf(document, pages) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(document.title || 'Scanned document');

  for (const p of pages) {
    try {
      const img = p.mime_type === 'image/png'
        ? await pdfDoc.embedPng(p.image_bytes)
        : await pdfDoc.embedJpg(p.image_bytes);
      // One page per image, sized to the photo's own aspect ratio (rather than
      // forcing everything onto fixed US-Letter/A4 pages) — scans are usually
      // already page-shaped after the client-side crop, and this avoids
      // unnecessary letterboxing for receipts, IDs, etc.
      const maxDim = 792; // keep pages within a normal print-size ceiling
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      const page = pdfDoc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    } catch (err) {
      console.warn('scanline: embed page image failed', err.message);
    }
  }

  if (pdfDoc.getPageCount() === 0) {
    const page = pdfDoc.addPage([612, 792]);
    page.drawText('This document has no pages.', { x: 54, y: 700, size: 12 });
  }

  const pdfBytes = await pdfDoc.save();
  const buf = Buffer.from(pdfBytes);
  const fingerprint = crypto.createHash('sha256').update(buf).digest('hex');
  return { bytes: buf, fingerprint };
}

module.exports = { buildScanPdf };
