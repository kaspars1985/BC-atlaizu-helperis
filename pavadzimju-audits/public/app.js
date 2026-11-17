'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  items: [], groups: [], rawLines: [], summary: {},
  customerNo: '', customerName: '',
  selectedItems: new Set(), selectedGroups: new Set(),
  manualRows: [],
  filter: { status: 'manual_unsaved', search: '' }
};

const ODATA_DEFAULTS = { baseUrl: 'https://amfbc.amf.lv:7048/AMF/ODataV4', company: 'AM Furnitūra EUR' };

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast is-visible' + (kind ? ' toast--' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function fmtNum(v, d) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? String(v) : n.toFixed(d === undefined ? 2 : d);
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusLabel(status) {
  return ({
    MISSING_IN_7004: '🔴 Nav 7004. lapā',
    DIFFERS_FROM_7004: '🟠 Atšķiras',
    MATCHES_7004: '🟢 Sakrīt',
    ZERO_DISCOUNT: '⚪ Nav atlaides'
  })[status] || status || '';
}

function statusClass(status) {
  return 'status status--' + String(status || '').toLowerCase().replace(/_/g, '-');
}

// ---- Autofill guard ----
function looksLikeAutofillUsername(value) {
  if (!value) return false;
  const v = String(value);
  if (v.indexOf('\\') !== -1) return true;
  if (v.indexOf('@') !== -1 && v.indexOf(' ') === -1) return true;
  return false;
}

function sanitizeSearchInput() {
  const el = $('table-search');
  if (!el) return;
  if (looksLikeAutofillUsername(el.value)) { el.value = ''; state.filter.search = ''; }
}

function sanitizeCustomerInput() {
  const el = $('customer-input');
  if (!el) return;
  if (looksLikeAutofillUsername(el.value)) el.value = '';
}

// ---- Export helpers ----
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function toCsv(rows) {
  return '\ufeff' + rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}

function toXls(rows, title) {
  const cell = (c) => '<td>' + esc(c) + '</td>';
  const body = rows.map((r) => '<tr>' + r.map(cell).join('') + '</tr>').join('');
  return '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><title>' + esc(title || 'Export') + '</title></head><body><table border="1">' + body + '</table></body></html>';
}

function exportRows(rows, baseName) {
  if (!rows || rows.length < 2) { toast('Nav datu eksportam', 'warn'); return; }
  download(baseName + '.csv', toCsv(rows), 'text/csv;charset=utf-8');
}

function exportRowsXls(rows, baseName) {
  if (!rows || rows.length < 2) { toast('Nav datu eksportam', 'warn'); return; }
  download(baseName + '.xls', toXls(rows, baseName), 'application/vnd.ms-excel');
}

// ---- Client-side filtering ----
function matchesSearch(text) {
  const q = state.filter.search;
  if (!q) return true;
  return String(text || '').toLowerCase().indexOf(q) !== -1;
}

function itemMatchesStatus(it) {
  const f = state.filter.status;
  const disc = Number(it.lastDiscountPercent) || 0;
  const existing = it.existing7004Effective;
  const hasExisting = existing !== null && existing !== undefined && Number(existing) > 0;
  if (f === 'all') return true;
  if (f === 'all_discounted') return disc > 0;
  if (f === 'missing_only') return disc > 0 && !hasExisting;
  if (f === 'manual_unsaved') return disc > 0 && (!hasExisting || it.status === 'DIFFERS_FROM_7004');
  return true;
}

function filteredItems() {
  return state.items.filter((it) => itemMatchesStatus(it) &&
    (matchesSearch(it.itemCode) || matchesSearch(it.description) || matchesSearch(it.groupCode)));
}

function filteredGroups() {
  return state.groups.filter((g) => matchesSearch(g.groupCode) || matchesSearch(g.sampleItems));
}

function filteredLines() {
  return state.rawLines.filter((l) => matchesSearch(l.invoiceNo) || matchesSearch(l.itemCode) ||
    matchesSearch(l.description) || matchesSearch(l.sellToCustomerName) || matchesSearch(l.relatedCustomerNo));
}

// ---- Summary recalculation ----
function recalcSummary() {
  if (!state.summary) state.summary = {};
  let missing = 0, differs = 0, manual = 0;
  state.items.forEach((it) => {
    if (it.missingIn7004) missing++;
    if (it.status === 'DIFFERS_FROM_7004') differs++;
    if (it.isManualUnsaved) manual++;
  });
  state.summary.missingIn7004Count = missing;
  state.summary.differsFrom7004Count = differs;
  state.summary.manualUnsavedCount = manual;
}

// ---- Rendering ----
function renderKpis() {
  const s = state.summary || {};
  $('kpi-invoices').textContent = s.totalInvoicesChecked || 0;
  $('kpi-discounted').textContent = s.uniqueDiscountedItemsCount || 0;
  $('kpi-missing').textContent = s.missingIn7004Count || 0;
  $('kpi-differs').textContent = s.differsFrom7004Count || 0;
}

