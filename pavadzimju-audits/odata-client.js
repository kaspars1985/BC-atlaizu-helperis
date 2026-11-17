'use strict';

const bridge = require('./odata-bridge.js');

const {
  loadConfig,
  saveConfig,
  getPublicConfig,
  odataFetch,
  odataGetAll,
  discoverSchema,
  buildCompanyUrl
} = bridge;

function upper(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isExpired(endDate) {
  if (!endDate) return false;
  const s = String(endDate).trim();
  if (!s || s.startsWith('0001-01-01')) return false;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

function normalizeRule(r) {
  const type = String(r.type || '').trim();
  const code = String(r.code || '').trim();
  return {
    type,
    code,
    discount: toNum(r.discount),
    minQty: toNum(r.minQty),
    uom: String(r.uom || '').trim(),
    startDate: String(r.startDate || '').trim(),
    endDate: String(r.endDate || '').trim()
  };
}

function isGroupRuleType(type) {
  const t = String(type || '').trim().toLowerCase();
  return t.includes('group') || t.includes('grupa') || t.includes('disc.') || t.includes('atl.');
}

function isItemRuleType(type) {
  if (isGroupRuleType(type)) return false;
  const t = String(type || '').trim().toLowerCase();
  return t === 'item' || t === 'prece' || t.startsWith('item');
}

function isCustomerSalesType(value) {
  if (!value) return true;
  const t = String(value).toLowerCase();
  return t === 'customer' || t === 'klients';
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workerCount = Math.min(Math.max(1, limit || 3), items.length);
  const workers = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      while (nextIdx < items.length) {
        const idx = nextIdx;
        nextIdx += 1;
        results[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function getCustomers(salespersonCode, cfg) {
  const config = cfg || loadConfig();
  const schema = await discoverSchema(config);
  const wanted = String(salespersonCode || '').trim();
  const seen = new Map();

  const custSet = schema.customers && schema.customers.entitySet;
  if (custSet) {
    const f = schema.customers.fields;
    const select = [f.no, f.name, f.salespersonCode].filter(Boolean).join(',');
    const filterExpr = (wanted && f.salespersonCode)
      ? `${f.salespersonCode} eq '${wanted.replace(/'/g, "''")}'`
      : '';
    const buildUrl = (withFilter) => {
      const parts = [];
      if (withFilter && filterExpr) parts.push(`$filter=${encodeURIComponent(filterExpr)}`);
      if (select) parts.push(`$select=${select}`);
      return `${schema.companyUrl}/${custSet}${parts.length ? `?${parts.join('&')}` : ''}`;
    };

    let rows = [];
    try {
      rows = await odataGetAll(buildUrl(true), config);
    } catch (err) {
      rows = [];
    }
    if (rows.length === 0 && filterExpr) {
      try {
        rows = await odataGetAll(buildUrl(false), config);
      } catch (err) {
        rows = [];
      }
    }
    for (const r of rows) {
      const no = String(r[f.no] || '').trim();
      if (!no) continue;
      const sp = f.salespersonCode ? String(r[f.salespersonCode] || '').trim() : '';
      if (wanted && sp && sp !== wanted) continue;
      seen.set(no, { no, name: String(r[f.name] || '').trim(), salespersonCode: sp });
    }
  }

  if (seen.size === 0 && schema.invoices && schema.invoices.entitySet) {
    const f = schema.invoices.fields;
    const select = [f.sellToCustomerNo, f.sellToCustomerName, f.salespersonCode].filter(Boolean).join(',');
    const filterExpr = (wanted && f.salespersonCode)
      ? `${f.salespersonCode} eq '${wanted.replace(/'/g, "''")}'`
      : '';
    const buildUrl = (withFilter) => {
      const parts = [];
      if (withFilter && filterExpr) parts.push(`$filter=${encodeURIComponent(filterExpr)}`);
      if (select) parts.push(`$select=${select}`);
      return `${schema.companyUrl}/${schema.invoices.entitySet}${parts.length ? `?${parts.join('&')}` : ''}`;
    };

    let rows = [];
    try {
      rows = await odataGetAll(buildUrl(true), config);
    } catch (err) {
      rows = [];
    }
    if (rows.length === 0 && filterExpr) {
      try {
        rows = await odataGetAll(buildUrl(false), config);
      } catch (err) {
        rows = [];
      }
    }
    for (const r of rows) {
      const no = String(r[f.sellToCustomerNo] || '').trim();
      if (!no) continue;
      const sp = f.salespersonCode ? String(r[f.salespersonCode] || '').trim() : '';
      if (wanted && sp && sp !== wanted) continue;
      if (!seen.has(no)) {
        seen.set(no, { no, name: String(r[f.sellToCustomerName] || '').trim(), salespersonCode: sp });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.no.localeCompare(b.no));
}

async function getCustomerExistingDiscounts(customerNo, cfg, preloadedSchema) {
  const config = cfg || loadConfig();
  const cust = String(customerNo || '').trim();
  const rawRules = [];
  let source7004Available = false;

  try {
    const schema = preloadedSchema || await discoverSchema(config);
    const set = schema.discounts7004 && schema.discounts7004.entitySet;
    if (set) {
      const f = schema.discounts7004.fields;
      const select = [f.salesType, f.salesCode, f.type, f.code, f.uom, f.minQty, f.discount, f.startDate, f.endDate]
        .filter(Boolean)
        .join(',');
      const filter = f.salesCode ? `?$filter=${encodeURIComponent(`${f.salesCode} eq '${cust.replace(/'/g, "''")}'`)}` : '';
      const url = `${schema.companyUrl}/${set}${filter}${filter ? '&' : '?'}${select ? `$select=${select}` : ''}`.replace(/[?&]$/, '');
      const rows = await odataGetAll(url, config);
      source7004Available = true;
      for (const r of rows) {
        const salesCode = String(r[f.salesCode] || '').trim();
        if (salesCode && salesCode !== cust) continue;
        const salesType = f.salesType ? r[f.salesType] : '';
        if (!isCustomerSalesType(salesType)) continue;
        rawRules.push(normalizeRule({
          type: r[f.type],
          code: r[f.code],
          discount: r[f.discount],
          minQty: r[f.minQty],
          uom: r[f.uom],
          startDate: r[f.startDate],
          endDate: r[f.endDate]
        }));
      }
    }
  } catch (err) {
    source7004Available = false;
  }

  const cache = (config.cachedDiscounts7004 || {})[cust];
  if (Array.isArray(cache)) {
    for (const r of cache) rawRules.push(normalizeRule(r));
  }

  const itemRules = new Map();
  const groupRules = new Map();
  const itemRuleTiers = new Map();
  const groupRuleTiers = new Map();
  const kept = [];

  const addTier = (map, key, discount) => {
    if (!(discount > 0)) return;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    if (!arr.some(t => Math.abs(t - discount) < 0.0001)) arr.push(discount);
  };

  for (const r of rawRules) {
    if (!r.code) continue;
    if (isExpired(r.endDate)) continue;
    kept.push(r);
    const key = upper(r.code);
    if (isGroupRuleType(r.type)) {
      const cur = groupRules.has(key) ? groupRules.get(key) : null;
      if (cur === null || r.minQty === 0 || r.discount > cur) groupRules.set(key, r.discount);
      addTier(groupRuleTiers, key, r.discount);
    } else if (isItemRuleType(r.type)) {
      const cur = itemRules.has(key) ? itemRules.get(key) : null;
      if (cur === null || r.minQty === 0 || r.discount > cur) itemRules.set(key, r.discount);
      addTier(itemRuleTiers, key, r.discount);
    }
  }

  for (const arr of itemRuleTiers.values()) arr.sort((a, b) => a - b);
  for (const arr of groupRuleTiers.values()) arr.sort((a, b) => a - b);

  return { itemRules, groupRules, itemRuleTiers, groupRuleTiers, rawRules: kept, source7004Available };
}

function normalizeLine(raw, schema) {
  const f = schema.invoiceLines.fields;
  return {
    invoiceNo: String(raw[f.documentNo] || '').trim(),
    postingDate: String(raw[f.postingDate] || '').trim(),
    sellToCustomerNo: String(raw[f.sellToCustomerNo] || '').trim(),
    sellToCustomerName: '',
    relatedCustomerNo: String(raw[f.relatedCustomerNo] || '').trim(),
    lineNo: toNum(raw[f.lineNo]),
    itemCode: String(raw[f.no] || '').trim(),
    description: String(raw[f.description] || '').trim(),
    unitOfMeasure: String(raw[f.unitOfMeasure] || '').trim(),
    groupCode: String(raw[f.groupCode] || '').trim(),
    quantity: toNum(raw[f.quantity]),
    unitPrice: toNum(raw[f.unitPrice]),
    lineDiscountPercent: toNum(raw[f.lineDiscountPercent]),
    lineAmount: toNum(raw[f.lineAmount])
  };
}

async function auditCustomerInvoices(params, cfg) {
  const p = params || {};
  const config = cfg || loadConfig();
  const schema = await discoverSchema(config);
  const customerNo = String(p.customerNo || '').trim();
  const relatedCustomerNo = String(p.relatedCustomerNo || p.customerNo || '').trim();
  const matchMode = String(p.matchMode || p.roleMode || 'both').toLowerCase();
  const fromDate = String(p.fromDate || p.dateFrom || '').trim();
  const toDate = String(p.toDate || p.dateTo || '').trim();

  if (!schema.invoices.entitySet || !schema.invoiceLines.entitySet) {
    throw new Error('Invoices or invoice lines entity set not found in schema.');
  }

  const invF = schema.invoices.fields;
  const warnings = [];

  if (matchMode === 'related' && !invF.relatedCustomerNo) {
    throw new Error('Lauks "Saistītā klienta nr." nav atrodams publicētajā OData servisā (Page 143 sarakstā šī lauka nav). Lai filtrētu pēc Saistītā klienta, Tīmekļa pakalpojumos (page=810) nomainiet workflowPostedSalesInvoices Objekta ID no 143 uz 132 (Iegr. pārdošanas rēķins - kartīte), vai izvēlieties režīmu "Tiešais pircējs".');
  }
  if (matchMode === 'both' && !invF.relatedCustomerNo) {
    warnings.push('Brīdinājums: Page 143 OData servisā nav lauka "Saistītā klienta nr." — tika pārbaudīti tikai tiešā pircēja (Sell-to) rēķini. Lai redzētu arī saistītā klienta rēķinus, page=810 nomainiet Objekta ID no 143 uz 132.');
  }

  const conds = [];
  if (customerNo) {
    if (matchMode === 'direct' || matchMode === 'both') {
      if (invF.sellToCustomerNo) conds.push(`${invF.sellToCustomerNo} eq '${customerNo.replace(/'/g, "''")}'`);
    }
    if ((matchMode === 'related' || matchMode === 'both') && relatedCustomerNo && invF.relatedCustomerNo) {
      conds.push(`${invF.relatedCustomerNo} eq '${relatedCustomerNo.replace(/'/g, "''")}'`);
    }
    if (conds.length === 0 && invF.sellToCustomerNo) {
      conds.push(`${invF.sellToCustomerNo} eq '${customerNo.replace(/'/g, "''")}'`);
    }
  }

  const dateFilters = [];
  if (fromDate && invF.postingDate) dateFilters.push(`${invF.postingDate} ge ${fromDate}`);
  if (toDate && invF.postingDate) dateFilters.push(`${invF.postingDate} le ${toDate}`);

  const invSelect = [invF.no, invF.sellToCustomerNo, invF.sellToCustomerName, invF.relatedCustomerNo, invF.postingDate]
    .filter(Boolean)
    .join(',');

  const buildInvUrl = (fullFilters) => {
    const filterExpr = fullFilters.length ? fullFilters.join(' and ') : '';
    return `${schema.companyUrl}/${schema.invoices.entitySet}` +
      (filterExpr ? `?$filter=${encodeURIComponent(filterExpr)}` : '') +
      (invSelect ? `${filterExpr ? '&' : '?'}$select=${invSelect}` : '');
  };

  const invoiceMap = new Map();
  const addInvoiceRows = (rows) => {
    for (const r of rows) {
      const no = String(r[invF.no] || '').trim();
      if (!no) continue;
      if (invoiceMap.has(no)) continue;
      invoiceMap.set(no, {
        no,
        sellToCustomerNo: String(r[invF.sellToCustomerNo] || '').trim(),
        sellToCustomerName: String(r[invF.sellToCustomerName] || '').trim(),
        relatedCustomerNo: String(r[invF.relatedCustomerNo] || '').trim(),
        postingDate: String(r[invF.postingDate] || '').trim()
      });
    }
  };

  const relatedCond = (invF.relatedCustomerNo && relatedCustomerNo)
    ? `${invF.relatedCustomerNo} eq '${relatedCustomerNo.replace(/'/g, "''")}'`
    : null;

  if (conds.length === 0) {
    const rows = await odataGetAll(buildInvUrl(dateFilters), config);
    addInvoiceRows(rows);
  } else {
    for (const cond of conds) {
      const fullFilters = [cond, ...dateFilters];
      const invUrl = buildInvUrl(fullFilters);
      const isRelatedCond = relatedCond && cond === relatedCond;
      try {
        const rows = await odataGetAll(invUrl, config);
        addInvoiceRows(rows);
      } catch (err) {
        if (!isRelatedCond) throw err;
        const fallbackFilters = [...dateFilters];
        if (config.salespersonCode && invF.salespersonCode) {
          fallbackFilters.push(`${invF.salespersonCode} eq '${String(config.salespersonCode).replace(/'/g, "''")}'`);
        }
        const fallbackRows = await odataGetAll(buildInvUrl(fallbackFilters), config);
        const wanted = relatedCustomerNo;
        const filtered = fallbackRows.filter(r =>
          String(r[invF.relatedCustomerNo] || '').trim() === wanted
        );
        addInvoiceRows(filtered);
      }
    }
  }

  const invoiceNos = Array.from(invoiceMap.keys());
  const rawLines = [];
  const lineF = schema.invoiceLines.fields;

  const BATCH = 25;
  const lineBatches = [];
  for (let i = 0; i < invoiceNos.length; i += BATCH) {
    lineBatches.push(invoiceNos.slice(i, i + BATCH));
  }
  const lineBatchResults = await mapWithConcurrency(lineBatches, 3, async (batch) => {
    const orExpr = batch.map(n => `${lineF.documentNo} eq '${n.replace(/'/g, "''")}'`).join(' or ');
    const select = [
      lineF.documentNo, lineF.lineNo, lineF.type, lineF.no, lineF.description,
      lineF.unitOfMeasure, lineF.quantity, lineF.unitPrice, lineF.lineDiscountPercent,
      lineF.lineAmount, lineF.groupCode, lineF.sellToCustomerNo, lineF.relatedCustomerNo, lineF.postingDate
    ].filter(Boolean).join(',');
    const url = `${schema.companyUrl}/${schema.invoiceLines.entitySet}?$filter=${encodeURIComponent(orExpr)}` +
      (select ? `&$select=${select}` : '');
    return odataGetAll(url, config);
  });
  for (const rows of lineBatchResults) {
    for (const r of rows) {
      const line = normalizeLine(r, schema);
      if (!line.itemCode) continue;
      if (lineF.type) {
        const rawType = r[lineF.type];
        if (rawType !== undefined && rawType !== null && String(rawType).trim() !== '') {
          const t = String(rawType).trim().toLowerCase();
          if (t !== 'item' && t !== 'prece') continue;
        }
      }
      const inv = invoiceMap.get(line.invoiceNo);
      if (inv) {
        line.sellToCustomerNo = line.sellToCustomerNo || inv.sellToCustomerNo;
        line.sellToCustomerName = inv.sellToCustomerName;
        line.relatedCustomerNo = line.relatedCustomerNo || inv.relatedCustomerNo;
        line.postingDate = line.postingDate || inv.postingDate;
      }
      rawLines.push(line);
    }
  }

  try {
    const allItems = new Set();
    for (const line of rawLines) {
      if (line.itemCode) allItems.add(line.itemCode);
    }
    const uniqueItems = Array.from(allItems);
    if (
      uniqueItems.length > 0 &&
      schema.items && schema.items.entitySet &&
      schema.items.fields.no && schema.items.fields.itemDiscGroup
    ) {
      const noField = schema.items.fields.no;
      const discGroupField = schema.items.fields.itemDiscGroup;
      const groupMap = new Map();
      const ITEM_BATCH = 25;
      const itemBatches = [];
      for (let i = 0; i < uniqueItems.length; i += ITEM_BATCH) {
        itemBatches.push(uniqueItems.slice(i, i + ITEM_BATCH));
      }
      const itemBatchResults = await mapWithConcurrency(itemBatches, 3, async (batch) => {
        const orExpr = batch.map(n => `${noField} eq '${String(n).replace(/'/g, "''")}'`).join(' or ');
        const url = `${schema.companyUrl}/${schema.items.entitySet}?$filter=${encodeURIComponent(orExpr)}&$select=${noField},${discGroupField}`;
        try {
          return await odataGetAll(url, config);
        } catch (_) {
          return [];
        }
      });
      for (const rows of itemBatchResults) {
        for (const r of rows) {
          const no = upper(r[noField]);
          if (!no) continue;
          const g = String(r[discGroupField] || '').trim();
          if (g) groupMap.set(no, g);
        }
      }
      if (groupMap.size > 0) {
        for (const line of rawLines) {
          if (!line.itemCode) continue;
          const g = groupMap.get(upper(line.itemCode));
          if (g) line.groupCode = g;
        }
      }
    }
  } catch (_) {
    // item lookup failure never breaks the audit
  }

  const existing = await getCustomerExistingDiscounts(customerNo, config, schema);
  const grouped = groupAuditLines(rawLines, existing);
  grouped.warnings = warnings;
  if (grouped.summary) {
    grouped.summary.source7004Available = existing.source7004Available;
  }
  return grouped;
}

function groupAuditLines(rawLines, existingDiscounts) {
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const existing = existingDiscounts || { itemRules: new Map(), groupRules: new Map() };
  const itemRules = existing.itemRules instanceof Map ? existing.itemRules : new Map();
  const groupRules = existing.groupRules instanceof Map ? existing.groupRules : new Map();
  const itemRuleTiers = existing.itemRuleTiers instanceof Map ? existing.itemRuleTiers : new Map();
  const groupRuleTiers = existing.groupRuleTiers instanceof Map ? existing.groupRuleTiers : new Map();

  const byItem = new Map();
  const invoiceSet = new Set();

  for (const line of lines) {
    const key = upper(line.itemCode);
    if (!key) continue;
    invoiceSet.add(line.invoiceNo);
    let entry = byItem.get(key);
    if (!entry) {
      entry = {
        itemCode: line.itemCode,
        description: line.description,
        unitOfMeasure: line.unitOfMeasure,
        groupCode: line.groupCode,
        sellToCustomerNo: line.sellToCustomerNo,
        sellToCustomerName: line.sellToCustomerName,
        relatedCustomerNo: line.relatedCustomerNo,
        totalQty: 0,
        totalAmount: 0,
        discountedInvoices: new Set(),
        allInvoices: new Set(),
        manualDiscountsUsed: new Set(),
        lastDiscountPercent: 0,
        maxDiscountPercent: 0,
        lastUnitPrice: 0,
        lastInvoiceNo: '',
        lastInvoiceDate: '',
        lastDiscountedDate: '',
        invoiceList: []
      };
      byItem.set(key, entry);
    }
    entry.totalQty += toNum(line.quantity);
    entry.totalAmount += toNum(line.lineAmount);
    entry.allInvoices.add(line.invoiceNo);
    if (!entry.description && line.description) entry.description = line.description;
    if (!entry.groupCode && line.groupCode) entry.groupCode = line.groupCode;
    if (!entry.unitOfMeasure && line.unitOfMeasure) entry.unitOfMeasure = line.unitOfMeasure;

    const disc = toNum(line.lineDiscountPercent);
    if (disc > 0) {
      entry.discountedInvoices.add(line.invoiceNo);
      entry.manualDiscountsUsed.add(disc);
      if (disc > entry.maxDiscountPercent) entry.maxDiscountPercent = disc;
      const d = line.postingDate || '';
      if (!entry.lastDiscountedDate || d >= entry.lastDiscountedDate) {
        entry.lastDiscountedDate = d;
        entry.lastDiscountPercent = disc;
      }
    }

    const lineDate = line.postingDate || '';
    if (!entry.lastInvoiceDate || lineDate >= entry.lastInvoiceDate) {
      entry.lastInvoiceDate = lineDate;
      entry.lastInvoiceNo = line.invoiceNo;
      entry.lastUnitPrice = toNum(line.unitPrice);
    }

    entry.invoiceList.push({
      invoiceNo: line.invoiceNo,
      date: line.postingDate,
      qty: toNum(line.quantity),
      unitPrice: toNum(line.unitPrice),
      lineDiscountPercent: disc,
      lineAmount: toNum(line.lineAmount),
      sellToCustomerNo: line.sellToCustomerNo,
      sellToCustomerName: line.sellToCustomerName,
      relatedCustomerNo: line.relatedCustomerNo
    });
  }

  const items = [];
  const groupMap = new Map();

  for (const entry of byItem.values()) {
    const itemKey = upper(entry.itemCode);
    const groupKey = upper(entry.groupCode);
    const existing7004ItemDiscount = itemRules.has(itemKey) ? itemRules.get(itemKey) : null;
    const existing7004GroupDiscount = groupKey && groupRules.has(groupKey) ? groupRules.get(groupKey) : null;
    let existing7004Effective = existing7004ItemDiscount !== null
      ? existing7004ItemDiscount
      : (existing7004GroupDiscount !== null ? existing7004GroupDiscount : null);

    const itemTiers = itemRuleTiers.get(itemKey)
      || (existing7004ItemDiscount !== null ? [existing7004ItemDiscount] : []);
    const groupTiers = (groupKey && groupRuleTiers.get(groupKey))
      || (existing7004GroupDiscount !== null ? [existing7004GroupDiscount] : []);
    const effectiveTiers = itemTiers.length > 0 ? itemTiers : groupTiers;

    let status;
    if (entry.maxDiscountPercent > 0) {
      if (existing7004Effective === null || existing7004Effective === 0) {
        status = 'MISSING_IN_7004';
      } else {
        const matchedTier = effectiveTiers.find(t => Math.abs(entry.lastDiscountPercent - t) < 0.05);
        if (Math.abs(entry.lastDiscountPercent - existing7004Effective) < 0.05 || matchedTier !== undefined) {
          status = 'MATCHES_7004';
          if (matchedTier !== undefined) existing7004Effective = matchedTier;
        } else {
          status = 'DIFFERS_FROM_7004';
        }
      }
    } else {
      status = 'ZERO_DISCOUNT';
    }

    const suggestedDiscount = entry.lastDiscountPercent > 0
      ? entry.lastDiscountPercent
      : (entry.maxDiscountPercent || 0);

    const item = {
      itemCode: entry.itemCode,
      description: entry.description,
      unitOfMeasure: entry.unitOfMeasure,
      groupCode: entry.groupCode,
      sellToCustomerNo: entry.sellToCustomerNo,
      sellToCustomerName: entry.sellToCustomerName,
      relatedCustomerNo: entry.relatedCustomerNo,
      totalQty: entry.totalQty,
      totalAmount: entry.totalAmount,
      discountedInvoiceCount: entry.discountedInvoices.size,
      totalInvoiceCount: entry.allInvoices.size,
      manualDiscountsUsed: Array.from(entry.manualDiscountsUsed).sort((a, b) => a - b),
      lastDiscountPercent: entry.lastDiscountPercent,
      maxDiscountPercent: entry.maxDiscountPercent,
      lastUnitPrice: entry.lastUnitPrice,
      lastInvoiceNo: entry.lastInvoiceNo,
      lastInvoiceDate: entry.lastInvoiceDate,
      existing7004ItemDiscount,
      existing7004GroupDiscount,
      existing7004Effective,
      status,
      isManualUnsaved: status === 'MISSING_IN_7004' || status === 'DIFFERS_FROM_7004',
      missingIn7004: status === 'MISSING_IN_7004',
      suggestedDiscount,
      invoiceList: entry.invoiceList
    };
    items.push(item);

    if (entry.maxDiscountPercent > 0 && groupKey) {
      let g = groupMap.get(groupKey);
      if (!g) {
        g = {
          groupCode: entry.groupCode,
          uniqueItemsCount: 0,
          manualUnsavedCount: 0,
          totalQty: 0,
          totalAmount: 0,
          manualDiscountsUsed: new Set(),
          existing7004GroupDiscount: groupRules.has(groupKey) ? groupRules.get(groupKey) : null,
          sampleItems: []
        };
        groupMap.set(groupKey, g);
      }
      g.uniqueItemsCount += 1;
      if (item.isManualUnsaved) g.manualUnsavedCount += 1;
      g.totalQty += item.totalQty;
      g.totalAmount += item.totalAmount;
      for (const d of item.manualDiscountsUsed) g.manualDiscountsUsed.add(d);
      if (g.sampleItems.length < 5) g.sampleItems.push(item.itemCode);
    }
  }

  const groups = [];
  for (const g of groupMap.values()) {
    const used = Array.from(g.manualDiscountsUsed).sort((a, b) => a - b);
    const commonManualDiscount = used.length ? used[used.length - 1] : 0;
    const gKey = upper(g.groupCode);
    const gTiers = groupRuleTiers.get(gKey)
      || (g.existing7004GroupDiscount !== null ? [g.existing7004GroupDiscount] : []);
    let gStatus;
    if (g.existing7004GroupDiscount === null || g.existing7004GroupDiscount === 0) {
      gStatus = 'MISSING_IN_7004';
    } else if (
      g.manualUnsavedCount === 0 ||
      Math.abs(commonManualDiscount - g.existing7004GroupDiscount) < 0.05 ||
      gTiers.some(t => Math.abs(commonManualDiscount - t) < 0.05)
    ) {
      gStatus = 'MATCHES_7004';
    } else {
      gStatus = 'DIFFERS_FROM_7004';
    }
    groups.push({
      groupCode: g.groupCode,
      uniqueItemsCount: g.uniqueItemsCount,
      manualUnsavedCount: g.manualUnsavedCount,
      totalQty: g.totalQty,
      totalAmount: g.totalAmount,
      commonManualDiscount,
      manualDiscountsUsed: used,
      existing7004GroupDiscount: g.existing7004GroupDiscount,
      suggestedDiscount: commonManualDiscount,
      sampleItems: g.sampleItems,
      status: gStatus
    });
  }
  groups.sort((a, b) => b.manualUnsavedCount - a.manualUnsavedCount);

  let manualDiscountLinesCount = 0;
  let uniqueDiscountedItemsCount = 0;
  let missingIn7004Count = 0;
  let differsFrom7004Count = 0;
  let zeroDiscountItemsCount = 0;

  for (const it of items) {
    if (it.maxDiscountPercent > 0) {
      uniqueDiscountedItemsCount += 1;
      manualDiscountLinesCount += it.invoiceList.filter(l => l.lineDiscountPercent > 0).length;
      if (it.status === 'MISSING_IN_7004') missingIn7004Count += 1;
      if (it.status === 'DIFFERS_FROM_7004') differsFrom7004Count += 1;
    } else {
      zeroDiscountItemsCount += 1;
    }
  }

  return {
    summary: {
      totalInvoicesChecked: invoiceSet.size,
      totalItemLinesChecked: lines.length,
      manualDiscountLinesCount,
      uniqueDiscountedItemsCount,
      missingIn7004Count,
      differsFrom7004Count,
      manualUnsavedCount: missingIn7004Count + differsFrom7004Count,
      zeroDiscountItemsCount
    },
    items,
    groups,
    rawLines: lines
  };
}

function parseTsvRows(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const idx = (names) => {
    for (const n of names) {
      const i = header.findIndex(h => h === n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const iType = idx(['type', 'veids']);
  const iCode = idx(['code', 'kods']);
  const iDisc = idx(['line_discount_percent', 'line discount %', 'discount', 'atlaide %', 'atlaide']);
  const iMinQty = idx(['minimum_quantity', 'minimum quantity', 'min qty', 'minqty']);
  const iUom = idx(['unit_of_measure_code', 'unit of measure', 'uom']);
  const iStart = idx(['starting_date', 'start date', 'startdate']);
  const iEnd = idx(['ending_date', 'end date', 'enddate']);

  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split('\t');
    const type = iType >= 0 ? String(cols[iType] || '').trim() : '';
    const code = iCode >= 0 ? String(cols[iCode] || '').trim() : '';
    if (!code) continue;
    out.push(normalizeRule({
      type,
      code,
      discount: iDisc >= 0 ? cols[iDisc] : 0,
      minQty: iMinQty >= 0 ? cols[iMinQty] : 0,
      uom: iUom >= 0 ? cols[iUom] : '',
      startDate: iStart >= 0 ? cols[iStart] : '',
      endDate: iEnd >= 0 ? cols[iEnd] : ''
    }));
  }
  return out;
}

function importCachedDiscounts7004(customerNo, rawInput, cfg) {
  const config = cfg || loadConfig();
  const cust = String(customerNo || '').trim();
  if (!cust) throw new Error('customerNo is required');

  let rules = [];
  const input = rawInput == null ? '' : rawInput;

  if (Array.isArray(input)) {
    rules = input.map(normalizeRule);
  } else if (typeof input === 'object') {
    const arr = Array.isArray(input.rules) ? input.rules : (Array.isArray(input.discounts) ? input.discounts : []);
    rules = arr.map(normalizeRule);
  } else {
    const text = String(input).trim();
    if (!text) {
      rules = [];
    } else if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rules) ? parsed.rules : (Array.isArray(parsed.discounts) ? parsed.discounts : []));
      rules = arr.map(normalizeRule);
    } else {
      rules = parseTsvRows(text);
    }
  }

  const cache = { ...(config.cachedDiscounts7004 || {}) };
  cache[cust] = rules;
  const saved = saveConfig({ ...config, cachedDiscounts7004: cache });
  return { customerNo: cust, count: rules.length, rules, config: saved };
}

function extractOdataError(postRes) {
  let errMsg = '';
  const bodyText = postRes ? postRes.body : '';
  if (bodyText && typeof bodyText === 'object') {
    if (bodyText.error && bodyText.error.message) {
      errMsg = String(bodyText.error.message);
    } else {
      errMsg = JSON.stringify(bodyText).slice(0, 200);
    }
  } else if (typeof bodyText === 'string' && bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && parsed.error && parsed.error.message) {
        errMsg = String(parsed.error.message);
      } else {
        errMsg = String(bodyText).slice(0, 200);
      }
    } catch (_) {
      errMsg = String(bodyText).slice(0, 200);
    }
  }
  if (!errMsg && postRes) {
    errMsg = `${postRes.status || ''} ${postRes.statusText || ''}`.trim();
  }
  if (!errMsg) errMsg = 'Unknown error';
  return errMsg;
}

async function applyDiscountsTo7004(customerNo, rules, cfg) {
  const config = cfg || loadConfig();
  const cust = String(customerNo || '').trim();
  if (!cust) throw new Error('customerNo is required');
  const list = (Array.isArray(rules) ? rules : []).map(normalizeRule);

  const cache = { ...(config.cachedDiscounts7004 || {}) };

  const createdCodes = [];
  const skippedExisting = [];
  const odataErrors = [];
  let odataCreated = 0;

  const online = Boolean(config.username && config.password);
  let schema = null;
  let endpoint = '';
  if (online) {
    try {
      schema = await discoverSchema(config);
      const set = schema.discounts7004 && schema.discounts7004.entitySet;
      if (set && schema.companyUrl) {
        endpoint = `${schema.companyUrl}/${set}`;
      }
    } catch (err) {
      odataErrors.push({ code: '', error: err && err.message ? err.message : String(err) });
    }
  }

  const existing = await getCustomerExistingDiscounts(cust, config, schema);

  const mergeIntoCache = (r) => {
    const existingList = Array.isArray(cache[cust]) ? cache[cust] : [];
    const idx = existingList.findIndex(b =>
      (isGroupRuleType(r.type) === isGroupRuleType(b.type)) && upper(r.code) === upper(b.code)
    );
    if (idx >= 0) {
      existingList[idx] = r;
    } else {
      existingList.push(r);
    }
    cache[cust] = existingList;
  };

  const toCreate = [];
  for (const r of list) {
    if (!r.code) continue;
    const key = upper(r.code);
    const isGroup = isGroupRuleType(r.type);

    if (isGroup && existing.groupRules.has(key)) {
      skippedExisting.push({ code: r.code, type: 'group', existingDiscount: existing.groupRules.get(key) });
      continue;
    }
    if (!isGroup && existing.itemRules.has(key)) {
      skippedExisting.push({ code: r.code, type: 'item', existingDiscount: existing.itemRules.get(key) });
      continue;
    }
    toCreate.push({ r, isGroup });
  }

  if (online && endpoint) {
    await mapWithConcurrency(toCreate, 3, async ({ r, isGroup }) => {
      const payload = {
        Sales_Type: 'Customer',
        Sales_Code: cust,
        Type: isGroup ? 'Item Discount Group' : 'Item',
        Code: r.code,
        Unit_of_Measure_Code: isGroup ? '' : (r.uom || ''),
        Minimum_Quantity: toNum(r.minQty),
        Line_Discount_Percent: toNum(r.discount)
      };
      try {
        const postRes = await odataFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        }, config);
        if (postRes && postRes.ok) {
          odataCreated += 1;
          createdCodes.push({ code: r.code, type: isGroup ? 'group' : 'item', discount: toNum(r.discount) });
          mergeIntoCache(r);
        } else {
          odataErrors.push({ code: r.code, error: extractOdataError(postRes) });
        }
      } catch (err) {
        odataErrors.push({ code: r.code, error: err && err.message ? err.message : String(err) });
      }
    });
  } else {
    for (const { r, isGroup } of toCreate) {
      createdCodes.push({ code: r.code, type: isGroup ? 'group' : 'item', discount: toNum(r.discount) });
      mergeIntoCache(r);
    }
  }

  const saved = saveConfig({ ...config, cachedDiscounts7004: cache });

  return {
    customerNo: cust,
    count: createdCodes.length,
    rules: list,
    config: saved,
    createdCodes,
    skippedExisting,
    odataCreated,
    odataErrors
  };
}

