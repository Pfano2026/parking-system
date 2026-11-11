'use strict';
/* =====================================================================
   SmartPark IoT - server.js
   Express web server + PostgreSQL. Hosted on Render.
   - Serves the website from /public
   - Customer API  : bays, bookings (PIN emailed), inbox
   - Admin API     : login, booking switch, gates, hourly rate, bookings list
   - ESP32 API     : sync (heartbeat + IR sensors), verify-pin (keypad)
   ===================================================================== */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

// ---------- configuration (Render "Environment" variables) ----------
const PORT = process.env.PORT || 3000;
const ESP32_API_KEY = process.env.ESP32_API_KEY || 'smartpark-esp32-key';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'smartpark-dev-secret-change-me';
const OFFLINE_AFTER_MS = 12000;      // no ESP32 sync for 12 s  => OFFLINE
const RESERVE_TIMEOUT_MIN = 30;      // unused reservation is released after 30 min

// Email: Brevo HTTPS API (works on Render free) or classic SMTP (needs a paid Render plan)
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'SmartPark IoT';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add your Render PostgreSQL URL as an environment variable.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

let smtp = null;
if (!BREVO_API_KEY && process.env.SMTP_HOST) {
  smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// ---------- helpers ----------
const wrap = fn => (req, res, next) => fn(req, res, next).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

function requireAdmin(req, res, next) {
  const h = req.get('authorization') || '';
  const payload = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!payload) return res.status(401).json({ error: 'Please log in again.' });
  next();
}
function requireDevice(req, res, next) {
  if (!safeEqual(req.get('x-api-key') || '', ESP32_API_KEY)) {
    return res.status(401).json({ ok: false, error: 'Bad API key' });
  }
  next();
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => 'R' + Number(n || 0).toFixed(2);

function computeFee(rate, startMs, endMs) {
  const hours = Math.max(1, Math.ceil((endMs - startMs) / 3600000)); // billed per started hour, min 1 hour
  return hours * Number(rate);
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return { systemOpen: s.system_open === 'true', rate: Number(s.hourly_rate || 20) };
}

async function expireReservations() {
  await pool.query(
    `UPDATE bookings SET status = 'expired', ended_at = NOW()
     WHERE status = 'reserved' AND created_at < NOW() - make_interval(mins => $1::int)`,
    [RESERVE_TIMEOUT_MIN]
  );
}

// available | reserved | occupied  (occupied = IR sensor sees a vehicle)
async function bayStatuses() {
  const [bays, open] = await Promise.all([
    pool.query('SELECT id, name, ir_occupied FROM bays ORDER BY id'),
    pool.query(`SELECT bay_id FROM bookings WHERE status IN ('reserved','active')`)
  ]);
  const held = new Set(open.rows.map(r => r.bay_id));
  return bays.rows.map(b => ({
    id: b.id,
    name: b.name,
    ir: b.ir_occupied,
    status: b.ir_occupied ? 'occupied' : (held.has(b.id) ? 'reserved' : 'available')
  }));
}

async function deviceInfo() {
  const { rows } = await pool.query('SELECT last_seen, ip, rssi, uptime_s FROM device_status WHERE id = 1');
  const d = rows[0] || {};
  const online = !!d.last_seen && Date.now() - new Date(d.last_seen).getTime() < OFFLINE_AFTER_MS;
  return { online, lastSeen: d.last_seen || null, ip: d.ip || null, rssi: d.rssi, uptime: d.uptime_s };
}

// ---------- email ----------
async function deliver(to, subject, text) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-line">${escHtml(text)}</div>`;
  if (BREVO_API_KEY && MAIL_FROM) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
        to: [{ email: to }],
        subject, textContent: text, htmlContent: html
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text()));
    return 'sent';
  }
  if (smtp && MAIL_FROM) {
    await smtp.sendMail({ from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`, to, subject, text, html });
    return 'sent';
  }
  return 'inbox-only'; // no email provider configured: the message is still stored for the Email Inbox tab
}

async function sendEmail(bookingId, to, subject, text) {
  let delivery;
  try { delivery = await deliver(to, subject, text); }
  catch (e) { console.error('Email failed:', e.message); delivery = 'failed'; }
  await pool.query(
    'INSERT INTO emails (booking_id, to_email, subject, body, delivery) VALUES ($1,$2,$3,$4,$5)',
    [bookingId, to, subject, text, delivery]
  );
  return delivery;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

// ===== Customer API =====
app.get('/api/status', wrap(async (req, res) => {
  await expireReservations();
  const [settings, bays, device] = await Promise.all([getSettings(), bayStatuses(), deviceInfo()]);
  res.json({
    serverTime: Date.now(),
    esp32: device,
    systemOpen: settings.systemOpen,
    rate: settings.rate,
    reserveTimeoutMin: RESERVE_TIMEOUT_MIN,
    bays
  });
}));

app.post('/api/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const bayId = parseInt(b.bayId, 10);
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const plate = String(b.plate || '').trim().toUpperCase();

  if (!(bayId >= 1 && bayId <= 4)) return res.status(400).json({ error: 'Choose a bay from 1 to 4.' });
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^[A-Z0-9 -]{2,12}$/.test(plate)) return res.status(400).json({ error: 'Enter a valid number plate (letters, numbers, spaces).' });

  await expireReservations();
  const settings = await getSettings();
  if (!settings.systemOpen) return res.status(403).json({ error: 'Bookings are closed by the administrator.' });

  const { rows: bayRows } = await pool.query('SELECT name, ir_occupied FROM bays WHERE id = $1', [bayId]);
  if (!bayRows.length) return res.status(400).json({ error: 'Unknown bay.' });
  if (bayRows[0].ir_occupied) return res.status(409).json({ error: bayRows[0].name + ' is occupied.' });

  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM bookings WHERE LOWER(email) = $1 AND status IN ('reserved','active')`, [email]);
  if (cnt[0].n >= 2) return res.status(409).json({ error: 'This email already has 2 open bookings.' });

  const token = crypto.randomBytes(16).toString('hex');
  let booking = null;
  for (let attempt = 0; attempt < 25 && !booking; attempt++) {
    const pin = String(crypto.randomInt(1000, 10000));
    try {
      const { rows } = await pool.query(
        `INSERT INTO bookings (bay_id, customer_name, email, plate, pin, access_token, rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, pin`,
        [bayId, name, email, plate, pin, token, settings.rate]);
      booking = rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'one_open_booking_per_bay') {
        return res.status(409).json({ error: bayRows[0].name + ' was just booked by someone else.' });
      }
      if (err.code === '23505') continue; // PIN already in use: try another
      throw err;
    }
  }
  if (!booking) return res.status(500).json({ error: 'Could not create a PIN. Try again.' });

  const text =
`Hi ${name},

Your parking bay is reserved.

Bay: ${bayRows[0].name}
Your PIN: ${booking.pin}
Number plate: ${plate}

How to use your PIN:
1. At the entrance keypad, type the PIN and press #. The entry gate opens.
2. When you leave, type the same PIN at the keypad and press #. The exit gate opens and your session ends.

This reservation is held for ${RESERVE_TIMEOUT_MIN} minutes.
Rate: ${money(settings.rate)} per hour (billed per started hour).
Do not share your PIN with anyone.

SmartPark IoT`;
  const delivery = await sendEmail(booking.id, email, 'Your parking PIN for ' + bayRows[0].name, text);

  res.json({ ok: true, booking: { id: booking.id, bayId, bayName: bayRows[0].name, token, emailDelivery: delivery } });
}));

