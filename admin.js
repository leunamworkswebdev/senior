/* Senior Master Carwash - admin (bookings, earnings graph, calendar). Talks to server.js only. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;
  const pad = (n) => String(n).padStart(2, '0');
  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const STATUS = { pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function niceTime(t) { const h = +t.slice(0, 2), m = t.slice(3, 5); return (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM'); }
  function niceDate(d) { const dt = new Date(d + 'T00:00:00'); return isNaN(dt) ? d : dt.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const localToday = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const say = (msg) => { const l = $('live'); if (l) { l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 50); } };
  let timer = null, started = false;

  /* ---------- Server calls ---------- */
  async function api(path, body) {
    const opt = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) };
    let res;
    try { res = await fetch(path, opt); } catch (e) { throw { status: 0, message: 'Cannot reach the server. Is it running?' }; }
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      if (res.status === 401 && !path.endsWith('/login')) showLogin('Your session ended. Please sign in again.');
      throw { status: res.status, message: data.error || 'Something went wrong.' };
    }
    return data;
  }

  /* ---------- Sign in / out ---------- */
  function showLogin(msg) {
    clearInterval(timer);
    $('app').hidden = true; $('login').hidden = false;
    $('login-error').textContent = msg || '';
    $('password').value = ''; $('password').focus();
  }
  function setupAuth() {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('login-btn'); btn.disabled = true; $('login-error').textContent = '';
      try { await api('/api/admin/login', { password: $('password').value }); startApp(); }
      catch (err) { $('login-error').textContent = err.message; $('password').select(); }
      btn.disabled = false;
    });
  }
  function setupCommon() {
    const toggle = $('nav-toggle'), menu = $('nav-menu');
    toggle.addEventListener('click', () => { const o = menu.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(o)); });
    $('logout').addEventListener('click', async () => { try { await api('/api/admin/logout', {}); } catch (e) { /* already signed out */ } showLogin(''); });
  }
  function startApp() {
    $('login').hidden = true; $('app').hidden = false;
    if (!started) { started = true; setupCommon(); (page === 'calendar' ? initCalendar : initBookings)(); }
    else refreshAll();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && !isDialogOpen()) refreshAll(); }, 20000);
  }
  const isDialogOpen = () => !!($('amt-dlg') && $('amt-dlg').open);
  const refreshAll = () => (page === 'calendar' ? refreshCalendar() : refreshBookings());

  /* =====================  BOOKINGS + EARNINGS  ===================== */
  const B = { last: '', byRef: {}, pending: null, ctx: null };
  const E = { data: null, view: 'monthly', year: '' };

  function initBookings() {
    const params = new URLSearchParams(location.search);
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '')) { $('f-date').value = params.get('date'); $('f-status').value = 'all'; }
    let t = null;
    $('f-status').addEventListener('change', () => loadBookings());
    $('f-date').addEventListener('change', () => loadBookings());
    $('f-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadBookings(), 300); });
    $('filters').addEventListener('submit', (e) => e.preventDefault());
    $('f-clear').addEventListener('click', () => { $('f-status').value = 'active'; $('f-date').value = ''; $('f-q').value = ''; history.replaceState(null, '', location.pathname + location.hash); loadBookings(); });
    $('f-refresh').addEventListener('click', () => refreshBookings());
    $('rows').addEventListener('click', onRowAction);
    $('amt-form').addEventListener('submit', onAmountSubmit);
    $('amt-cancel').addEventListener('click', () => $('amt-dlg').close());
    $('v-monthly').addEventListener('click', () => setView('monthly'));
    $('v-yearly').addEventListener('click', () => setView('yearly'));
    $('f-year').addEventListener('change', () => { E.year = $('f-year').value; renderEarnings(); });
    window.addEventListener('hashchange', showPanel);
    showPanel();
    loadBookings();
  }
  function showPanel() {
    const earn = location.hash === '#earnings';
    $('panel-bookings').hidden = earn; $('panel-earnings').hidden = !earn;
    const nb = $('nav-bookings'), ne = $('nav-earnings');
    if (earn) { ne.setAttribute('aria-current', 'page'); nb.removeAttribute('aria-current'); loadEarnings(); }
    else { nb.setAttribute('aria-current', 'page'); ne.removeAttribute('aria-current'); }
    $('nav-menu').classList.remove('open'); $('nav-toggle').setAttribute('aria-expanded', 'false');
  }
  function refreshBookings() { loadBookings(); if (location.hash === '#earnings') loadEarnings(); }

  async function loadBookings() {
    const p = new URLSearchParams({ status: $('f-status').value });
    if ($('f-date').value) p.set('date', $('f-date').value);
    if ($('f-q').value.trim()) p.set('q', $('f-q').value.trim());
    let d;
    try { d = await api('/api/admin/bookings?' + p); } catch (e) { if (e.status !== 401) $('updated').textContent = e.message; return; }
    const pend = d.counts.pending;
    if (B.pending !== null && pend > B.pending) say((pend - B.pending) + ' new booking' + (pend - B.pending > 1 ? 's' : '') + ' received.');
    B.pending = pend;
    const nav = $('nav-pending'); nav.textContent = pend; nav.hidden = pend === 0;
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-PH') + '. Showing ' + d.bookings.length + ' booking' + (d.bookings.length === 1 ? '' : 's') + '. Maximum ' + d.maxPerSlot + ' cars per hour.';
    const sig = JSON.stringify([d.counts, d.bookings]);
    if (sig === B.last) return;
    B.last = sig;
    renderCounts(d.counts); renderRows(d.bookings);
  }
  function renderCounts(c) {
    const box = $('counts'); box.textContent = '';
    [['Pending', c.pending, 'gold'], ['Confirmed', c.confirmed, ''], ['Cars today', c.today, ''], ['Completed', c.completed, ''], ['Cancelled', c.cancelled, '']].forEach(([l, v, cls]) => {
      const t = el('div', 'tile ' + cls); t.append(el('p', 'label', l), el('p', 'value', String(v))); box.appendChild(t);
    });
  }
  function renderRows(list) {
    const box = $('rows'); box.textContent = ''; B.byRef = {};
    if (!list.length) { box.appendChild(el('p', 'empty', 'No bookings match these filters.')); return; }
    list.forEach((b) => {
      B.byRef[b.reference] = b;
      const card = el('article', 'booking-card ' + b.status);
      const h = el('h3'); h.append(el('span', '', b.reference), el('span', 'badge', STATUS[b.status] || b.status));
      const dl = el('dl');
      const add = (k, v) => { dl.append(el('dt', '', k), el('dd', '', v)); };
      add('Date and time', niceDate(b.date) + ' at ' + niceTime(b.time));
      add('Customer', b.name);
      const dd = el('dd'); const a = el('a', '', b.phone); a.href = 'tel:' + b.phone.replace(/[^\d+]/g, ''); dd.appendChild(a); dl.append(el('dt', '', 'Phone'), dd);
      add('Vehicle', b.vehicle); add('Service', b.service); add('Estimated price', b.priceText);
      if (b.status === 'completed') add('Final amount', peso(b.finalAmount || 0));
      add('Notes', b.notes || 'None');
      const act = el('div', 'booking-actions');
      const btn = (label, a2, cls) => { const x = el('button', 'btn ' + cls, label); x.type = 'button'; x.dataset.act = a2; x.dataset.ref = b.reference; act.appendChild(x); };
      if (b.status === 'pending') btn('Confirm', 'confirmed', 'btn-primary');
      if (b.status === 'pending' || b.status === 'confirmed') { btn('Mark completed', 'complete', 'btn-outline'); btn('Cancel', 'cancelled', 'btn-outline'); }
      if (b.status === 'completed') btn('Edit amount', 'amount', 'btn-outline');
      card.append(h, dl); if (act.children.length) card.appendChild(act);
      box.appendChild(card);
    });
  }
  async function setStatus(ref, status, finalAmount) {
    const body = { reference: ref, status };
    if (finalAmount !== undefined) body.finalAmount = finalAmount;
    await api('/api/admin/bookings/status', body);
  }
  async function onRowAction(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const b = B.byRef[btn.dataset.ref], act = btn.dataset.act;
    if (!b) return;
    if (act === 'complete' || act === 'amount') { askAmount(b, act); return; }
    if (act === 'cancelled' && !window.confirm('Cancel booking ' + b.reference + ' for ' + b.name + '? The time slot will open up again.')) return;
    btn.disabled = true;
    try { await setStatus(b.reference, act); say('Booking ' + b.reference + ' is now ' + act + '.'); }
    catch (err) { if (err.status !== 401) window.alert(err.message); }
    B.last = ''; loadBookings();
  }
  function askAmount(b, mode) {
    B.ctx = { ref: b.reference, mode };
    $('amt-title').textContent = mode === 'complete' ? 'Mark completed' : 'Edit final amount';
    $('amt-hint').textContent = b.reference + ' - ' + b.service + '. Estimated price: ' + b.priceText + '.';
    $('amt-input').value = b.finalAmount != null ? b.finalAmount : (b.priceValue != null ? b.priceValue : '');
    $('amt-error').textContent = '';
    $('amt-dlg').showModal(); $('amt-input').focus(); $('amt-input').select();
  }
  async function onAmountSubmit(e) {
    e.preventDefault();
    const raw = $('amt-input').value.trim(), n = Number(raw);
    if (raw === '' || !isFinite(n) || n < 0 || n > 1000000) { $('amt-error').textContent = 'Enter an amount from 0 to 1,000,000.'; return; }
    $('amt-save').disabled = true;
    try {
      if (B.ctx.mode === 'complete') await setStatus(B.ctx.ref, 'completed', n);
      else await api('/api/admin/bookings/amount', { reference: B.ctx.ref, finalAmount: n });
      $('amt-dlg').close(); say('Saved.');
      B.last = ''; loadBookings(); if (location.hash === '#earnings') loadEarnings();
    } catch (err) { $('amt-error').textContent = err.message; }
    $('amt-save').disabled = false;
  }

  /* ---------- Earnings ---------- */
  async function loadEarnings() {
    try { E.data = await api('/api/admin/earnings'); } catch (e) { if (e.status !== 401) $('er-caption').textContent = e.message; return; }
    const sel = $('f-year'), years = E.data.years;
    if (!E.year || !years.includes(E.year)) E.year = E.data.now.date.slice(0, 4);
    sel.textContent = '';
    years.forEach((y) => { const o = el('option', '', y); o.value = y; sel.appendChild(o); });
    sel.value = E.year;
    renderEarnings();
  }
  function setView(v) {
    E.view = v;
    $('v-monthly').setAttribute('aria-pressed', String(v === 'monthly')); $('v-yearly').setAttribute('aria-pressed', String(v === 'yearly'));
    $('year-field').hidden = v === 'yearly';
    if (E.data) renderEarnings();
  }
  function niceMax(v) { if (v <= 0) return 1000; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function compact(n) { if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M'; if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k'; return String(Math.round(n)); }
  function renderEarnings() {
    const d = E.data; if (!d) return;
    const t = d.totals, tiles = $('er-tiles'); tiles.textContent = '';
    [['This month', peso(t.thisMonth), 'gold'], ['This year', peso(t.thisYear), 'gold'], ['All time', peso(t.allTime), ''], ['Completed jobs', String(t.jobs), ''], ['Expected from open bookings', peso(t.expected), '']].forEach(([l, v, c]) => {
      const x = el('div', 'tile ' + c); x.append(el('p', 'label', l), el('p', 'value', v)); tiles.appendChild(x);
    });
    let rows;
    if (E.view === 'monthly') {
      rows = MONTHS.map((m, i) => { const k = E.year + '-' + pad(i + 1), v = d.monthly[k] || { total: 0, count: 0 }; return { label: m.slice(0, 3), full: m + ' ' + E.year, key: k, total: v.total, count: v.count }; });
    } else {
      rows = d.years.map((y) => { const v = d.yearly[y] || { total: 0, count: 0 }; return { label: y, full: y, key: y, total: v.total, count: v.count }; });
    }
    const nowKey = E.view === 'monthly' ? d.now.date.slice(0, 7) : d.now.date.slice(0, 4);
    drawChart(rows, nowKey);
    $('er-caption').textContent = E.view === 'monthly' ? 'Earnings by month, ' + E.year : 'Earnings by year';
    $('er-col').textContent = E.view === 'monthly' ? 'Month' : 'Year';
    const tb = $('er-table').tBodies[0], tf = $('er-table').tFoot; tb.textContent = ''; tf.textContent = '';
    let sum = 0, jobs = 0;
    rows.forEach((r) => {
      sum += Math.round(r.total * 100); jobs += r.count;
      const tr = el('tr'); const th = el('th', '', r.full); th.scope = 'row';
      tr.append(th, el('td', 'num', String(r.count)), el('td', 'num price', peso(r.total))); tb.appendChild(tr);
    });
    const fr = el('tr'); const fh = el('th', '', 'Total'); fh.scope = 'row';
    fr.append(fh, el('td', 'num', String(jobs)), el('td', 'num price', peso(sum / 100))); tf.appendChild(fr);
    $('chart').setAttribute('aria-label', (E.view === 'monthly' ? 'Monthly earnings for ' + E.year : 'Yearly earnings') + '. Total ' + peso(sum / 100) + '.');
  }
  const NS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, text) { const e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); if (text != null) e.textContent = text; return e; }
  function drawChart(rows, nowKey) {
    const W = 720, H = 320, L = 60, R = 14, T = 26, Bt = 38, ph = H - T - Bt;
    const max = niceMax(Math.max.apply(null, rows.map((r) => r.total).concat([0])));
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, focusable: 'false' });
    for (let i = 0; i <= 5; i++) {
      const y = T + ph * (1 - i / 5);
      svg.appendChild(sv('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'gl' }));
      svg.appendChild(sv('text', { x: L - 8, y: y + 4, 'text-anchor': 'end' }, '₱' + compact(max * i / 5)));
    }
    const bw = (W - L - R) / rows.length, w = Math.min(bw * 0.62, 70);
    rows.forEach((r, i) => {
      const h = (r.total / max) * ph, x = L + bw * i + (bw - w) / 2, y = T + ph - h;
      const g = sv('g');
      if (r.total > 0) {
        const bar = sv('rect', { x, y, width: w, height: Math.max(h, 1), rx: 3, class: 'bar' + (r.key === nowKey ? ' now' : ''), tabindex: '0' });
        bar.appendChild(sv('title', {}, r.full + ': ' + peso(r.total) + ' from ' + r.count + ' job' + (r.count === 1 ? '' : 's')));
        g.appendChild(bar);
        g.appendChild(sv('text', { x: x + w / 2, y: y - 6, 'text-anchor': 'middle', class: 'val' }, compact(r.total)));
      }
      g.appendChild(sv('text', { x: x + w / 2, y: H - Bt + 18, 'text-anchor': 'middle' }, r.label));
      svg.appendChild(g);
    });
    if (rows.every((r) => r.total === 0)) svg.appendChild(sv('text', { x: W / 2, y: T + ph / 2, 'text-anchor': 'middle' }, 'No completed bookings in this period yet.'));
    const box = $('chart'); box.textContent = ''; box.appendChild(svg);
  }

  /* =====================  CALENDAR  ===================== */
  const C = { month: '', sel: '', today: localToday(), max: 10, mSeq: 0, dSeq: 0 };

  function initCalendar() {
    C.month = C.today.slice(0, 7); C.sel = C.today;
    const dow = $('cal-dow');
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => dow.appendChild(el('div', 'cal-dow', d)));
    $('cal-prev').addEventListener('click', () => shiftMonth(-1));
    $('cal-next').addEventListener('click', () => shiftMonth(1));
    $('cal-today').addEventListener('click', () => { C.month = C.today.slice(0, 7); C.sel = C.today; refreshCalendar(); });
    $('hide-empty').addEventListener('change', () => { if (C.dayData) renderDay(C.dayData); });
    $('cal-grid').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-date]');
      if (!b) return;
      C.sel = b.dataset.date; markSelected(); loadDay();
    });
    refreshCalendar();
  }
  function shiftMonth(n) {
    const y = +C.month.slice(0, 4), m = +C.month.slice(5, 7) - 1 + n, d = new Date(Date.UTC(y, m, 1));
    C.month = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
    loadMonth();
  }
  function refreshCalendar() { loadMonth(); loadDay(); }
  async function loadMonth() {
    const seq = ++C.mSeq; let d;
    try { d = await api('/api/admin/calendar?month=' + C.month); } catch (e) { if (e.status !== 401) $('cal-msg').textContent = e.message; return; }
    if (seq !== C.mSeq) return;
    C.today = d.now.date; C.max = d.maxPerSlot; $('cal-max').textContent = d.maxPerSlot; $('cal-msg').textContent = '';
    const y = +C.month.slice(0, 4), m = +C.month.slice(5, 7);
    $('cal-title').textContent = MONTHS[m - 1] + ' ' + y;
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const grid = $('cal-grid'); grid.textContent = '';
    for (let i = 0; i < first; i++) grid.appendChild(el('div', 'cal-day blank'));
    for (let day = 1; day <= days; day++) {
      const date = C.month + '-' + pad(day), info = d.days[date];
      const b = el('button', 'cal-day' + (date === C.today ? ' today' : '') + (date < C.today ? ' past' : '')); b.type = 'button'; b.dataset.date = date;
      b.appendChild(el('span', 'n', String(day)));
      let label = niceDate(date);
      if (info) {
        b.appendChild(el('small', '', info.count + (info.count === 1 ? ' car' : ' cars')));
        label += ': ' + info.count + (info.count === 1 ? ' car' : ' cars');
        if (info.pending) { b.appendChild(el('small', 'pend', info.pending + ' pending')); label += ', ' + info.pending + ' pending'; }
        if (info.full) { b.appendChild(el('small', 'full-tag', 'Hour full')); label += ', at least one hour is full'; }
      } else label += ': no cars booked';
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(date === C.sel));
      grid.appendChild(b);
    }
  }
  function markSelected() { document.querySelectorAll('#cal-grid .cal-day[data-date]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === C.sel))); }
  async function loadDay() {
    const seq = ++C.dSeq; let d;
    try { d = await api('/api/admin/day?date=' + C.sel); } catch (e) { if (e.status !== 401) $('day-sub').textContent = e.message; return; }
    if (seq !== C.dSeq) return;
    C.dayData = d; C.today = d.now.date; renderDay(d);
  }
  function renderDay(d) {
    const total = d.slots.reduce((s, x) => s + x.booked, 0), pending = d.slots.reduce((s, x) => s + x.bookings.filter((b) => b.status === 'pending').length, 0);
    $('day-title').textContent = niceDate(d.date);
    $('day-sub').textContent = total + (total === 1 ? ' car' : ' cars') + ' booked, ' + pending + ' pending. All 24 hours, maximum ' + d.maxPerSlot + ' cars per hour.';
    const open = $('day-open'); open.hidden = false; open.href = 'admin.html?date=' + d.date;
    const hide = $('hide-empty').checked, box = $('slots'); box.textContent = '';
    d.slots.forEach((s) => {
      const past = d.date < d.now.date || (d.date === d.now.date && s.time <= d.now.time);
      const state = s.full ? 'full' : s.booked >= d.maxPerSlot - 3 ? 'few' : past ? 'past' : 'open';
      const row = el('div', 'slot-row' + (past ? ' past' : '') + (hide && !s.booked ? ' hidden' : ''));
      const top = el('div', 'slot-top');
      const meter = el('div', 'meter'); const bar = el('i', state === 'full' ? 'full' : state === 'few' ? 'few' : ''); bar.style.width = Math.min(100, s.booked / d.maxPerSlot * 100) + '%'; meter.appendChild(bar);
      const label = s.full ? 'Full' : state === 'few' ? 'Almost full' : past ? 'Passed' : 'Open';
      top.append(el('strong', '', niceTime(s.time)), meter, el('span', 'slot-state ' + (state === 'open' ? '' : state), s.booked + ' of ' + d.maxPerSlot + ' cars, ' + label.toLowerCase()));
      row.appendChild(top);
      if (s.bookings.length) {
        const ul = el('ul');
        s.bookings.forEach((b) => ul.appendChild(el('li', '', b.reference + ' - ' + b.name + ' (' + b.phone + ') - ' + b.vehicle + ' - ' + b.service + ' - ' + (STATUS[b.status] || b.status))));
        row.appendChild(ul);
      }
      box.appendChild(row);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
    api('/api/admin/me').then(startApp).catch((e) => { if (e.status === 0) showLogin(e.message); else if (e.status !== 401) showLogin(e.message); else showLogin(''); });
  });
})();
