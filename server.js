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

function splitByProduct(text) {
  const markers = ['technical data sheet', 'techninių duomenų lapas'];
  const lower = text.toLowerCase();
  const positions = [];
  for (const marker of markers) {
    let idx = 0;
    while ((idx = lower.indexOf(marker, idx)) !== -1) {
      positions.push(idx);
      idx += marker.length;
    }
  }
  positions.sort((a, b) => a - b);
  if (positions.length <= 1) return [text];
  const sections = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : text.length;
    const section = text.substring(start, end).trim();
    if (section.length > 100) sections.push(section);
  }
  return sections.length ? sections : [text];
}

async function sendToN8n(buffer, originalname, savedFilename = '') {
  const { text } = await pdfParse(buffer);
  const sections = splitByProduct(text);
  for (let i = 0; i < sections.length; i++) {
    const form = new FormData();
    form.append('pdf_text', sections[i]);
    form.append('original_filename', originalname);
    if (savedFilename) form.append('saved_filename', savedFilename);
    await axios.post(process.env.N8N_FORM_URL, form, { headers: form.getHeaders() });
    if (i < sections.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
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
    await sendToN8n(req.file.buffer, req.file.originalname, safeFilename);
    res.json({ ok: true, filename: safeFilename });
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