function renderItems() {
  const tb = $('items-tbody');
  tb.innerHTML = '';
  const rows = filteredItems();
  rows.forEach((it) => {
    const tr = document.createElement('tr');
    const checked = state.selectedItems.has(it.itemCode) ? 'checked' : '';
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" data-item="' + esc(it.itemCode) + '" ' + checked + '></td>' +
      '<td>' + esc(it.itemCode) + '</td>' +
      '<td>' + esc(it.description) + '</td>' +
      '<td>' + esc(it.groupCode) + '</td>' +
      '<td>' + esc(it.unitOfMeasure) + '</td>' +
      '<td class="num">' + esc(it.discountedInvoiceCount) + '</td>' +
      '<td class="num">' + fmtNum(it.totalQty, 2) + '</td>' +
      '<td class="num">' + fmtNum(it.lastUnitPrice, 2) + '</td>' +
      '<td class="num">' + fmtNum(it.lastDiscountPercent, 2) + '</td>' +
      '<td>' + (it.existing7004Effective === null || it.existing7004Effective === undefined ? '—' : fmtNum(it.existing7004Effective, 2) + '%') + '</td>' +
      '<td><span class="' + statusClass(it.status) + '">' + esc(statusLabel(it.status)) + '</span></td>' +
      '<td class="num"><input type="number" step="0.01" min="0" max="100" class="discount-input" data-item-discount="' + esc(it.itemCode) + '" value="' + fmtNum(it.suggestedDiscount, 2) + '"></td>' +
      '<td><button type="button" class="btn btn--sm ' + (it.status === 'MATCHES_7004' ? '' : 'btn--primary') + '" data-apply-item="' + esc(it.itemCode) + '">' + (it.status === 'MATCHES_7004' ? '✓ Saglabāts (Atjaunot)' : '⚡ Ierakstīt 7004.') + '</button></td>';
    tb.appendChild(tr);
  });
  $('items-empty').hidden = rows.length > 0;
  $('items-check-all').checked = rows.length > 0 && rows.every((it) => state.selectedItems.has(it.itemCode));
}

function renderGroups() {
  const tb = $('groups-tbody');
  tb.innerHTML = '';
  const rows = filteredGroups();
  rows.forEach((g) => {
    const tr = document.createElement('tr');
    const checked = state.selectedGroups.has(g.groupCode) ? 'checked' : '';
    const manual = Array.isArray(g.manualDiscountsUsed) ? g.manualDiscountsUsed.join(', ') : '';
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" data-group="' + esc(g.groupCode) + '" ' + checked + '></td>' +
      '<td>' + esc(g.groupCode) + '</td>' +
      '<td>' + esc(manual) + '</td>' +
      '<td class="num">' + esc(g.uniqueItemsCount) + '</td>' +
      '<td class="num">' + esc(g.manualUnsavedCount) + '</td>' +
      '<td class="num">' + fmtNum(g.commonManualDiscount, 2) + '</td>' +
      '<td class="num">' + fmtNum(g.commonManualDiscount, 2) + '</td>' +
      '<td class="num">' + fmtNum(g.commonManualDiscount, 2) + '</td>' +
      '<td>' + (g.existing7004GroupDiscount === null || g.existing7004GroupDiscount === undefined ? '—' : fmtNum(g.existing7004GroupDiscount, 2) + '%') + '</td>' +
      '<td><span class="' + statusClass(g.status) + '">' + esc(statusLabel(g.status)) + '</span></td>' +
      '<td class="num"><input type="number" step="0.01" min="0" max="100" class="discount-input" data-group-discount="' + esc(g.groupCode) + '" value="' + fmtNum(g.suggestedDiscount, 2) + '"></td>' +
      '<td><button type="button" class="btn btn--sm ' + (g.status === 'MATCHES_7004' ? '' : 'btn--primary') + '" data-apply-group="' + esc(g.groupCode) + '">' + (g.status === 'MATCHES_7004' ? '✓ Saglabāts (Atjaunot)' : '⚡ Ierakstīt 7004.') + '</button></td>';
    tb.appendChild(tr);
  });
  $('groups-empty').hidden = rows.length > 0;
  $('groups-check-all').checked = rows.length > 0 && rows.every((g) => state.selectedGroups.has(g.groupCode));
}

function renderLines() {
  const tb = $('lines-tbody');
  tb.innerHTML = '';
  const rows = filteredLines();
  rows.forEach((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + esc(l.invoiceNo) + '</td>' +
      '<td>' + esc(l.postingDate) + '</td>' +
      '<td>' + esc(l.sellToCustomerName || l.sellToCustomerNo) + '</td>' +
      '<td>' + esc(l.relatedCustomerNo || '') + '</td>' +
      '<td>' + esc(l.itemCode) + '</td>' +
      '<td>' + esc(l.description) + '</td>' +
      '<td class="num">' + fmtNum(l.quantity, 2) + '</td>' +
      '<td class="num">' + fmtNum(l.unitPrice, 2) + '</td>' +
      '<td class="num">' + fmtNum(l.lineDiscountPercent, 2) + '</td>' +
      '<td>—</td>' +
      '<td></td>';
    tb.appendChild(tr);
  });
  $('lines-empty').hidden = rows.length > 0;
}

function renderAll() {
  renderKpis();
  renderItems();
  renderGroups();
  renderLines();
}

// ---- Data loading ----
async function loadCustomers() {
  try {
    const code = $('salesperson-code').value.trim();
    const data = await api('/api/customers?salespersonCode=' + encodeURIComponent(code));
    const list = $('customer-list');
    list.innerHTML = '';
    (data.customers || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.customerNo || c.no || '';
      opt.label = c.name || c.customerName || '';
      list.appendChild(opt);
    });
    toast('Klienti ielādēti: ' + (data.customers || []).length, 'ok');
  } catch (err) {
    toast('Kļūda ielādējot klientus: ' + err.message, 'error');
  }
}

function resolveCustomer() {
  const raw = $('customer-input').value.trim();
  if (!raw) return null;
  const list = $('customer-list');
  for (const opt of list.options) {
    if (opt.value === raw || opt.label === raw) return { no: opt.value, name: opt.label };
  }
  const m = raw.match(/^([^\s]+)/);
  return { no: m ? m[1] : raw, name: raw };
}

