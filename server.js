require('dotenv').config();
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

async function splitPdf(buffer, pagesPerChunk = 4) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (total <= pagesPerChunk) return [buffer];
  const chunks = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const doc = await PDFDocument.create();
    const end = Math.min(start + pagesPerChunk, total);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await doc.copyPagesFrom(src, indices);
    pages.forEach(p => doc.addPage(p));
    chunks.push(Buffer.from(await doc.save()));
  }
  return chunks;
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
    const chunks = await splitPdf(req.file.buffer, 4);
    for (const chunk of chunks) {
      const form = new FormData();
      form.append('fail', chunk, {
        filename: req.file.originalname,
        contentType: 'application/pdf'
      });
      await axios.post(process.env.N8N_FORM_URL, form, { headers: form.getHeaders() });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