function bookingView(r) {
  const est = r.status === 'active' ? computeFee(r.rate, new Date(r.checked_in_at).getTime(), Date.now()) : Number(r.fee);
  return {
    id: r.id, bayId: r.bay_id, bayName: 'Bay ' + r.bay_id, status: r.status, plate: r.plate,
    email: r.email, rate: Number(r.rate), fee: est,
    createdAt: r.created_at, checkedInAt: r.checked_in_at, endedAt: r.ended_at,
    expiresAt: new Date(new Date(r.created_at).getTime() + RESERVE_TIMEOUT_MIN * 60000).toISOString()
  };
}
function parseTokens(req) {
  return String(req.get('x-tokens') || '').split(',').map(s => s.trim()).filter(s => /^[a-f0-9]{32}$/.test(s)).slice(0, 20);
}

app.get('/api/bookings/mine', wrap(async (req, res) => {
  const tokens = parseTokens(req);
  if (!tokens.length) return res.json({ bookings: [] });
  await expireReservations();
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE access_token = ANY($1) ORDER BY id DESC LIMIT 20', [tokens]);
  res.json({ bookings: rows.map(r => ({ ...bookingView(r), token: r.access_token })) });
}));

app.post('/api/bookings/cancel', wrap(async (req, res) => {
  const token = String((req.body || {}).token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ error: 'Invalid booking.' });
  const { rowCount } = await pool.query(
    `UPDATE bookings SET status = 'cancelled', ended_at = NOW() WHERE access_token = $1 AND status = 'reserved'`, [token]);
  if (!rowCount) return res.status(409).json({ error: 'Only a reservation that has not been used yet can be cancelled.' });
  res.json({ ok: true });
}));