async function runSearch() {
  const searchEl = $('table-search');
  if (searchEl) {
    if (looksLikeAutofillUsername(searchEl.value)) { searchEl.value = ''; state.filter.search = ''; }
    else state.filter.search = searchEl.value.trim().toLowerCase();
  }
  const cust = resolveCustomer();
  if (!cust) { toast('Izvēlies klientu', 'warn'); return; }
  state.customerNo = cust.no;
  state.customerName = cust.name;
  const payload = {
    customerNo: cust.no, customerName: cust.name,
    roleMode: $('role-select').value,
    dateFrom: $('date-from').value || null,
    dateTo: $('date-to').value || null,
    statusFilter: $('status-filter').value,
    tableSearch: state.filter.search,
    salespersonCode: $('salesperson-code').value.trim()
  };
  try {
    $('btn-search').disabled = true;
    const data = await api('/api/audit', { method: 'POST', body: JSON.stringify(payload) });
    state.items = data.items || [];
    state.groups = data.groups || [];
    state.rawLines = data.rawLines || [];
    state.summary = data.summary || {};
    state.selectedItems.clear();
    state.selectedGroups.clear();
    state.items.forEach((it) => { if (it.isManualUnsaved) state.selectedItems.add(it.itemCode); });
    renderAll();
    toast('Atrastas ' + state.items.length + ' preces', 'ok');
  } catch (err) {
    toast('Kļūda meklēšanā: ' + err.message, 'error');
  } finally {
    $('btn-search').disabled = false;
  }
}

// ---- 7004 modal ----
function openModal() { $('modal-7004').classList.add('is-open'); }
function closeModal() { $('modal-7004').classList.remove('is-open'); }

async function load7004FromOdata() {
  try {
    const cust = resolveCustomer();
    if (!cust) { toast('Izvēlies klientu', 'warn'); return; }
    const data = await api('/api/import-7004-cache', { method: 'POST', body: JSON.stringify({ customerNo: cust.no, data: null }) });
    toast('Ielādēts no OData: ' + (data.count || 0), 'ok');
  } catch (err) {
    toast('Kļūda: ' + err.message, 'error');
  }
}

async function save7004Cache() {
  const cust = resolveCustomer();
  if (!cust) { toast('Izvēlies klientu', 'warn'); return; }
  const text = $('textarea-7004').value;
  if (!text.trim()) { toast('Ievadi datus', 'warn'); return; }
  try {
    const data = await api('/api/import-7004-cache', { method: 'POST', body: JSON.stringify({ customerNo: cust.no, data: text }) });
    toast('Saglabāts: ' + (data.count || 0) + ' ieraksti', 'ok');
    closeModal();
  } catch (err) {
    toast('Kļūda: ' + err.message, 'error');
  }
}

// ---- Apply to 7004 ----
function collectRules() {
  const rules = [];
  document.querySelectorAll('[data-item-discount]').forEach((inp) => {
    const code = inp.getAttribute('data-item-discount');
    if (!state.selectedItems.has(code)) return;
    const it = state.items.find((x) => x.itemCode === code);
    rules.push({ type: 'item', code: code, uom: (it && it.unitOfMeasure) || '', discount: Number(inp.value) || 0 });
  });
  document.querySelectorAll('[data-group-discount]').forEach((inp) => {
    const code = inp.getAttribute('data-group-discount');
    if (!state.selectedGroups.has(code)) return;
    rules.push({ type: 'group', code: code, discount: Number(inp.value) || 0 });
  });
  return rules;
}

function applyCreatedToState(createdCodes) {
  (createdCodes || []).forEach((c) => {
    const code = String(c.code || '');
    const discount = Number(c.discount) || 0;
    if (c.type === 'item') {
      const it = state.items.find((x) => String(x.itemCode || '').toUpperCase() === code.toUpperCase());
      if (it) {
        it.suggestedDiscount = discount;
        it.existing7004ItemDiscount = discount;
        it.existing7004Effective = discount;
        it.status = 'MATCHES_7004';
        it.isManualUnsaved = false;
        it.missingIn7004 = false;
        state.selectedItems.delete(it.itemCode);
      }
    } else if (c.type === 'group') {
      const g = state.groups.find((x) => String(x.groupCode || '').toUpperCase() === code.toUpperCase());
      if (g) {
        g.existing7004GroupDiscount = discount;
        g.status = 'MATCHES_7004';
        g.manualUnsavedCount = 0;
        state.selectedGroups.delete(g.groupCode);
        state.items.forEach((it) => {
          if (String(it.groupCode || '').toUpperCase() === code.toUpperCase()) {
            it.existing7004GroupDiscount = discount;
            it.existing7004Effective = (it.existing7004ItemDiscount !== null && it.existing7004ItemDiscount !== undefined) ? it.existing7004ItemDiscount : discount;
            it.status = 'MATCHES_7004';
            it.isManualUnsaved = false;
            it.missingIn7004 = false;
            state.selectedItems.delete(it.itemCode);
          }
        });
      }
    }
  });
}

function uncheckSkipped(skippedExisting) {
  (skippedExisting || []).forEach((s) => {
    const code = String(s.code || '');
    if (s.type === 'item') {
      state.items.forEach((it) => { if (String(it.itemCode || '').toUpperCase() === code.toUpperCase()) state.selectedItems.delete(it.itemCode); });
    } else if (s.type === 'group') {
      state.groups.forEach((g) => { if (String(g.groupCode || '').toUpperCase() === code.toUpperCase()) state.selectedGroups.delete(g.groupCode); });
    }
  });
}

