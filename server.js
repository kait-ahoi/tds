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

async function splitPdfByProduct(buffer, baseFilename) {
  const pageTexts = [];
  await pdfParse(buffer, {
    pagerender: function(pageData) {
      return pageData.getTextContent().then(function(textContent) {
        const text = textContent.items.map(i => i.str).join(' ');
        pageTexts.push(text);
        return text;
      });
    }
  });

  const productStartPages = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const lower = pageTexts[i].toLowerCase();
    if (TDS_PAGE_MARKERS.some(m => lower.includes(m))) {
      productStartPages.push(i);
    }
  }

  if (productStartPages.length <= 1) return null;

  const srcDoc = await PDFDocument.load(buffer);
  const totalPages = srcDoc.getPageCount();
  const results = [];

  for (let p = 0; p < productStartPages.length; p++) {
    const startPage = productStartPages[p];
    const endPage = p + 1 < productStartPages.length ? productStartPages[p + 1] - 1 : totalPages - 1;

    const subDoc = await PDFDocument.create();
    const indices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
    const pages = await subDoc.copyPages(srcDoc, indices);
    pages.forEach(pg => subDoc.addPage(pg));

    const subBuffer = Buffer.from(await subDoc.save());
    const partFilename = baseFilename.replace(/\.pdf$/i, `_part${p + 1}.pdf`);
    results.push({ buffer: subBuffer, filename: partFilename });
  }

  return results;
}

async function sendToN8n(buffer, originalname, savedFilename = '') {
  const form = new FormData();
  form.append('fail', buffer, { filename: originalname, contentType: 'application/pdf' });
  if (savedFilename) form.append('saved_filename', savedFilename);
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
    fs.writeFileSync(path.join(UPLOAD_DIR, safeFilename), req.file.buffer);

    let parts = null;
    try {
      parts = await splitPdfByProduct(req.file.buffer, safeFilename);
    } catch (splitErr) {
      console.warn('PDF split skipped, sending as single:', splitErr.message);
    }

    if (parts) {
      console.log(`Multi-product PDF: ${parts.length} products detected in ${safeFilename}`);
      for (const part of parts) {
        fs.writeFileSync(path.join(UPLOAD_DIR, part.filename), part.buffer);
        await sendToN8n(part.buffer, part.filename, part.filename);
      }
      res.json({ ok: true, filename: safeFilename, parts: parts.length });
    } else {
      await sendToN8n(req.file.buffer, req.file.originalname, safeFilename);
      res.json({ ok: true, filename: safeFilename, parts: 1 });
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
    await sendToN8n(buffer, path.basename(file), path.basename(file));
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/rerun error:', e.message);
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
