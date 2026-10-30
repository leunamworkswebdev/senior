/* Senior Master Carwash - customer booking page (vanilla JS).
   Bookings are sent to the server (server.js), so the admin sees them instantly.
   Prices come from catalog.js, the same file the server uses. */
(function () {
  'use strict';
  const { SIZE_LABELS, VEHICLE_SIZES, SERVICES, getPrice } = window.CATALOG;
  const STORAGE_KEY = 'smc_bookings_v2';
  const STATUS_LABEL = { pending: 'Waiting for confirmation', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };
  const $ = (id) => document.getElementById(id);
  const form = $('booking-form');
  const f = {
    name: $('fullName'), phone: $('contactNumber'), type: $('vehicleType'), size: $('vehicleSize'),
    model: $('vehicleModel'), plate: $('plateNumber'), cat: $('serviceCategory'), service: $('serviceSelect'),
    date: $('bookingDate'), time: $('bookingTime'), notes: $('notes')
  };
  let info = { maxPerSlot: 10, maxDaysAhead: 90, now: null };
  let avail = null, availSeq = 0, submitting = false, lastFocus = null, currentRef = null;
  const peso = (n) => '₱' + n.toLocaleString('en-PH');
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Server calls ---------- */
  async function api(path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) };
    let res;
    try { res = await fetch(path, opt); } catch (e) { throw { status: 0, message: 'Cannot reach the booking server. Check your connection and try again.', errors: {} }; }
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw { status: res.status, message: data.error || 'Something went wrong. Please try again.', errors: data.errors || {} };
    return data;
  }

  /* ---------- Dates and times ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  function localToday() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function niceDate(d) {
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? d : dt.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
  }
  function niceTime(t) {
    const [h, m] = t.split(':').map(Number);
    return (h % 12 || 12) + ':' + pad(m) + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  const shortTime = (t) => { const h = +t.slice(0, 2); return (h % 12 || 12) + ' ' + (h >= 12 ? 'PM' : 'AM'); };

  /* ---------- Dropdowns ---------- */
  function fillSelect(select, items, placeholder) {
    select.textContent = '';
    const first = document.createElement('option');
    first.value = ''; first.textContent = placeholder;
    select.appendChild(first);
    items.forEach(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; select.appendChild(o); });
    select.disabled = items.length === 0;
  }
  function updateSizes() {
    const sizes = VEHICLE_SIZES[f.type.value] || [];
    fillSelect(f.size, sizes.map((s) => [s, SIZE_LABELS[s]]), sizes.length ? 'Select size' : 'Select vehicle type first');
  }
  function updateServices(preselect) {
    const items = Object.entries(SERVICES).filter(([, s]) => s.category === f.cat.value && s.vehicles.includes(f.type.value)).map(([id, s]) => [id, s.label]);
    const ph = !f.type.value || !f.cat.value ? 'Select vehicle type and category first' : (items.length ? 'Select service' : 'No services for this combination');
    fillSelect(f.service, items, ph);
    if (preselect && items.some(([id]) => id === preselect)) f.service.value = preselect;
  }

  /* ---------- Time availability (max cars per hour) ---------- */
  function slotText(s) {
    if (s.past) return 'Passed';
    if (s.full) return 'Full';
    return (info.maxPerSlot - s.booked) + ' open';
  }
  function fillTimes() {
    const keep = f.time.value;
    f.time.textContent = '';
    const first = document.createElement('option');
    first.value = ''; first.textContent = avail ? 'Select time' : 'Choose a date first';
    f.time.appendChild(first);
    let stillOk = false;
    if (avail) avail.slots.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.time;
      o.disabled = s.past || s.full;
      o.textContent = niceTime(s.time) + ' - ' + (s.past ? 'time passed' : s.full ? 'FULL (' + info.maxPerSlot + ' of ' + info.maxPerSlot + ' cars)' : s.booked + ' of ' + info.maxPerSlot + ' cars booked');
      f.time.appendChild(o);
      if (s.time === keep && !o.disabled) stillOk = true;
    });
    f.time.disabled = !avail;
    f.time.value = stillOk ? keep : '';
    if (keep && !stillOk && avail) $('slot-msg').textContent = 'The time you picked is no longer open. Please choose another.';
  }
  function renderGrid() {
    const grid = $('slot-grid');
    grid.textContent = '';
    if (!avail) return;
    avail.slots.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (s.booked >= info.maxPerSlot - 3 && !s.full ? ' few' : '');
      b.disabled = s.past || s.full;
      b.setAttribute('aria-pressed', String(f.time.value === s.time));
      b.dataset.time = s.time;
      b.setAttribute('aria-label', niceTime(s.time) + ', ' + (s.past ? 'time passed' : s.full ? 'full' : (info.maxPerSlot - s.booked) + ' of ' + info.maxPerSlot + ' spots open'));
      const a = document.createElement('span'); a.textContent = shortTime(s.time);
      const c = document.createElement('small'); c.textContent = slotText(s);
      b.append(a, c);
      grid.appendChild(b);
    });
  }
  async function loadAvailability() {
    const date = f.date.value, msg = $('slot-msg'), seq = ++availSeq;
    if (!date) { avail = null; fillTimes(); renderGrid(); msg.textContent = 'Choose a date to see which times are open.'; return; }
    try {
      const d = await api('/api/availability?date=' + encodeURIComponent(date));
      if (seq !== availSeq) return;
      avail = d; info.maxPerSlot = d.maxPerSlot; info.now = d.now;
      msg.textContent = 'Showing ' + niceDate(date) + '. Each hour takes up to ' + d.maxPerSlot + ' cars. Pick a time that is open.';
    } catch (e) {
      if (seq !== availSeq) return;
      avail = null; msg.textContent = e.message;
    }
    $('max-cars').textContent = info.maxPerSlot;
    fillTimes(); renderGrid(); updateSummary();
  }

  /* ---------- Summary ---------- */
  function updateSummary() {
    const s = SERVICES[f.service.value];
    $('sum-service').textContent = s ? s.label : 'Not selected';
    const typeTxt = f.type.value ? f.type.selectedOptions[0].textContent : '';
    $('sum-vehicle').textContent = typeTxt ? typeTxt + (f.size.value ? ' - ' + SIZE_LABELS[f.size.value] : '') : 'Not selected';
    $('sum-date').textContent = f.date.value ? niceDate(f.date.value) : 'Not selected';
    $('sum-time').textContent = f.time.value ? niceTime(f.time.value) : 'Not selected';
    const price = getPrice(f.service.value, f.size.value), warn = $('price-warning');
    if (price === undefined) { $('sum-price').textContent = 'Select a service and size'; warn.hidden = true; }
    else if (price === null) { $('sum-price').textContent = 'Price to be confirmed'; warn.hidden = false; }
    else { $('sum-price').textContent = peso(price); warn.hidden = true; }
    document.querySelectorAll('#slot-grid .slot').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.time === f.time.value)));
  }

  /* ---------- Validation ---------- */
  const validPhone = (v) => /^(09|\+?639)\d{9}$/.test(v.replace(/[\s-]/g, ''));
  function validate() {
    const e = {};
    if (!f.name.value.trim()) e.fullName = 'Enter your full name.';
    if (!f.phone.value.trim()) e.contactNumber = 'Enter your contact number.';
    else if (!validPhone(f.phone.value)) e.contactNumber = 'Use a Philippine mobile number, e.g. 0917 123 4567.';
    if (!f.type.value) e.vehicleType = 'Select a vehicle type.';
    if (!f.size.value) e.vehicleSize = 'Select a vehicle size.';
    if (!f.model.value.trim()) e.vehicleModel = 'Enter the vehicle make and model.';
    if (!f.cat.value) e.serviceCategory = 'Select a service category.';
    if (!f.service.value) e.serviceSelect = 'Select a service.';
    if (!f.date.value) e.bookingDate = 'Choose a date.';
    else if (f.date.value < (info.now ? info.now.date : localToday())) e.bookingDate = 'The date cannot be in the past.';
    if (!f.time.value) e.bookingTime = f.date.value ? 'Choose a time that is open.' : 'Choose a date first.';
    return e;
  }
  function showErrors(errors, message) {
    Object.keys(f).forEach((k) => {
      const el = f[k], msg = errors[el.id] || '', slot = $(el.id + '-error');
      if (slot) slot.textContent = msg;
      if (msg) { el.setAttribute('aria-invalid', 'true'); if (slot) el.setAttribute('aria-describedby', slot.id); }
      else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
    });
    const box = $('form-errors'), n = Object.keys(errors).length;
    box.textContent = message || (n ? 'Please fix ' + n + ' field' + (n > 1 ? 's' : '') + ' below.' : '');
    box.hidden = !box.textContent;
    if (!box.hidden) {
      box.focus();
      const first = Object.keys(errors).find((id) => $(id));
      if (first && !$(first).disabled) $(first).focus();
    }
  }

  /* ---------- My Bookings (a copy is kept in this browser; the server holds the real one) ---------- */
  function loadBookings() { try { const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function storeBookings(all) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (e) { /* storage unavailable */ } }
  function renderBookings(highlightRef) {
    const list = $('bookings-list');
    const all = loadBookings().slice().reverse();
    list.textContent = '';
    const active = all.filter((b) => b.status === 'pending' || b.status === 'confirmed').length;
    $('nav-count').textContent = active; $('nav-count').hidden = active === 0;
    if (!all.length) {
      const p = document.createElement('p'); p.className = 'empty';
      p.textContent = 'You have no booking requests yet. Fill in the form above and your request will appear here.';
      list.appendChild(p); return;
    }
    all.forEach((b) => {
      const st = b.status || 'pending';
      const card = document.createElement('article');
      card.className = 'booking-card ' + st + (b.reference === highlightRef ? ' new' : '');
      card.id = 'bk-' + b.reference;
      const h = document.createElement('h3');
      const ref = document.createElement('span'); ref.textContent = b.reference;
      const badge = document.createElement('span'); badge.className = 'badge ' + st; badge.textContent = STATUS_LABEL[st] || st;
      h.append(ref, badge);
      const dl = document.createElement('dl');
      [['Name', b.name], ['Contact', b.phone], ['Vehicle', b.vehicle], ['Service', b.service], ['Date', niceDate(b.date)], ['Time', niceTime(b.time)], ['Estimated price', b.price], ['Notes', b.notes || 'None']]
        .forEach(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); });
      const actions = document.createElement('div'); actions.className = 'booking-actions';
      const print = document.createElement('button'); print.type = 'button'; print.className = 'btn btn-outline'; print.dataset.act = 'print'; print.textContent = 'Print';
      actions.appendChild(print);
      if (st === 'pending' || st === 'confirmed') {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'btn btn-outline'; c.dataset.act = 'cancel'; c.dataset.ref = b.reference; c.textContent = 'Cancel booking';
        actions.appendChild(c);
      }
      card.append(h, dl);
      if (b.chat && b.chat.length) { const chat = document.createElement('div'); chat.className = 'chat'; renderChat(chat, b.chat); card.appendChild(chat); }
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  async function onBookingAction(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'print') { window.print(); return; }
    if (btn.dataset.act === 'cancel' && window.confirm('Cancel this booking?')) {
      btn.disabled = true;
      try { await api('/api/cancel', { reference: btn.dataset.ref }); } catch (err) {
        if (err.status !== 409) { window.alert(err.message); btn.disabled = false; return; }
        window.alert(err.message);
      }
      await syncStatuses();
      if (avail) loadAvailability();
    }
  }
  async function syncStatuses() {
    const all = loadBookings();
    const refs = all.filter((b) => b.status === 'pending' || b.status === 'confirmed').map((b) => b.reference).slice(-20);
    if (!refs.length) { renderBookings(); return; }
    try {
      const { statuses } = await api('/api/status', { refs });
      let changed = false;
      all.forEach((b) => { if (statuses[b.reference] && statuses[b.reference] !== b.status) { b.status = statuses[b.reference]; changed = true; } });
      if (changed) storeBookings(all);
    } catch (e) { /* offline: keep what we have */ }
    renderBookings();
  }

  /* ---------- Assistant (uses /api/assistant when the owner set an API key, else a built-in reply) ---------- */
  function localReply(b, question) {
    if (question) return 'Thanks for your question. I am an automated assistant and cannot answer that exactly. Please keep your reference ' + b.reference + ' and ask the Senior Master Carwash staff when you arrive.';
    let t = 'Hi ' + b.name.split(' ')[0] + ', we received your booking request ' + b.reference + ' for ' + b.service + ' on ' + niceDate(b.date) + ' at ' + niceTime(b.time) + '. ';
    t += b.price === 'Price to be confirmed' ? 'The price still needs to be confirmed by the business. ' : 'Estimated price: ' + b.price + '. ';
    if (b.notes) t += 'We noted your request: "' + b.notes + '". ';
    return t + 'This request is not confirmed until the business confirms it.';
  }
  async function askAssistant(b, question) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, signal: ctrl.signal,
        body: JSON.stringify({ booking: { reference: b.reference, name: b.name, vehicle: b.vehicle, service: b.service, date: b.date, time: b.time, price: b.price, notes: b.notes }, chat: (b.chat || []).slice(-6), question: question || '' })
      });
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('empty');
      return data.reply.trim();
    } catch (e) { return localReply(b, question); } finally { clearTimeout(timer); }
  }
  function renderChat(el, chat) {
    el.textContent = '';
    (chat || []).forEach((m) => { const p = document.createElement('p'); p.className = 'msg ' + m.role; p.textContent = (m.role === 'user' ? 'You: ' : 'Assistant: ') + m.text; el.appendChild(p); });
  }
  async function runAssistant(ref, question) {
    let all = loadBookings(), b = all.find((x) => x.reference === ref);
    if (!b) return;
    b.chat = b.chat || [];
    if (question) b.chat.push({ role: 'user', text: question });
    storeBookings(all);
    if (currentRef === ref) renderChat($('ai-log'), b.chat);
    $('ai-status').textContent = 'Assistant is writing a reply…';
    $('ai-ask').disabled = true;
    const reply = await askAssistant(b, question);
    all = loadBookings(); b = all.find((x) => x.reference === ref);
    if (b) { b.chat = b.chat || []; b.chat.push({ role: 'assistant', text: reply }); storeBookings(all); }
    if (currentRef === ref && b) renderChat($('ai-log'), b.chat);
    $('ai-status').textContent = ''; $('ai-ask').disabled = false;
    renderBookings();
  }

  /* ---------- Modal ---------- */
  function openModal(b) {
    $('modal-ref').textContent = b.reference;
    const dl = $('modal-details'); dl.textContent = '';
    [['Name', b.name], ['Contact', b.phone], ['Vehicle', b.vehicle], ['Service', b.service], ['Date and time', niceDate(b.date) + ' at ' + niceTime(b.time)], ['Estimated price', b.price], ['Notes', b.notes || 'None']]
      .forEach(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); });
    currentRef = b.reference;
    renderChat($('ai-log'), b.chat || []);
    $('ai-status').textContent = ''; $('ai-q').value = '';
    lastFocus = document.activeElement;
    $('confirm-modal').hidden = false;
    $('modal-title').focus();
  }
  function closeModal() { $('confirm-modal').hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function resetForm() {
    form.reset(); updateSizes(); updateServices(); showErrors({}); updateSummary();
    submitting = false; $('submit-btn').disabled = false;
    loadAvailability();
  }

  /* ---------- Submit ---------- */
  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    const errors = validate();
    showErrors(errors);
    if (Object.keys(errors).length) return;
    submitting = true; $('submit-btn').disabled = true; $('submit-btn').textContent = 'Sending…';
    try {
      const { booking } = await api('/api/bookings', {
        name: f.name.value, phone: f.phone.value, vehicleType: f.type.value, vehicleSize: f.size.value, vehicleModel: f.model.value,
        plate: f.plate.value, serviceId: f.service.value, date: f.date.value, time: f.time.value, notes: f.notes.value
      });
      booking.chat = [];
      const all = loadBookings(); all.push(booking); storeBookings(all);
      resetForm();
      renderBookings(booking.reference);
      openModal(booking);
      runAssistant(booking.reference, '');
    } catch (err) {
      submitting = false;
      showErrors(err.errors || {}, err.message);
      if (err.status === 409 || err.status === 400) loadAvailability();
    }
    $('submit-btn').disabled = false; $('submit-btn').textContent = 'Send Booking Request';
  }

  /* ---------- Navigation and Book Now buttons ---------- */
  function setupNav() {
    const toggle = $('nav-toggle'), menu = $('nav-menu');
    toggle.addEventListener('click', () => { const open = menu.classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) { menu.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } });
    document.querySelectorAll('[data-book]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.dataset.service, cat = btn.dataset.category;
        if (cat) f.cat.value = cat;
        if (id && SERVICES[id] && (!f.type.value || !SERVICES[id].vehicles.includes(f.type.value))) {
          f.type.value = SERVICES[id].vehicles.length > 1 ? '' : SERVICES[id].vehicles[0];
          updateSizes();
        }
        updateServices(id); updateSummary();
        $('booking').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' });
        f.name.focus({ preventScroll: true });
      });
    });
  }

  /* ---------- Init ---------- */
  async function init() {
    $('year').textContent = new Date().getFullYear();
    setupNav();
    f.date.min = localToday();
    try {
      info = Object.assign(info, await api('/api/info'));
      f.date.min = info.now.date; f.date.max = addDays(info.now.date, info.maxDaysAhead);
      $('max-cars').textContent = info.maxPerSlot;
    } catch (e) { $('slot-msg').textContent = e.message; }
    f.type.addEventListener('change', () => { updateSizes(); updateServices(); updateSummary(); });
    f.cat.addEventListener('change', () => { updateServices(); updateSummary(); });
    [f.size, f.service, f.time].forEach((el) => el.addEventListener('change', updateSummary));
    f.date.addEventListener('change', () => { updateSummary(); loadAvailability(); });
    $('slot-grid').addEventListener('click', (e) => {
      const b = e.target.closest('button.slot');
      if (!b || b.disabled) return;
      f.time.value = b.dataset.time; updateSummary();
    });
    form.addEventListener('submit', onSubmit);
    $('modal-close').addEventListener('click', closeModal);
    $('modal-new').addEventListener('click', () => { closeModal(); f.name.focus(); });
    $('modal-view').addEventListener('click', () => { closeModal(); $('my-bookings').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); });
    $('bookings-list').addEventListener('click', onBookingAction);
    $('ai-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('ai-q').value.trim().slice(0, 300);
      if (!q || !currentRef) return;
      $('ai-q').value = ''; runAssistant(currentRef, q);
    });
    $('confirm-modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    updateSummary(); renderBookings(); syncStatuses();
    /* keep availability and booking statuses fresh while the page is open */
    setInterval(() => { if (document.hidden) return; syncStatuses(); if (f.date.value && !submitting) loadAvailability(); }, 30000);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