async function applyTo7004() {
  const rules = collectRules();
  if (!rules.length) { toast('Nav atlasīts nekas', 'warn'); return; }
  const cust = resolveCustomer();
  if (cust) state.customerNo = cust.no;
  if (!state.customerNo) { toast('Vispirms meklē klientu', 'warn'); return; }
  try {
    $('btn-apply-7004').disabled = true;
    const data = await api('/api/apply-7004', { method: 'POST', body: JSON.stringify({ customerNo: state.customerNo, rules: rules }) });
    const createdCodes = data.createdCodes || [];
    const skippedExisting = data.skippedExisting || [];
    applyCreatedToState(createdCodes);
    uncheckSkipped(skippedExisting);
    recalcSummary();
    renderAll();
    if (skippedExisting.length > 0 && createdCodes.length > 0) {
      toast('Ierakstīts: ' + createdCodes.length + ' | Izlaistas (jau ir 7004. lapā): ' + skippedExisting.length, 'warn');
    } else if (skippedExisting.length > 0 && createdCodes.length === 0) {
      toast('Izlaistas ' + skippedExisting.length + ' rindas — šīm precēm/grupām jau ir atlaide 7004. lapā!', 'warn');
    } else if (data.odataErrors && data.odataErrors.length) {
      toast('Kļūda: ' + data.odataErrors[0].error, 'error');
    } else {
      toast('Ierakstīts 7004. lapā: ' + createdCodes.length, 'ok');
    }
  } catch (err) {
    toast('Kļūda: ' + err.message, 'error');
  } finally {
    $('btn-apply-7004').disabled = false;
  }
}

function findDiscountInput(attr, code) {
  const inputs = document.querySelectorAll('[' + attr + ']');
  for (const inp of inputs) {
    if (inp.getAttribute(attr) === code) return inp;
  }
  return null;
}

async function applySingleItem(itemCode, btnEl) {
  const it = state.items.find((x) => x.itemCode === itemCode);
  if (!it || !state.customerNo) { toast('Vispirms meklē klientu', 'warn'); return; }
  const inp = findDiscountInput('data-item-discount', itemCode);
  const discount = inp ? (Number(inp.value) || 0) : (Number(it.suggestedDiscount) || 0);
  if (discount <= 0) { toast('Norādi atlaidi > 0%', 'warn'); return; }
  const prevText = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳...'; }
  try {
    const data = await api('/api/apply-7004', {
      method: 'POST',
      body: JSON.stringify({ customerNo: state.customerNo, rules: [{ type: 'item', code: it.itemCode, uom: it.unitOfMeasure || '', discount: discount }] })
    });
    if (data.skippedExisting && data.skippedExisting.length) {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText; }
      toast('Nepārrakstīts: ' + data.skippedExisting[0].code + ' jau ir 7004. lapā (' + data.skippedExisting[0].existingDiscount + '%)!', 'warn');
      return;
    }
    if (data.odataErrors && data.odataErrors.length) throw new Error(data.odataErrors[0].error || 'OData kļūda');
    it.suggestedDiscount = discount;
    it.existing7004ItemDiscount = discount;
    it.existing7004Effective = discount;
    it.status = 'MATCHES_7004';
    it.isManualUnsaved = false;
    it.missingIn7004 = false;
    state.selectedItems.delete(it.itemCode);
    recalcSummary();
    renderAll();
    toast('Ierakstīts 7004. lapā: ' + it.itemCode + ' (' + discount + '%)', 'ok');
  } catch (err) {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText; }
    toast('Kļūda: ' + err.message, 'error');
  }
}

async function applySingleGroup(groupCode, btnEl) {
  const g = state.groups.find((x) => x.groupCode === groupCode);
  if (!g || !state.customerNo) { toast('Vispirms meklē klientu', 'warn'); return; }
  const inp = findDiscountInput('data-group-discount', groupCode);
  const discount = inp ? (Number(inp.value) || 0) : (Number(g.suggestedDiscount) || 0);
  if (discount <= 0) { toast('Norādi atlaidi > 0%', 'warn'); return; }
  const prevText = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳...'; }
  try {
    const data = await api('/api/apply-7004', {
      method: 'POST',
      body: JSON.stringify({ customerNo: state.customerNo, rules: [{ type: 'group', code: g.groupCode, discount: discount }] })
    });
    if (data.skippedExisting && data.skippedExisting.length) {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText; }
      toast('Nepārrakstīts: ' + data.skippedExisting[0].code + ' jau ir 7004. lapā (' + data.skippedExisting[0].existingDiscount + '%)!', 'warn');
      return;
    }
    if (data.odataErrors && data.odataErrors.length) throw new Error(data.odataErrors[0].error || 'OData kļūda');
    g.existing7004GroupDiscount = discount;
    g.status = 'MATCHES_7004';
    g.manualUnsavedCount = 0;
    state.selectedGroups.delete(g.groupCode);
    state.items.forEach((it) => {
      if (it.groupCode === g.groupCode && Math.abs((Number(it.lastDiscountPercent) || 0) - discount) < 0.05) {
        it.existing7004GroupDiscount = discount;
        it.existing7004Effective = (it.existing7004ItemDiscount !== null && it.existing7004ItemDiscount !== undefined) ? it.existing7004ItemDiscount : discount;
        it.status = 'MATCHES_7004';
        it.isManualUnsaved = false;
        it.missingIn7004 = false;
        state.selectedItems.delete(it.itemCode);
      }
    });
    recalcSummary();
    renderAll();
    toast('Grupa ierakstīta 7004. lapā: ' + g.groupCode + ' (' + discount + '%)', 'ok');
  } catch (err) {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = prevText; }
    toast('Kļūda: ' + err.message, 'error');
  }
}

function copy7004() {
  const rules = collectRules();
  if (!rules.length) { toast('Nav atlasīts nekas', 'warn'); return; }
  const text = rules.map((r) => [state.customerNo, r.type, r.code, r.discount].join('\t')).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Nokopēts: ' + rules.length, 'ok')).catch((e) => toast('Kļūda: ' + e.message, 'error'));
}

