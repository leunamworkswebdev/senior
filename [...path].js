/* Senior Master Carwash - the whole API as ONE Vercel function.
   Customer site and admin both use it, and both read the same Turso database,
   so a customer booking shows in admin and an admin change shows for the customer. */
'use strict';
const crypto = require('crypto');
const { SIZE_LABELS, VEHICLE_SIZES, SERVICES, getPrice, has } = require('../public/catalog.js');
const db = require('../lib/db.js');

const MAX = Math.max(1, parseInt(process.env.MAX_PER_SLOT || '10', 10) || 10);
const DAYS_AHEAD = 90;
const TZ_HOURS = Number(process.env.TZ_OFFSET_HOURS || 8); /* Philippines = UTC+8 */
const ADMIN_HOST = String(process.env.ADMIN_HOST || '').trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('smc|' + PASSWORD).digest('hex');
const SESSION_SECONDS = 8 * 3600;
const SLOTS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');
const TYPE_LABEL = { motorcycle: 'Motorcycle', taxi: 'Taxi', car: 'Car' };
const REF_RE = /^SMC-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error { constructor(status, message, errors) { super(message); this.status = status; this.errors = errors || {}; } }

/* ---------- helpers ---------- */
const now = () => { const d = new Date(Date.now() + TZ_HOURS * 3600000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
const validDate = (s) => DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const round2 = (n) => Math.round(n * 100) / 100;
const peso = (n) => '₱' + n.toLocaleString('en-US');
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
const part = (n) => Array.from(crypto.randomBytes(n), (x) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join('');

function send(res, status, obj) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); }
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(String(req.body)); } catch (e) { throw new HttpError(400, 'Invalid request.'); }
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw new HttpError(413, 'Request too large.'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Invalid request.'); }
}
async function rateLimit(key, limit, seconds, message) {
  const t = Math.floor(Date.now() / 1000);
  const rows = await db.query('INSERT INTO rate_limits (key, count, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires < ? THEN 1 ELSE count + 1 END, expires = CASE WHEN expires < ? THEN ? ELSE expires END RETURNING count',
    [key, t + seconds, t, t, t + seconds]);
  if (rows[0].count > limit) throw new HttpError(429, message);
}

/* ---------- bookings storage (Turso / SQLite) ---------- */
const toBooking = (r) => ({ reference: r.reference, name: r.name, phone: r.phone, vehicleType: r.vehicle_type, vehicleSize: r.vehicle_size, model: r.model, plate: r.plate, serviceId: r.service_id, service: r.service, vehicle: r.vehicle, date: r.date, time: r.time, priceValue: r.price_value, priceText: r.price_text, finalAmount: r.final_amount, notes: r.notes || '', status: r.status, createdAt: r.created_at || '', updatedAt: r.updated_at });
async function getBooking(ref) { const r = await db.query('SELECT * FROM bookings WHERE reference = ?', [ref]); return r.length ? toBooking(r[0]) : null; }
async function saveBooking(b) { b.updatedAt = new Date().toISOString(); await db.run('UPDATE bookings SET status = ?, final_amount = ?, updated_at = ? WHERE reference = ?', [b.status, b.finalAmount, b.updatedAt, b.reference]); }
async function loadAll() { return (await db.query('SELECT * FROM bookings')).map(toBooking); }
async function counts(date) {
  const out = SLOTS.map(() => 0);
  (await db.query("SELECT time, COUNT(*) AS n FROM bookings WHERE date = ? AND status != 'cancelled' GROUP BY time", [date])).forEach((r) => { const i = SLOTS.indexOf(r.time); if (i >= 0) out[i] = r.n; });
  return out;
}
/* One atomic statement: inserts only if the hour still has room. Returns 'ok', 'full' or 'dup'. */
async function insertBooking(b) {
  const affected = await db.run(
    "INSERT INTO bookings (reference, name, phone, vehicle_type, vehicle_size, model, plate, service_id, service, vehicle, date, time, price_value, price_text, final_amount, notes, status, created_at, updated_at) " +
    "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'pending',?,? WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE reference = ?) " +
    "AND (SELECT COUNT(*) FROM bookings WHERE date = ? AND time = ? AND status != 'cancelled') < ?",
    [b.reference, b.name, b.phone, b.vehicleType, b.vehicleSize, b.model, b.plate, b.serviceId, b.service, b.vehicle, b.date, b.time, b.priceValue, b.priceText, b.notes, b.createdAt, b.createdAt, b.reference, b.date, b.time, MAX]);
  if (affected === 1) return 'ok';
  return (await db.query('SELECT 1 AS x FROM bookings WHERE reference = ?', [b.reference])).length ? 'dup' : 'full';
}
const isPast = (date, time, n) => date < n.date || (date === n.date && time <= n.time);
const publicView = (b) => ({ reference: b.reference, name: b.name, phone: b.phone, vehicle: b.vehicle, service: b.service, date: b.date, time: b.time, price: b.priceText, notes: b.notes, status: b.status });
const adminView = (b) => ({ reference: b.reference, name: b.name, phone: b.phone, vehicle: b.vehicle, service: b.service, date: b.date, time: b.time, priceText: b.priceText, priceValue: b.priceValue, finalAmount: b.finalAmount, notes: b.notes, status: b.status });

