require('dotenv').config();
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const TDS_PAGE_MARKERS = ['technical data sheet', 'techninių duomenų lapas'];

function extractProductNameFromText(text) {
  const lower = text.toLowerCase();
  let searchFrom = 0;
  for (const marker of TDS_PAGE_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) { searchFrom = idx + marker.length; break; }
  }
  let shellIdx = lower.indexOf('shell', searchFrom);
  if (shellIdx === -1) shellIdx = lower.indexOf('shell');
  if (shellIdx === -1) return '';
  const words = text.substring(shellIdx).split(/\s+/);
  const name = [];
  for (const w of words) {
    if (!w) continue;
    if (name.length >= 7) break;
    if (/^(technical|data|sheet|techninių|duomenų|lapas)$/i.test(w)) break;
    if (/^\d{5,}$/.test(w)) break;
    name.push(w);
  }
  return name.join('_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

async function splitPdfByProduct(buffer, baseFilename) {
  const fullParsed = await pdfParse(buffer);
  const fullText = fullParsed.text;
  const lowerFull = fullText.toLowerCase();

  const markerPositions = [];
  for (const marker of TDS_PAGE_MARKERS) {
    let pos = 0;
    while (true) {
      const idx = lowerFull.indexOf(marker, pos);
      if (idx === -1) break;
      markerPositions.push(idx);
      pos = idx + marker.length;
    }
  }
  markerPositions.sort((a, b) => a - b);

  console.log(`TDS markers in full text: ${markerPositions.length}`);
  if (markerPositions.length <= 1) return null;

  const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();
  const pagesPerProduct = Math.round(totalPages / markerPositions.length);
  console.log(`PDF split: ${totalPages} pages, ${markerPositions.length} products, ${pagesPerProduct} pages/product`);

  const results = [];
  const usedNames = new Set();
  for (let p = 0; p < markerPositions.length; p++) {
    const startPage = p * pagesPerProduct;
    const endPage = p + 1 < markerPositions.length
      ? Math.min((p + 1) * pagesPerProduct - 1, totalPages - 1)
      : totalPages - 1;

    const subDoc = await PDFDocument.create();
    const indices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
    const pages = await subDoc.copyPages(srcDoc, indices);
    pages.forEach(pg => subDoc.addPage(pg));

    const subBuffer = Buffer.from(await subDoc.save());
    const sectionEnd = p + 1 < markerPositions.length ? markerPositions[p + 1] : fullText.length;
    const sectionText = fullText.slice(markerPositions[p], sectionEnd);
    const productName = extractProductNameFromText(fullText.slice(markerPositions[p], markerPositions[p] + 300));
    let partFilename = productName
      ? `${productName}.pdf`
      : baseFilename.replace(/\.pdf$/i, `_part${p + 1}.pdf`);
    if (usedNames.has(partFilename)) {
      const base = partFilename.replace(/\.pdf$/i, '');
      let n = 2;
      while (usedNames.has(`${base}_${n}.pdf`)) n++;
      partFilename = `${base}_${n}.pdf`;
    }
    usedNames.add(partFilename);
    console.log(`Product ${p + 1}: "${fullText.slice(markerPositions[p], markerPositions[p] + 80).replace(/\n/g, '↵')}" → ${partFilename}`);
    results.push({ buffer: subBuffer, filename: partFilename, text: sectionText });
  }

  return results;
}

async function sendToN8n(buffer, originalname, savedFilename = '', pdfText = '') {
  const form = new FormData();
  form.append('fail', buffer, { filename: savedFilename || originalname, contentType: 'application/pdf' });
  if (savedFilename) form.append('saved_filename', savedFilename);
  if (pdfText) form.append('pdf_text', pdfText);
  await axios.post(process.env.N8N_FORM_URL, form, { headers: form.getHeaders() });
}

const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

app.post('/api/submit', upload.single('fail'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const safeFilename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

    let parts = null;
    try {
      parts = await splitPdfByProduct(req.file.buffer, safeFilename);
    } catch (splitErr) {
      console.warn('PDF split skipped, sending as single:', splitErr.message);
    }

    if (parts) {
      fs.writeFileSync(path.join(UPLOAD_DIR, safeFilename), req.file.buffer);
      console.log(`Multi-product PDF: ${parts.length} products detected in ${safeFilename}`);
      for (const part of parts) {
        fs.writeFileSync(path.join(UPLOAD_DIR, part.filename), part.buffer);
        await sendToN8n(part.buffer, part.filename, part.filename, part.text);
      }
      res.json({ ok: true, filename: safeFilename, parts: parts.length });
    } else {
      let storageFilename = safeFilename;
      let pdfText = '';
      try {
        const parsed = await pdfParse(req.file.buffer);
        pdfText = parsed.text;
        const productName = extractProductNameFromText(parsed.text);
        if (productName) storageFilename = `${productName}.pdf`;
      } catch(e) {}
      fs.writeFileSync(path.join(UPLOAD_DIR, storageFilename), req.file.buffer);
      await sendToN8n(req.file.buffer, storageFilename, storageFilename, pdfText);
      res.json({ ok: true, filename: storageFilename, parts: 1 });
    }
  } catch (e) {
    console.error('/api/submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rerun/:filename', async (req, res) => {
  const file = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  try {
    const buffer = fs.readFileSync(file);
    let pdfText = '';
    try {
      const parsed = await pdfParse(buffer);
      pdfText = parsed.text;
    } catch(e) {}
    await sendToN8n(buffer, path.basename(file), path.basename(file), pdfText);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/rerun error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pdf/rename', (req, res) => {
  const { oldname, newname } = req.body;
  if (!oldname || !newname) return res.status(400).json({ error: 'Missing params' });
  const oldPath = path.join(UPLOAD_DIR, path.basename(oldname));
  const newPath = path.join(UPLOAD_DIR, path.basename(newname));
  if (!fs.existsSync(oldPath)) return res.json({ ok: true, skipped: 'not found' });
  if (fs.existsSync(newPath)) return res.json({ ok: true, skipped: 'exists' });
  try {
    fs.renameSync(oldPath, newPath);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pdf/:filename', (req, res) => {
  const file = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(file).pipe(res);
});

app.get('/api/rows', async (req, res) => {
  try {
    const { data } = await axios.get(
      `${process.env.N8N_BASE_URL}/api/v1/data-tables/${process.env.N8N_TABLE_ID}/rows`,
      { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY } }
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notify', async (req, res) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({ error: 'SMTP not configured' });
  }
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: 'kait@jungent.eu',
      subject: req.body.subject || 'TDS viga',
      text: req.body.text || ''
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(process.env.PORT || 3000, () =>
  console.log('TDS app running on port', process.env.PORT || 3000)
);