// ---- Manual entry tab ----
function parseManualInputText(rawText, defaultDiscount, defaultType) {
  const entries = [];
  const lines = String(rawText || '').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let code = '';
    let disc = Number(defaultDiscount) || 0;
    if (trimmed.indexOf('\t') !== -1 || trimmed.indexOf(';') !== -1) {
      const parts = trimmed.split(/[\t;]/);
      code = String(parts[0] || '').trim();
      if (parts.length > 1) {
        const parsed = parseFloat(String(parts[1]).replace(',', '.'));
        if (!isNaN(parsed)) disc = parsed;
      }
    } else {
      const m = trimmed.match(/^(\S+)\s+(\d+(?:[.,]\d+)?)\s*%?$/);
      if (m) {
        code = m[1];
        const parsed = parseFloat(m[2].replace(',', '.'));
        if (!isNaN(parsed)) disc = parsed;
      } else {
        code = trimmed;
      }
    }
    if (!code) return;
    entries.push({ code: code, discount: disc, type: defaultType || 'auto' });
  });
  return entries;
}

async function loadManualEntriesToTable() {
  const cust = resolveCustomer();
  if (!cust) { toast('Vispirms izvēlies klientu augšā!', 'warn'); return; }
  state.customerNo = cust.no;
  const defaultDiscount = Number($('manual-default-discount').value) || 0;
  const defaultType = $('manual-default-type').value || 'auto';
  const entries = parseManualInputText($('manual-paste-input').value, defaultDiscount, defaultType);
  if (!entries.length) { toast('Ielīmē vismaz vienu artikulu', 'warn'); return; }
  try {
    $('btn-manual-parse').disabled = true;
    const data = await api('/api/lookup-manual', { method: 'POST', body: JSON.stringify({ customerNo: cust.no, entries: entries }) });
    const rows = data.rows || data.entries || [];
    state.manualRows = rows.map((r, idx) => ({
      id: 'm' + Date.now() + '_' + idx,
      selected: !r.alreadyIn7004,
      type: r.type || 'item',
      code: r.code || '',
      description: r.description || '',
      groupCode: r.groupCode || '',
      uom: r.uom || r.unitOfMeasure || '',
      discount: Number(r.discount) || 0,
      alreadyIn7004: !!r.alreadyIn7004,
      existing7004ItemDiscount: r.existing7004ItemDiscount !== undefined ? r.existing7004ItemDiscount : null,
      existing7004GroupDiscount: r.existing7004GroupDiscount !== undefined ? r.existing7004GroupDiscount : null,
      synced: false
    }));
    renderManual();
    toast('Ielādētas ' + state.manualRows.length + ' rindas', 'ok');
  } catch (err) {
    toast('Kļūda: ' + err.message, 'error');
  } finally {
    $('btn-manual-parse').disabled = false;
  }
}

function manualStatusBadge(r) {
  if (r.synced) return '<span class="status status--matches-7004">🟢 Saglabāts</span>';
  if (r.alreadyIn7004) {
    const d = r.existing7004ItemDiscount !== null && r.existing7004ItemDiscount !== undefined
      ? r.existing7004ItemDiscount
      : r.existing7004GroupDiscount;
    return '<span class="status status--differs-from-7004">🟠 Jau ir 7004. lapā: ' + fmtNum(d, 2) + '%</span>';
  }
  return '<span class="status status--missing-in-7004">🆕 Jauns</span>';
}

function renderManual() {
  const tb = $('manual-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  state.manualRows.forEach((r) => {
    const tr = document.createElement('tr');
    const checked = r.selected ? 'checked' : '';
    tr.innerHTML =
      '<td class="col-check"><input type="checkbox" data-manual-check="' + esc(r.id) + '" ' + checked + '></td>' +
      '<td><select data-manual-type="' + esc(r.id) + '">' +
        '<option value="item"' + (r.type === 'item' ? ' selected' : '') + '>Prece</option>' +
        '<option value="group"' + (r.type === 'group' ? ' selected' : '') + '>Grupa</option>' +
      '</select></td>' +
      '<td><input type="text" class="discount-input" style="width:120px" data-manual-code="' + esc(r.id) + '" value="' + esc(r.code) + '"></td>' +
      '<td>' + esc(r.description) + '</td>' +
      '<td>' + esc(r.groupCode) + '</td>' +
      '<td><input type="text" style="width:60px" data-manual-uom="' + esc(r.id) + '" value="' + esc(r.uom) + '"></td>' +
      '<td>' + manualStatusBadge(r) + '</td>' +
      '<td class="num"><input type="number" step="0.01" min="0" max="100" class="discount-input" data-manual-discount="' + esc(r.id) + '" value="' + fmtNum(r.discount, 2) + '"></td>' +
      '<td><button type="button" class="btn btn--sm btn--primary" data-manual-apply="' + esc(r.id) + '">⚡ Ierakstīt</button> ' +
        '<button type="button" class="btn btn--sm" data-manual-delete="' + esc(r.id) + '">✕</button></td>';
    tb.appendChild(tr);
  });
  const empty = $('manual-empty');
  if (empty) empty.hidden = state.manualRows.length > 0;
  const checkAll = $('manual-check-all');
  if (checkAll) checkAll.checked = state.manualRows.length > 0 && state.manualRows.every((r) => r.selected);
}