async function cancelBooking(b) {
  if (b.status === 'cancelled') return;
  b.status = 'cancelled';
  await db.run("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE reference = ? AND status != 'cancelled'", [new Date().toISOString(), b.reference]);
}

/* ---------- public routes ---------- */
async function createBooking(req, res) {
  const body = await readBody(req), n = now(), errors = {};
  const name = clean(body.name, 80), phone = clean(body.phone, 20), model = clean(body.vehicleModel, 60);
  const plate = clean(body.plate, 12).toUpperCase().replace(/[^A-Z0-9 -]/g, '');
  const notes = clean(body.notes, 300), type = String(body.vehicleType || ''), size = String(body.vehicleSize || '');
  const serviceId = String(body.serviceId || ''), date = String(body.date || ''), time = String(body.time || '');
  if (!name) errors.fullName = 'Enter your full name.';
  if (!phone) errors.contactNumber = 'Enter your contact number.';
  else if (!/^(09|\+?639)\d{9}$/.test(phone.replace(/[\s-]/g, ''))) errors.contactNumber = 'Use a Philippine mobile number, e.g. 0917 123 4567.';
  if (!has(VEHICLE_SIZES, type)) errors.vehicleType = 'Select a vehicle type.';
  else if (!VEHICLE_SIZES[type].includes(size)) errors.vehicleSize = 'Select a vehicle size.';
  if (!model) errors.vehicleModel = 'Enter the vehicle make and model.';
  if (!has(SERVICES, serviceId) || (has(VEHICLE_SIZES, type) && !SERVICES[serviceId].vehicles.includes(type))) errors.serviceSelect = 'Select a service.';
  if (!validDate(date)) errors.bookingDate = 'Choose a date.';
  else if (date < n.date) errors.bookingDate = 'The date cannot be in the past.';
  else if (date > addDays(n.date, DAYS_AHEAD)) errors.bookingDate = 'Bookings open up to ' + DAYS_AHEAD + ' days ahead.';
  if (!SLOTS.includes(time)) errors.bookingTime = 'Choose a time.';
  else if (!errors.bookingDate && isPast(date, time, n)) errors.bookingTime = 'That time has already passed.';
  if (Object.keys(errors).length) throw new HttpError(400, 'Please fix the highlighted fields.', errors);

  await rateLimit('rl:book:' + ipOf(req), 12, 3600, 'Too many booking requests. Please try again later or call us.');
  const price = getPrice(serviceId, size);
  const b = {
    name, phone, vehicleType: type, vehicleSize: size, model, plate, serviceId, service: SERVICES[serviceId].label,
    vehicle: TYPE_LABEL[type] + ' (' + SIZE_LABELS[size] + '), ' + model + (plate ? ', ' + plate : ''),
    date, time, priceValue: typeof price === 'number' ? price : null, priceText: typeof price === 'number' ? peso(price) : 'Price to be confirmed',
    finalAmount: null, notes, status: 'pending', createdAt: new Date().toISOString()
  };
  for (let i = 0; i < 6; i++) {
    b.reference = 'SMC-' + part(4) + '-' + part(4);
    const r = await insertBooking(b);
    if (r === 'ok') return send(res, 201, { booking: publicView(b) });
    if (r === 'full') throw new HttpError(409, 'Sorry, that time is now full (maximum ' + MAX + ' cars). Please choose another time.', { bookingTime: 'That time is full. Choose another.' });
  }
  throw new Error('Could not create a reference.');
}