app.get('/api/inbox', wrap(async (req, res) => {
  const tokens = parseTokens(req);
  if (!tokens.length) return res.json({ emails: [] });
  const { rows } = await pool.query(
    `SELECT e.id, e.to_email, e.subject, e.body, e.delivery, e.created_at
     FROM emails e JOIN bookings b ON b.id = e.booking_id
     WHERE b.access_token = ANY($1) ORDER BY e.id DESC LIMIT 50`, [tokens]);
  res.json({ emails: rows });
}));

// IR simulator for demos when the ESP32 is switched off
app.post('/api/simulate/ir', wrap(async (req, res) => {
  const device = await deviceInfo();
  if (device.online) return res.status(409).json({ error: 'ESP32 is online. The real IR sensors are in control.' });
  const bay = parseInt((req.body || {}).bay, 10);
  if (!(bay >= 1 && bay <= 4)) return res.status(400).json({ error: 'Bad bay.' });
  await pool.query('UPDATE bays SET ir_occupied = $2, updated_at = NOW() WHERE id = $1', [bay, !!(req.body || {}).occupied]);
  res.json({ ok: true });
}));

// ===== Admin API =====
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (safeEqual(username || '', ADMIN_USER) && safeEqual(password || '', ADMIN_PASS)) {
    return res.json({ token: signToken({ u: ADMIN_USER, exp: Date.now() + 8 * 3600 * 1000 }) });
  }
  res.status(401).json({ error: 'Invalid username or password.' });
});

app.get('/api/admin/overview', requireAdmin, wrap(async (req, res) => {
  await expireReservations();
  const [settings, list, rev] = await Promise.all([
    getSettings(),
    pool.query('SELECT * FROM bookings ORDER BY id DESC LIMIT 200'),
    pool.query(`SELECT COALESCE(SUM(fee),0) AS total FROM bookings WHERE status = 'completed'`)
  ]);
  res.json({
    systemOpen: settings.systemOpen,
    rate: settings.rate,
    revenue: Number(rev.rows[0].total),
    bookings: list.rows.map(r => ({ ...bookingView(r), name: r.customer_name }))
  });
}));

app.post('/api/admin/system', requireAdmin, wrap(async (req, res) => {
  const open = !!(req.body || {}).open;
  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'system_open'`, [String(open)]);
  res.json({ ok: true, systemOpen: open });
}));

app.post('/api/admin/rate', requireAdmin, wrap(async (req, res) => {
  const rate = Number((req.body || {}).rate);
  if (!(rate >= 0 && rate <= 10000)) return res.status(400).json({ error: 'Enter a rate between 0 and 10000.' });
  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'hourly_rate'`, [String(rate)]);
  res.json({ ok: true, rate });
}));