async function syncManualTo7004(singleRowId) {
  const cust = resolveCustomer();
  if (cust) state.customerNo = cust.no;
  if (!state.customerNo) { toast('Vispirms izvēlies klientu augšā!', 'warn'); return; }
  let rows;
  if (singleRowId) {
    const r = state.manualRows.find((x) => x.id === singleRowId);
    if (!r) return;
    rows = [r];
  } else {
    rows = state.manualRows.filter((r) => r.selected && !r.synced);
  }
  if (!rows.length) { toast('Nav atlasīts nekas', 'warn'); return; }
  const rules = rows.map((r) => ({ type: r.type, code: r.code, uom: r.uom || '', discount: Number(r.discount) || 0 }));
  try {
    $('btn-sync-manual-7004').disabled = true;
    const data = await api('/api/apply-7004', { method: 'POST', body: JSON.stringify({ customerNo: state.customerNo, rules: rules }) });
    const createdCodes = data.createdCodes || [];
    const skippedExisting = data.skippedExisting || [];
    createdCodes.forEach((c) => {
      const code = String(c.code || '').toUpperCase();
      state.manualRows.forEach((r) => {
        if (String(r.code || '').toUpperCase() === code && r.type === c.type) {
          r.synced = true;
          r.selected = false;
          r.alreadyIn7004 = true;
          if (c.type === 'item') r.existing7004ItemDiscount = Number(c.discount) || 0;
          else r.existing7004GroupDiscount = Number(c.discount) || 0;
        }
      });
    });
    skippedExisting.forEach((s) => {
      const code = String(s.code || '').toUpperCase();
      state.manualRows.forEach((r) => {
        if (String(r.code || '').toUpperCase() === code && r.type === s.type) r.selected = false;
      });
    });
    renderManual();
    if (skippedExisting.length > 0 && createdCodes.length > 0) {
      toast('Ierakstīts: ' + createdCodes.length + ' | Izlaistas (jau ir 7004. lapā): ' + skippedExisting.length, 'warn');
    } else if (skippedExisting.length > 0 && createdCodes.length === 0) {
      toast('Izlaistas ' + skippedExisting.length + ' rindas — šīm precēm/grupām jau ir atlaide 7004. lapā!', 'warn');
    } else if (data.odataErrors && data.odataErrors.length) {
      toast('Kļūda: ' + data.odataErrors[0].error, 'error');
    } else {
      toast('Ierakstīts 7004. lapā: ' + createdCodes.length, 'ok');
    }
  } catch (err) {
    toast('Kļūda: ' + err.message, 'error');
  } finally {
    $('btn-sync-manual-7004').disabled = false;
  }
}

function manualApplyAllDiscount() {
  const d = Number($('manual-default-discount').value) || 0;
  state.manualRows.forEach((r) => { r.discount = d; });
  renderManual();
}

function manualAddEmpty() {
  state.manualRows.push({
    id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    selected: true, type: 'item', code: '', description: '', groupCode: '', uom: '',
    discount: Number($('manual-default-discount').value) || 0,
    alreadyIn7004: false, existing7004ItemDiscount: null, existing7004GroupDiscount: null, synced: false
  });
  renderManual();
}

function manualClear() {
  state.manualRows = [];
  renderManual();
}

// ---- Exports ----
function itemsRows() {
  const rows = [['Preces kods', 'Nosaukums', 'Grupa', 'Mērv.', 'Pavadzīmju sk.', 'Kopā daudz.', 'Pēd. cena', 'Atlaide %', '7004. lapā', 'Statuss', 'Saglabājamā %']];
  filteredItems().forEach((it) => rows.push([it.itemCode, it.description, it.groupCode, it.unitOfMeasure, it.discountedInvoiceCount, fmtNum(it.totalQty, 2), fmtNum(it.lastUnitPrice, 2), fmtNum(it.lastDiscountPercent, 2), it.existing7004Effective === null || it.existing7004Effective === undefined ? '' : fmtNum(it.existing7004Effective, 2), statusLabel(it.status), fmtNum(it.suggestedDiscount, 2)]));
  return rows;
}

function groupsRows() {
  const rows = [['Atl. grupa', 'Manuālās atlaides', 'Preču sk.', 'Manuālo sk.', 'Kopējā %', '7004. lapā', 'Statuss', 'Saglabājamā %']];
  filteredGroups().forEach((g) => rows.push([g.groupCode, Array.isArray(g.manualDiscountsUsed) ? g.manualDiscountsUsed.join(', ') : '', g.uniqueItemsCount, g.manualUnsavedCount, fmtNum(g.commonManualDiscount, 2), g.existing7004GroupDiscount === null || g.existing7004GroupDiscount === undefined ? '' : fmtNum(g.existing7004GroupDiscount, 2), statusLabel(g.status), fmtNum(g.suggestedDiscount, 2)]));
  return rows;
}

function linesRows() {
  const rows = [['Pavadzīme', 'Datums', 'Tiešais pircējs', 'Saistītais klients', 'Preces kods', 'Nosaukums', 'Daudz.', 'Cena', 'Rindas atlaide %']];
  filteredLines().forEach((l) => rows.push([l.invoiceNo, l.postingDate, l.sellToCustomerName || l.sellToCustomerNo, l.relatedCustomerNo || '', l.itemCode, l.description, fmtNum(l.quantity, 2), fmtNum(l.unitPrice, 2), fmtNum(l.lineDiscountPercent, 2)]));
  return rows;
}

// ---- Filters / presets ----
function applyPreset(preset) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = $('date-from');
  const to = $('date-to');
  if (preset === 'last-year') { const d = new Date(today); d.setFullYear(d.getFullYear() - 1); from.value = iso(d); to.value = iso(today); }
  else if (preset === 'last-6m') { const d = new Date(today); d.setMonth(d.getMonth() - 6); from.value = iso(d); to.value = iso(today); }
  else if (preset === 'this-year') { from.value = today.getFullYear() + '-01-01'; to.value = iso(today); }
  else if (preset === 'all') { from.value = ''; to.value = ''; }
}