async function publicRoute(req, res, p, url, isPost) {
  const n = now();
  if (p === '/api/info' && !isPost) return send(res, 200, { maxPerSlot: MAX, maxDaysAhead: DAYS_AHEAD, now: n });
  if (p === '/api/availability' && !isPost) {
    const date = url.searchParams.get('date') || '';
    if (!validDate(date)) throw new HttpError(400, 'Choose a valid date.');
    const c = await counts(date);
    return send(res, 200, { date, maxPerSlot: MAX, now: n, slots: SLOTS.map((time, i) => ({ time, booked: c[i], full: c[i] >= MAX, past: isPast(date, time, n) })) });
  }
  if (p === '/api/bookings' && isPost) return createBooking(req, res);
  if (p === '/api/cancel' && isPost) {
    const body = await readBody(req), ref = String(body.reference || '');
    if (!REF_RE.test(ref)) throw new HttpError(400, 'Invalid reference.');
    const b = await getBooking(ref);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.status === 'completed') throw new HttpError(409, 'This booking is already completed.');
    await cancelBooking(b);
    return send(res, 200, { status: 'cancelled' });
  }
  if (p === '/api/status' && isPost) {
    const body = await readBody(req), refs = (Array.isArray(body.refs) ? body.refs : []).map(String).filter((r) => REF_RE.test(r)).slice(0, 20);
    const statuses = {};
    if (refs.length) (await db.query('SELECT reference, status FROM bookings WHERE reference IN (' + refs.map(() => '?').join(',') + ')', refs)).forEach((r) => { statuses[r.reference] = r.status; });
    return send(res, 200, { statuses });
  }
  if (p === '/api/assistant' && isPost) throw new HttpError(503, 'Assistant is not available.');
  throw new HttpError(404, 'Not found.');
}

/* ---------- admin ---------- */
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function authed(req) {
  const m = /(?:^|;\s*)smc_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookie(req, value, maxAge) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return 'smc_admin=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure;
}
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

