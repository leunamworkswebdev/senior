/* Turso (libSQL) client over plain HTTPS - no packages needed.
   Env vars: TURSO_DATABASE_URL (libsql://... or https://...) and TURSO_AUTH_TOKEN. */
'use strict';
function conf() {
  let url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
  const token = process.env.TURSO_AUTH_TOKEN || '';
  if (!url) { const e = new Error('Database is not connected.'); e.code = 'NO_DB'; throw e; }
  url = url.trim().replace(/^libsql:\/\//, 'https://').replace(/^wss?:\/\//, 'https://').replace(/\/+$/, '');
  return { url, token };
}
const arg = (v) => {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
};
const val = (c) => (!c || c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.type === 'float' ? Number(c.value) : c.value);

/* Run several statements in order in one request. stmts = [[sql, [args]], ...]. Returns [{rows, affected}] */
async function batch(stmts) {
  const { url, token } = conf();
  const requests = stmts.map(([sql, args]) => ({ type: 'execute', stmt: { sql, args: (args || []).map(arg) } }));
  requests.push({ type: 'close' });
  const res = await fetch(url + '/v2/pipeline', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify({ requests })
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error('Database error ' + res.status + ': ' + (data.error || data.message || ''));
  return stmts.map((_, i) => {
    const r = data.results && data.results[i];
    if (!r || r.type !== 'ok') throw new Error('Database error: ' + (r && r.error ? r.error.message : 'no result'));
    const out = r.response.result, names = out.cols.map((c) => c.name);
    return { affected: out.affected_row_count || 0, rows: out.rows.map((row) => { const o = {}; row.forEach((c, j) => { o[names[j]] = val(c); }); return o; }) };
  });
}
const query = async (sql, args) => (await batch([[sql, args]]))[0].rows;
const run = async (sql, args) => (await batch([[sql, args]]))[0].affected;

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = batch([
      ['CREATE TABLE IF NOT EXISTS bookings (reference TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, vehicle_type TEXT, vehicle_size TEXT, model TEXT, plate TEXT, service_id TEXT, service TEXT, vehicle TEXT, date TEXT NOT NULL, time TEXT NOT NULL, price_value REAL, price_text TEXT, final_amount REAL, notes TEXT, status TEXT NOT NULL, created_at TEXT, updated_at TEXT)'],
      ['CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings (date, time, status)'],
      ['CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)']
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
module.exports = { batch, query, run, ensureSchema };