function resetFilters() {
  $('customer-input').value = '';
  $('role-select').value = 'related';
  $('date-from').value = '';
  $('date-to').value = '';
  $('status-filter').value = 'manual_unsaved';
  $('table-search').value = '';
  state.filter.status = 'manual_unsaved';
  state.filter.search = '';
  state.items = []; state.groups = []; state.rawLines = []; state.summary = {};
  state.selectedItems.clear(); state.selectedGroups.clear();
  renderAll();
}

function onFilterChange() {
  state.filter.status = $('status-filter').value;
  const searchEl = $('table-search');
  if (searchEl && looksLikeAutofillUsername(searchEl.value)) { searchEl.value = ''; state.filter.search = ''; }
  else state.filter.search = searchEl ? searchEl.value.trim().toLowerCase() : '';
  renderItems();
  renderGroups();
  renderLines();
}

// ---- Tabs ----
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.getAttribute('data-tab') === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + name));
}

// ---- OData modal ----
function openOdataModal() { $('modal-odata').classList.add('is-open'); }
function closeOdataModal() { $('modal-odata').classList.remove('is-open'); }

function fillOdataFields(cfg) {
  cfg = cfg || {};
  $('odata-base-url').value = cfg.baseUrl || ODATA_DEFAULTS.baseUrl;
  $('odata-company').value = cfg.company || ODATA_DEFAULTS.company;
  $('odata-username').value = cfg.username || '';
  if ($('odata-related-field')) $('odata-related-field').value = cfg.relatedCustomerField || '';
}

async function openOdataConnect() {
  openOdataModal();
  try {
    const cfg = await api('/api/config');
    fillOdataFields(cfg);
  } catch (err) {
    fillOdataFields({});
    toast('Kļūda ielādējot konfigurāciju: ' + err.message, 'error');
  }
}

async function saveOdataConfig() {
  const payload = {
    baseUrl: $('odata-base-url').value.trim(),
    company: $('odata-company').value.trim(),
    username: $('odata-username').value.trim(),
    password: $('odata-password').value,
    relatedCustomerField: $('odata-related-field').value.trim()
  };
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    toast('Konfigurācija saglabāta', 'ok');
    closeOdataModal();
    loadCustomers();
  } catch (err) {
    toast('Kļūda saglabājot: ' + err.message, 'error');
  }
}

async function testOdataSchema() {
  const out = $('odata-schema-output');
  out.textContent = 'Ielādē...';
  try {
    const payload = {
      baseUrl: $('odata-base-url').value.trim(),
      company: $('odata-company').value.trim(),
      username: $('odata-username').value.trim(),
      password: $('odata-password').value,
      relatedCustomerField: $('odata-related-field') ? $('odata-related-field').value.trim() : ''
    };
    await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    const schema = await api('/api/schema');
    const summary = {
      companyUrl: schema.companyUrl,
      customers: schema.customers,
      invoices: schema.invoices,
      invoiceLines: schema.invoiceLines,
      discounts7004: schema.discounts7004,
      items: schema.items,
      availableEntitySets: Object.keys(schema.entitySets || {})
    };
    out.textContent = JSON.stringify(summary, null, 2);
    $('connection-status').textContent = 'Savienots';
    toast('Shēma ielādēta', 'ok');
  } catch (err) {
    out.textContent = 'Kļūda: ' + err.message;
    toast('Shēmas kļūda: ' + err.message, 'error');
  }
}