async function adminRoute(req, res, p, url, isPost) {
  if (ADMIN_HOST && hostOf(req) !== ADMIN_HOST) throw new HttpError(404, 'Not found.');
  if (PASSWORD.length < 8) throw new HttpError(503, 'Admin password is not set. Add ADMIN_PASSWORD (8+ characters) in the Vercel project settings, then redeploy.');
  if (p === '/api/admin/login' && isPost) {
    const body = await readBody(req);
    await rateLimit('rl:login:' + ipOf(req), 8, 900, 'Too many attempts. Please wait 15 minutes.');
    if (!sameText(String(body.password || ''), PASSWORD)) throw new HttpError(401, 'Wrong password.');
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    res.setHeader('Set-Cookie', cookie(req, encodeURIComponent(exp + '.' + sign(exp)), SESSION_SECONDS));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/logout' && isPost) { res.setHeader('Set-Cookie', cookie(req, '', 0)); return send(res, 200, { ok: true }); }
  if (!authed(req)) throw new HttpError(401, 'Please sign in.');
  const n = now();
  if (p === '/api/admin/me') return send(res, 200, { ok: true });

  if (p === '/api/admin/bookings' && !isPost) {
    const all = await loadAll(), status = url.searchParams.get('status') || 'active', date = url.searchParams.get('date') || '', q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const c = { pending: 0, confirmed: 0, completed: 0, cancelled: 0, today: 0 };
    all.forEach((b) => { c[b.status]++; if (b.date === n.date && b.status !== 'cancelled') c.today++; });
    let list = all.filter((b) => (status === 'all' ? true : status === 'active' ? b.status === 'pending' || b.status === 'confirmed' : b.status === status)
      && (!date || b.date === date)
      && (!q || [b.name, b.phone, b.reference, b.vehicle, b.service].join(' ').toLowerCase().includes(q)));
    const asc = status === 'active' || status === 'pending' || status === 'confirmed';
    list.sort((a, b) => { const x = (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt); return asc ? x : -x; });
    return send(res, 200, { bookings: list.slice(0, 500).map(adminView), counts: c, now: n, maxPerSlot: MAX });
  }
  if (p === '/api/admin/bookings/status' && isPost) {
    const body = await readBody(req), b = REF_RE.test(String(body.reference || '')) ? await getBooking(body.reference) : null, to = String(body.status || '');
    if (!b) throw new HttpError(404, 'Booking not found.');
    const allowed = { pending: ['confirmed', 'completed', 'cancelled'], confirmed: ['completed', 'cancelled'] };
    if (!(allowed[b.status] || []).includes(to)) throw new HttpError(409, 'A ' + b.status + ' booking cannot be changed to ' + to + '.');
    if (to === 'cancelled') await cancelBooking(b);
    else {
      if (to === 'completed') {
        const amt = body.finalAmount === undefined || body.finalAmount === '' ? b.priceValue : Number(body.finalAmount);
        if (amt === null || !isFinite(amt) || amt < 0 || amt > 1000000) throw new HttpError(400, 'Enter the final amount (0 to 1,000,000).');
        b.finalAmount = round2(amt);
      }
      b.status = to; await saveBooking(b);
    }
    return send(res, 200, { booking: adminView(b) });
  }
  if (p === '/api/admin/bookings/amount' && isPost) {
    const body = await readBody(req), b = REF_RE.test(String(body.reference || '')) ? await getBooking(body.reference) : null, amt = Number(body.finalAmount);
    if (!b) throw new HttpError(404, 'Booking not found.');
    if (b.status !== 'completed') throw new HttpError(409, 'Only completed bookings have a final amount.');
    if (body.finalAmount === '' || !isFinite(amt) || amt < 0 || amt > 1000000) throw new HttpError(400, 'Enter an amount from 0 to 1,000,000.');
    b.finalAmount = round2(amt); await saveBooking(b);
    return send(res, 200, { booking: adminView(b) });
  }
  if (p === '/api/admin/earnings' && !isPost) {
    const all = await loadAll(), monthly = {}, yearly = {}, t = { allTime: 0, thisMonth: 0, thisYear: 0, jobs: 0, expected: 0 };
    const ym = n.date.slice(0, 7), yy = n.date.slice(0, 4), years = new Set([yy]);
    all.forEach((b) => {
      if (b.status === 'completed') {
        const v = b.finalAmount || 0, m = b.date.slice(0, 7), y = b.date.slice(0, 4); years.add(y);
        (monthly[m] = monthly[m] || { total: 0, count: 0 }); monthly[m].total = round2(monthly[m].total + v); monthly[m].count++;
        (yearly[y] = yearly[y] || { total: 0, count: 0 }); yearly[y].total = round2(yearly[y].total + v); yearly[y].count++;
        t.allTime += v; t.jobs++; if (m === ym) t.thisMonth += v; if (y === yy) t.thisYear += v;
      } else if ((b.status === 'pending' || b.status === 'confirmed') && b.priceValue) t.expected += b.priceValue;
    });
    Object.keys(t).forEach((k) => { t[k] = k === 'jobs' ? t[k] : round2(t[k]); });
    return send(res, 200, { monthly, yearly, now: n, years: [...years].sort(), totals: t });
  }
  if (p === '/api/admin/calendar' && !isPost) {
    const month = url.searchParams.get('month') || '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Invalid month.');
    const days = {}, slots = {};
    (await loadAll()).forEach((b) => {
      if (b.status === 'cancelled' || b.date.slice(0, 7) !== month) return;
      const d = (days[b.date] = days[b.date] || { count: 0, pending: 0, peak: 0, full: false });
      d.count++; if (b.status === 'pending') d.pending++;
      const k = b.date + b.time; slots[k] = (slots[k] || 0) + 1;
      if (slots[k] > d.peak) d.peak = slots[k];
      d.full = d.peak >= MAX;
    });
    return send(res, 200, { month, maxPerSlot: MAX, days, now: n });
  }
  if (p === '/api/admin/day' && !isPost) {
    const date = url.searchParams.get('date') || '';
    if (!validDate(date)) throw new HttpError(400, 'Invalid date.');
    const list = (await loadAll()).filter((b) => b.date === date && b.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return send(res, 200, { date, maxPerSlot: MAX, now: n, slots: SLOTS.map((time) => { const bk = list.filter((b) => b.time === time); return { time, booked: bk.length, full: bk.length >= MAX, bookings: bk.map(adminView) }; }) });
  }
  if (p === '/api/admin/export.csv' && !isPost) {
    const all = (await loadAll()).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const rows = [['Reference', 'Date', 'Time', 'Customer', 'Phone', 'Vehicle', 'Service', 'Status', 'Estimated price', 'Final amount', 'Notes', 'Created']]
      .concat(all.map((b) => [b.reference, b.date, b.time, b.name, b.phone, b.vehicle, b.service, b.status, b.priceText, b.finalAmount == null ? '' : b.finalAmount, b.notes, b.createdAt]));
    res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
    return res.end('\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
  }
  throw new HttpError(404, 'Not found.');
}

/* ---------- entry point ---------- */
module.exports = async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://localhost'), p = url.pathname.replace(/\/+$/, '') || '/', isPost = req.method === 'POST';
    if (req.method !== 'GET' && !isPost) throw new HttpError(405, 'Method not allowed.');
    if (isPost && !req.headers['x-requested-with']) throw new HttpError(403, 'Forbidden.');
    if (p !== '/api/info') await db.ensureSchema();
    if (p.startsWith('/api/admin/')) return await adminRoute(req, res, p, url, isPost);
    return await publicRoute(req, res, p, url, isPost);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, errors: e.errors });
    if (e && e.code === 'NO_DB') return send(res, 503, { error: 'Booking system is not set up yet: the database is not connected.' });
    console.error(e);
    return send(res, 500, { error: 'Server error. Please try again.' });
  }
};