app.post('/api/admin/gate', requireAdmin, wrap(async (req, res) => {
  const gate = (req.body || {}).gate;
  if (gate !== 'entry' && gate !== 'exit') return res.status(400).json({ error: 'Bad gate.' });
  const device = await deviceInfo();
  await pool.query('INSERT INTO commands (type) VALUES ($1)', ['open_' + gate]);
  res.json({ ok: true, deviceOnline: device.online });
}));

// ===== ESP32 API =====
// Called every ~3 s: sends the 4 IR sensor readings, receives bay states + manual gate commands
app.post('/api/esp32/sync', requireDevice, wrap(async (req, res) => {
  const b = req.body || {};
  const irs = Array.isArray(b.bays) ? b.bays.slice(0, 4) : [];
  for (let i = 0; i < irs.length; i++) {
    await pool.query('UPDATE bays SET ir_occupied = $2, updated_at = NOW() WHERE id = $1 AND ir_occupied <> $2', [i + 1, !!irs[i]]);
  }
  await pool.query(
    'UPDATE device_status SET last_seen = NOW(), ip = $1, rssi = $2, uptime_s = $3 WHERE id = 1',
    [String(b.ip || '').slice(0, 40), Number.isFinite(Number(b.rssi)) ? Number(b.rssi) : null, Number.isFinite(Number(b.uptime)) ? Number(b.uptime) : null]);
  await expireReservations();
  const cmds = await pool.query(
    `UPDATE commands SET consumed = TRUE WHERE consumed = FALSE AND created_at > NOW() - INTERVAL '2 minutes' RETURNING type`);
  const [settings, bays] = await Promise.all([getSettings(), bayStatuses()]);
  res.json({ ok: true, systemOpen: settings.systemOpen, rate: settings.rate, bays: bays.map(x => x.status), commands: cmds.rows.map(c => c.type) });
}));

// Keypad: same PIN opens the entry gate (reserved -> active) and later the exit gate (active -> completed)
app.post('/api/esp32/verify-pin', requireDevice, wrap(async (req, res) => {
  const pin = String((req.body || {}).pin || '');
  if (!/^\d{4}$/.test(pin)) return res.json({ ok: false, reason: 'invalid' });
  const { rows } = await pool.query(`SELECT * FROM bookings WHERE pin = $1 AND status IN ('reserved','active') LIMIT 1`, [pin]);
  if (!rows.length) return res.json({ ok: false, reason: 'invalid' });
  const bk = rows[0];

  if (bk.status === 'reserved') {
    await pool.query(`UPDATE bookings SET status = 'active', checked_in_at = NOW() WHERE id = $1`, [bk.id]);
    return res.json({ ok: true, action: 'entry', gate: 0, bay: bk.bay_id });
  }
  const fee = computeFee(bk.rate, new Date(bk.checked_in_at).getTime(), Date.now());
  await pool.query(`UPDATE bookings SET status = 'completed', ended_at = NOW(), fee = $2 WHERE id = $1`, [bk.id, fee]);
  sendEmail(bk.id, bk.email, 'Thank you for parking with SmartPark IoT',
`Hi ${bk.customer_name},

Your parking session in Bay ${bk.bay_id} has ended.
Total fee: ${money(fee)}

Thank you for parking with us.

SmartPark IoT`).catch(() => {});
  res.json({ ok: true, action: 'exit', gate: 1, bay: bk.bay_id, fee });
}));

// ---------- start ----------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('Database ready.');
  } catch (e) {
    console.error('Database setup failed:', e.message);
    process.exit(1);
  }
  const mode = BREVO_API_KEY ? 'Brevo API' : (smtp ? 'SMTP' : 'none (Email Inbox tab only)');
  app.listen(PORT, () => console.log(`SmartPark IoT running on port ${PORT}. Email provider: ${mode}`));
})();