async function lookupManualEntries(customerNo, entries, cfg) {
  const config = cfg || loadConfig();
  const cust = String(customerNo || '').trim();
  const schema = await discoverSchema(config).catch(() => null);
  const existing = cust
    ? await getCustomerExistingDiscounts(cust, config, schema)
    : { itemRules: new Map(), groupRules: new Map() };

  const input = Array.isArray(entries) ? entries : [];
  const normalized = input
    .map(e => ({
      code: String((e && e.code) || '').trim(),
      discount: e ? e.discount : 0,
      type: e ? e.type : '',
      uom: e ? e.uom : ''
    }))
    .filter(e => e.code);

  const itemInfoMap = new Map();
  if (normalized.length > 0 && schema) {
    try {
      if (schema.items && schema.items.entitySet) {
        const f = schema.items.fields;
        const select = [f.no, f.description, f.unitOfMeasure, f.itemDiscGroup].filter(Boolean).join(',');
        const uniqueCodes = Array.from(new Set(normalized.map(e => e.code)));
        const BATCH = 25;
        const batches = [];
        for (let i = 0; i < uniqueCodes.length; i += BATCH) {
          batches.push(uniqueCodes.slice(i, i + BATCH));
        }
        const batchResults = await mapWithConcurrency(batches, 3, async (batch) => {
          const orExpr = batch.map(n => `${f.no} eq '${String(n).replace(/'/g, "''")}'`).join(' or ');
          const url = `${schema.companyUrl}/${schema.items.entitySet}?$filter=${encodeURIComponent(orExpr)}` +
            (select ? `&$select=${select}` : '');
          try {
            return await odataGetAll(url, config);
          } catch (_) {
            return [];
          }
        });
        for (const rows of batchResults) {
          for (const r of rows) {
            const no = String(r[f.no] || '').trim();
            if (!no) continue;
            itemInfoMap.set(upper(no), {
              no,
              description: String(r[f.description] || '').trim(),
              uom: String(r[f.unitOfMeasure] || '').trim(),
              groupCode: String(r[f.itemDiscGroup] || '').trim()
            });
          }
        }
      }
    } catch (_) {
      // item lookup failure never breaks the manual lookup
    }
  }

  const rows = [];
  for (const e of normalized) {
    const rawCode = String(e.code || '').trim();
    const key = upper(rawCode);
    const info = itemInfoMap.get(key) || null;

    let resolvedType;
    if (e.type === 'group' || e.type === 'item') {
      resolvedType = e.type;
    } else if (info) {
      resolvedType = 'item';
    } else if (/^\d{4}(_[A-Za-z0-9]+)?$/.test(rawCode) || existing.groupRules.has(key)) {
      resolvedType = 'group';
    } else {
      resolvedType = 'item';
    }

    const groupCode = resolvedType === 'group' ? rawCode : (info ? info.groupCode : '');
    const existingItemDisc = existing.itemRules.has(key) ? existing.itemRules.get(key) : null;
    const gKey = upper(groupCode);
    const existingGroupDisc = (gKey && existing.groupRules.has(gKey)) ? existing.groupRules.get(gKey) : null;
    const alreadyIn7004 = resolvedType === 'group'
      ? (existingGroupDisc !== null && existingGroupDisc > 0)
      : (existingItemDisc !== null && existingItemDisc > 0);

    rows.push({
      code: info ? info.no : rawCode,
      type: resolvedType,
      description: info ? info.description : (resolvedType === 'group' ? 'Preču atlaižu grupa' : ''),
      uom: resolvedType === 'group' ? '' : (e.uom || (info ? info.uom : 'GAB') || 'GAB'),
      groupCode,
      discount: toNum(e.discount),
      foundInBc: Boolean(info) || resolvedType === 'group',
      existing7004ItemDiscount: existingItemDisc,
      existing7004GroupDiscount: existingGroupDisc,
      alreadyIn7004
    });
  }

  return { customerNo: cust, rows };
}

module.exports = {
  loadConfig,
  saveConfig,
  getPublicConfig,
  odataFetch,
  odataGetAll,
  discoverSchema,
  buildCompanyUrl,
  getCustomers,
  getCustomerExistingDiscounts,
  auditCustomerInvoices,
  groupAuditLines,
  importCachedDiscounts7004,
  applyDiscountsTo7004,
  lookupManualEntries
};