// ---- Wiring ----
function wire() {
  $('btn-search').addEventListener('click', runSearch);
  $('btn-reset').addEventListener('click', resetFilters);
  $('btn-reload-customers').addEventListener('click', loadCustomers);
  $('btn-odata-connect').addEventListener('click', openOdataConnect);
  $('btn-close-odata').addEventListener('click', closeOdataModal);
  $('btn-save-odata').addEventListener('click', saveOdataConfig);
  $('btn-test-odata').addEventListener('click', testOdataSchema);
  $('btn-7004-cache').addEventListener('click', openModal);
  $('btn-close-7004').addEventListener('click', closeModal);
  $('btn-load-7004-odata').addEventListener('click', load7004FromOdata);
  $('btn-save-7004').addEventListener('click', save7004Cache);
  $('btn-apply-7004').addEventListener('click', applyTo7004);
  $('btn-copy-7004').addEventListener('click', copy7004);

  $('status-filter').addEventListener('change', onFilterChange);
  $('table-search').addEventListener('input', onFilterChange);

  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.getAttribute('data-preset'))));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.getAttribute('data-tab'))));

  $('btn-export-csv').addEventListener('click', () => exportRows(itemsRows(), 'preces'));
  $('btn-export-xls').addEventListener('click', () => exportRowsXls(itemsRows(), 'preces'));
  $('btn-export-groups-csv').addEventListener('click', () => exportRows(groupsRows(), 'grupas'));
  $('btn-export-groups-xls').addEventListener('click', () => exportRowsXls(groupsRows(), 'grupas'));
  $('btn-export-lines-csv').addEventListener('click', () => exportRows(linesRows(), 'rindas'));

  $('btn-select-all-items').addEventListener('click', () => { filteredItems().forEach((i) => state.selectedItems.add(i.itemCode)); renderItems(); });
  $('btn-clear-items').addEventListener('click', () => { state.selectedItems.clear(); renderItems(); });
  $('btn-select-all-groups').addEventListener('click', () => { filteredGroups().forEach((g) => state.selectedGroups.add(g.groupCode)); renderGroups(); });
  $('btn-clear-groups').addEventListener('click', () => { state.selectedGroups.clear(); renderGroups(); });

  $('items-check-all').addEventListener('change', (e) => {
    const rows = filteredItems();
    if (e.target.checked) rows.forEach((i) => state.selectedItems.add(i.itemCode));
    else rows.forEach((i) => state.selectedItems.delete(i.itemCode));
    renderItems();
  });
  $('groups-check-all').addEventListener('change', (e) => {
    const rows = filteredGroups();
    if (e.target.checked) rows.forEach((g) => state.selectedGroups.add(g.groupCode));
    else rows.forEach((g) => state.selectedGroups.delete(g.groupCode));
    renderGroups();
  });

  $('items-tbody').addEventListener('change', (e) => {
    const code = e.target.getAttribute('data-item');
    if (!code) return;
    if (e.target.checked) state.selectedItems.add(code); else state.selectedItems.delete(code);
    const rows = filteredItems();
    $('items-check-all').checked = rows.length > 0 && rows.every((it) => state.selectedItems.has(it.itemCode));
  });
  $('groups-tbody').addEventListener('change', (e) => {
    const code = e.target.getAttribute('data-group');
    if (!code) return;
    if (e.target.checked) state.selectedGroups.add(code); else state.selectedGroups.delete(code);
    const rows = filteredGroups();
    $('groups-check-all').checked = rows.length > 0 && rows.every((g) => state.selectedGroups.has(g.groupCode));
  });

  $('items-tbody').addEventListener('input', (e) => {
    const code = e.target.getAttribute('data-item-discount');
    if (!code) return;
    const it = state.items.find((x) => x.itemCode === code);
    if (it) it.suggestedDiscount = Number(e.target.value) || 0;
  });
  $('groups-tbody').addEventListener('input', (e) => {
    const code = e.target.getAttribute('data-group-discount');
    if (!code) return;
    const g = state.groups.find((x) => x.groupCode === code);
    if (g) g.suggestedDiscount = Number(e.target.value) || 0;
  });

  $('items-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-apply-item]');
    if (!btn) return;
    applySingleItem(btn.getAttribute('data-apply-item'), btn);
  });
  $('groups-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-apply-group]');
    if (!btn) return;
    applySingleGroup(btn.getAttribute('data-apply-group'), btn);
  });

  // Manual tab wiring
  if ($('btn-manual-parse')) $('btn-manual-parse').addEventListener('click', loadManualEntriesToTable);
  if ($('btn-manual-apply-all-disc')) $('btn-manual-apply-all-disc').addEventListener('click', manualApplyAllDiscount);
  if ($('btn-manual-add-empty')) $('btn-manual-add-empty').addEventListener('click', manualAddEmpty);
  if ($('btn-manual-clear')) $('btn-manual-clear').addEventListener('click', manualClear);
  if ($('btn-select-all-manual')) $('btn-select-all-manual').addEventListener('click', () => { state.manualRows.forEach((r) => { if (!r.synced) r.selected = true; }); renderManual(); });
  if ($('btn-clear-manual')) $('btn-clear-manual').addEventListener('click', () => { state.manualRows.forEach((r) => { r.selected = false; }); renderManual(); });
  if ($('btn-sync-manual-7004')) $('btn-sync-manual-7004').addEventListener('click', () => syncManualTo7004(null));
  if ($('manual-check-all')) $('manual-check-all').addEventListener('change', (e) => {
    state.manualRows.forEach((r) => { if (!r.synced) r.selected = e.target.checked; });
    renderManual();
  });

  if ($('manual-tbody')) {
    $('manual-tbody').addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-manual-check');
      if (id) {
        const r = state.manualRows.find((x) => x.id === id);
        if (r) r.selected = e.target.checked;
        const checkAll = $('manual-check-all');
        if (checkAll) checkAll.checked = state.manualRows.length > 0 && state.manualRows.every((x) => x.selected);
        return;
      }
      const typeId = e.target.getAttribute('data-manual-type');
      if (typeId) {
        const r = state.manualRows.find((x) => x.id === typeId);
        if (r) r.type = e.target.value;
      }
    });
    $('manual-tbody').addEventListener('input', (e) => {
      const codeId = e.target.getAttribute('data-manual-code');
      if (codeId) { const r = state.manualRows.find((x) => x.id === codeId); if (r) r.code = e.target.value; return; }
      const uomId = e.target.getAttribute('data-manual-uom');
      if (uomId) { const r = state.manualRows.find((x) => x.id === uomId); if (r) r.uom = e.target.value; return; }
      const discId = e.target.getAttribute('data-manual-discount');
      if (discId) { const r = state.manualRows.find((x) => x.id === discId); if (r) r.discount = Number(e.target.value) || 0; }
    });
    $('manual-tbody').addEventListener('click', (e) => {
      const applyBtn = e.target.closest('[data-manual-apply]');
      if (applyBtn) { syncManualTo7004(applyBtn.getAttribute('data-manual-apply')); return; }
      const delBtn = e.target.closest('[data-manual-delete]');
      if (delBtn) {
        const id = delBtn.getAttribute('data-manual-delete');
        state.manualRows = state.manualRows.filter((x) => x.id !== id);
        renderManual();
      }
    });
  }

  $('modal-7004').addEventListener('click', (e) => { if (e.target === $('modal-7004')) closeModal(); });
  $('modal-odata').addEventListener('click', (e) => { if (e.target === $('modal-odata')) closeOdataModal(); });
}

document.addEventListener('DOMContentLoaded', async () => {
  wire();
  sanitizeSearchInput();
  sanitizeCustomerInput();
  state.filter.search = '';

  applyPreset('last-year');
  try {
    const cfg = await api('/api/config');
    if (cfg.hasPassword) {
      $('connection-status').textContent = 'Savienots';
      loadCustomers();
    } else {
      openOdataConnect();
    }
  } catch (err) {
    toast('Kļūda ielādējot konfigurāciju: ' + err.message, 'error');
    openOdataConnect();
  }

  setTimeout(() => {
    sanitizeSearchInput();
    sanitizeCustomerInput();
  }, 300);
});
