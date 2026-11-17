'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, '.config.json');

const DEFAULT_CONFIG = {
  baseUrl: 'https://amfbc.amf.lv:7048/AMF/ODataV4',
  company: 'AM Furnitūra EUR',
  salespersonCode: '23',
  username: '',
  password: '',
  entityOverrides: {
    customers: '',
    invoices: '',
    invoiceLines: '',
    discounts7004: '',
    items: ''
  },
  fieldOverrides: {
    relatedCustomerNo: '',
    groupCode: ''
  },
  cachedDiscounts7004: {}
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!override || typeof override !== 'object') return out;
  for (const key of Object.keys(override)) {
    const v = override[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], v);
    } else if (v !== undefined) {
      out[key] = v;
    }
  }
  return out;
}

function loadConfig() {
  let merged;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    merged = deepMerge(DEFAULT_CONFIG, parsed);
  } catch (err) {
    merged = deepMerge(DEFAULT_CONFIG, {});
  }
  if (!merged.baseUrl || !String(merged.baseUrl).trim()) {
    merged.baseUrl = DEFAULT_CONFIG.baseUrl;
  }
  if (!merged.company || !String(merged.company).trim()) {
    merged.company = DEFAULT_CONFIG.company;
  }
  return merged;
}

function saveConfig(cfg) {
  const existing = loadConfig();
  const merged = deepMerge(DEFAULT_CONFIG, cfg || {});
  if (!merged.baseUrl || !String(merged.baseUrl).trim()) {
    merged.baseUrl = DEFAULT_CONFIG.baseUrl;
  }
  if (!merged.company || !String(merged.company).trim()) {
    merged.company = DEFAULT_CONFIG.company;
  }
  if (merged.password === '' || merged.password === undefined || merged.password === null) {
    merged.password = existing.password || '';
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  clearSchemaCache();
  return merged;
}

function getPublicConfig() {
  const cfg = loadConfig();
  return {
    ...cfg,
    password: '',
    hasPassword: Boolean(cfg.password)
  };
}

function buildCompanyUrl(cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const company = encodeURIComponent(cfg.company || '');
  return `${base}/Company('${company}')`;
}

function escapePsSingle(str) {
  return String(str).replace(/'/g, "''");
}

const PS_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8NoBom)
$stdout.AutoFlush = $true

[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$clients = @{}

function Get-ClientForCreds([string]$u, [string]$p, [string]$urlStr) {
  $key = ($u + "::" + $p)
  if (-not $clients.ContainsKey($key)) {
    $handler = New-Object System.Net.Http.HttpClientHandler
    try {
      $handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    } catch {}
    if ($u -and $p) {
      $idx = $u.IndexOf([char]92)
      if ($idx -gt 0) {
        $domain = $u.Substring(0, $idx)
        $user = $u.Substring($idx + 1)
        $cred = New-Object System.Net.NetworkCredential($user, $p, $domain)
      } else {
        $cred = New-Object System.Net.NetworkCredential($u, $p)
      }
      $uri = [Uri]$urlStr
      $cache = New-Object System.Net.CredentialCache
      $cache.Add($uri, 'Negotiate', $cred)
      $cache.Add($uri, 'NTLM', $cred)
      $cache.Add($uri, 'Basic', $cred)
      $handler.Credentials = $cache
      $handler.PreAuthenticate = $true
    } else {
      $handler.UseDefaultCredentials = $true
    }
    $c = New-Object System.Net.Http.HttpClient($handler)
    $c.Timeout = [TimeSpan]::FromSeconds(120)
    $clients[$key] = $c
  }
  return $clients[$key]
}

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $reqId = ''
  try {
    $req = $line | ConvertFrom-Json
    $reqId = [string]$req.id
    $u = [string]$req.username
    $p = [string]$req.password
    $client = Get-ClientForCreds $u $p ([string]$req.url)
    $timeout = 60
    if ($req.timeoutSec) { $timeout = [int]$req.timeoutSec }
    $cts = New-Object System.Threading.CancellationTokenSource([TimeSpan]::FromSeconds($timeout))
    $method = [string]$req.method
    if (-not $method) { $method = 'GET' }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($method), [string]$req.url)
    if ($req.headers) {
      foreach ($prop in $req.headers.PSObject.Properties) {
        [void]$msg.Headers.TryAddWithoutValidation($prop.Name, [string]$prop.Value)
      }
    }
    if ($req.body -ne $null -and [string]$req.body -ne '') {
      $content = New-Object System.Net.Http.StringContent([string]$req.body, [System.Text.Encoding]::UTF8, 'application/json')
      $msg.Content = $content
    }
    $resp = $client.SendAsync($msg, $cts.Token).GetAwaiter().GetResult()
    $status = [int]$resp.StatusCode
    $statusText = [string]$resp.ReasonPhrase
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $authHeader = ''
    if ($status -eq 401 -or $status -eq 403) {
      if ($resp.Headers.WwwAuthenticate) {
        $authHeader = ($resp.Headers.WwwAuthenticate | ForEach-Object { $_.ToString() }) -join ', '
      }
    }
    $result = [ordered]@{
      id = $reqId
      ok = ($status -ge 200 -and $status -lt 300)
      status = $status
      statusText = $statusText
      body = $body
      authHeader = $authHeader
    }
    $stdout.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
  } catch {
    $errResult = [ordered]@{
      id = $reqId
      ok = $false
      status = 0
      statusText = 'PowerShellError'
      body = $_.Exception.Message
      authHeader = ''
    }
    $stdout.WriteLine(($errResult | ConvertTo-Json -Compress -Depth 5))
  }
}
`;

const MAX_PS_WORKERS = 3;
const psWorkers = [];
const psQueue = [];
let psReqSeq = 0;

function spawnPsWorker() {
  const encoded = Buffer.from(PS_WORKER_SCRIPT, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const worker = {
    child,
    busy: false,
    pending: null,
    buf: '',
    dead: false
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    worker.buf += chunk;
    let idx;
    while ((idx = worker.buf.indexOf('\n')) >= 0) {
      const line = worker.buf.slice(0, idx).replace(/\r$/, '').trim();
      worker.buf = worker.buf.slice(idx + 1);
      if (!line) continue;
      const pending = worker.pending;
      worker.pending = null;
      worker.busy = false;
      if (pending) {
        try {
          const parsed = JSON.parse(line.replace(/^\uFEFF/, ''));
          pending.resolve({
            ok: Boolean(parsed.ok),
            status: Number(parsed.status) || 0,
            statusText: parsed.statusText || '',
            body: parsed.body || '',
            authHeader: parsed.authHeader || ''
          });
        } catch (err) {
          pending.resolve({
            ok: false,
            status: 0,
            statusText: 'BridgeParseError',
            body: err && err.message ? err.message : String(err),
            authHeader: ''
          });
        }
      }
      dispatchPsQueue();
    }
  });

  const handleExit = (reason) => {
    if (worker.dead) return;
    worker.dead = true;
    const i = psWorkers.indexOf(worker);
    if (i >= 0) psWorkers.splice(i, 1);
    if (worker.pending) {
      const pending = worker.pending;
      worker.pending = null;
      pending.resolve({
        ok: false,
        status: 0,
        statusText: 'BridgeExitError',
        body: reason || 'PowerShell worker exited unexpectedly',
        authHeader: ''
      });
    }
    dispatchPsQueue();
  };

  child.on('error', (err) => handleExit(err && err.message ? err.message : String(err)));
  child.on('exit', (code) => handleExit(`PowerShell worker exited (${code})`));

  psWorkers.push(worker);
  return worker;
}

function dispatchPsQueue() {
  while (psQueue.length > 0) {
    let worker = psWorkers.find((w) => !w.busy && !w.dead);
    if (!worker && psWorkers.length < MAX_PS_WORKERS) {
      worker = spawnPsWorker();
    }
    if (!worker) break;
    const task = psQueue.shift();
    worker.busy = true;
    worker.pending = task;
    try {
      worker.child.stdin.write(JSON.stringify(task.payload) + '\n', 'utf8');
    } catch (err) {
      worker.busy = false;
      worker.pending = null;
      task.resolve({
        ok: false,
        status: 0,
        statusText: 'BridgeWriteError',
        body: err && err.message ? err.message : String(err),
        authHeader: ''
      });
    }
  }
}

function closeBridge() {
  while (psQueue.length > 0) {
    const task = psQueue.shift();
    task.resolve({ ok: false, status: 0, statusText: 'BridgeClosed', body: 'Bridge closed', authHeader: '' });
  }
  for (const w of psWorkers.slice()) {
    w.dead = true;
    try { w.child.stdin.end(); } catch (_) {}
    try { w.child.kill(); } catch (_) {}
  }
  psWorkers.length = 0;
}

process.on('exit', closeBridge);

function odataFetch(url, options, cfg) {
  const opts = options || {};
  const config = cfg || loadConfig();
  psReqSeq += 1;
  const payload = {
    id: String(psReqSeq),
    url,
    method: opts.method || 'GET',
    headers: opts.headers || { Accept: 'application/json' },
    body: opts.body || '',
    username: config.username || '',
    password: config.password || '',
    timeoutSec: opts.timeoutSec || 60
  };

  return new Promise((resolve) => {
    psQueue.push({ payload, resolve });
    dispatchPsQueue();
  });
}

async function odataGetAll(url, cfg, maxPages) {
  const limit = typeof maxPages === 'number' && maxPages > 0 ? maxPages : 30;
  const all = [];
  let next = url;
  let pages = 0;
  while (next && pages < limit) {
    const res = await odataFetch(next, { method: 'GET', headers: { Accept: 'application/json' } }, cfg);
    if (!res.ok) {
      const err = new Error(`OData GET failed (${res.status} ${res.statusText}): ${String(res.body).slice(0, 400)}`);
      err.status = res.status;
      err.authHeader = res.authHeader;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(String(res.body).replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error(`Invalid JSON from OData: ${String(res.body).slice(0, 200)}`);
    }
    if (Array.isArray(parsed.value)) all.push(...parsed.value);
    next = parsed['@odata.nextLink'] || parsed['odata.nextLink'] || null;
    pages += 1;
  }
  return all;
}

function parseMetadata(xml) {
  const entitySets = {};
  const entityTypes = {};
  const setRe = /<EntitySet\s+Name="([^"]+)"\s+EntityType="([^"]+)"/g;
  let m;
  while ((m = setRe.exec(xml))) {
    const typeName = m[2].split('.').pop();
    entitySets[m[1]] = typeName;
  }
  const typeRe = /<EntityType\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  while ((m = typeRe.exec(xml))) {
    const name = m[1];
    const body = m[2];
    const props = [];
    const propRe = /<Property\s+Name="([^"]+)"[^>]*Type="([^"]+)"/g;
    let pm;
    while ((pm = propRe.exec(body))) {
      props.push({ name: pm[1], type: pm[2] });
    }
    entityTypes[name] = props;
  }
  return { entitySets, entityTypes };
}

function pickField(props, candidates) {
  if (!props || !props.length) return '';
  const names = props.map(p => p.name);
  for (const cand of candidates) {
    if (!cand) continue;
    const exact = names.find(n => n === cand);
    if (exact) return exact;
  }
  for (const cand of candidates) {
    if (!cand) continue;
    const lower = cand.toLowerCase();
    const ci = names.find(n => n.toLowerCase() === lower);
    if (ci) return ci;
  }
  return '';
}

function pickFieldByRegex(props, regex) {
  if (!props) return '';
  const found = props.find(p => regex.test(p.name));
  return found ? found.name : '';
}

function scoreSet(setName, typeName, props, keywords) {
  let score = 0;
  const lowerSet = setName.toLowerCase();
  const lowerType = typeName.toLowerCase();
  for (const kw of keywords) {
    if (lowerSet.includes(kw)) score += 3;
    if (lowerType.includes(kw)) score += 2;
  }
  return score;
}

const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;
const schemaCache = new Map();
const schemaInFlight = new Map();

function clearSchemaCache() {
  schemaCache.clear();
}

async function discoverSchema(cfg) {
  const config = cfg || loadConfig();
  const cacheKey = JSON.stringify({
    baseUrl: config.baseUrl || '',
    company: config.company || '',
    entityOverrides: config.entityOverrides || {},
    fieldOverrides: config.fieldOverrides || {}
  });
  const cached = schemaCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SCHEMA_CACHE_TTL_MS) {
    return cached.schema;
  }
  if (schemaInFlight.has(cacheKey)) {
    return schemaInFlight.get(cacheKey);
  }

  const promise = (async () => {
    const companyUrl = buildCompanyUrl(config);
    const metaUrl = `${String(config.baseUrl).replace(/\/+$/, '')}/$metadata`;

    const metaRes = await odataFetch(metaUrl, { method: 'GET', headers: { Accept: 'application/xml' } }, config);
    if (!metaRes.ok) {
      throw new Error(`Failed to fetch $metadata (${metaRes.status} ${metaRes.statusText}): ${String(metaRes.body).slice(0, 300)}`);
    }
    const schema = buildSchemaFromMetadata(metaRes.body, companyUrl, config);
    schemaCache.set(cacheKey, { ts: Date.now(), schema });
    return schema;
  })();

  schemaInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    schemaInFlight.delete(cacheKey);
  }
}

function buildSchemaFromMetadata(xmlBody, companyUrl, config) {
  const { entitySets, entityTypes } = parseMetadata(xmlBody);

  const setNames = Object.keys(entitySets);
  const propsFor = (setName) => entityTypes[entitySets[setName]] || [];

  const overrides = config.entityOverrides || {};
  const fieldOverrides = config.fieldOverrides || {};

  function chooseSet(overrideName, keywords, requiredFields) {
    if (overrideName && entitySets[overrideName]) return overrideName;
    const required = Array.isArray(requiredFields) ? requiredFields : [requiredFields];
    const preferred = Array.isArray(keywords) ? keywords : [keywords];
    const satisfiesRequired = (name) => {
      const props = propsFor(name);
      const propNames = props.map(p => p.name.toLowerCase());
      return required.some(rf => rf && propNames.includes(String(rf).toLowerCase()));
    };
    for (const kw of preferred) {
      const target = String(kw || '').toLowerCase();
      if (!target) continue;
      for (const name of setNames) {
        if (name.toLowerCase() === target && satisfiesRequired(name)) {
          return name;
        }
      }
    }
    let best = null;
    let bestScore = -1;
    for (const name of setNames) {
      const props = propsFor(name);
      const propNames = props.map(p => p.name.toLowerCase());
      const hasRequired = required.some(rf => rf && propNames.includes(String(rf).toLowerCase()));
      if (!hasRequired) continue;
      let s = scoreSet(name, entitySets[name], props, preferred);
      const lowerName = name.toLowerCase();
      for (let i = 0; i < preferred.length; i += 1) {
        const kw = String(preferred[i] || '').toLowerCase();
        if (!kw) continue;
        if (lowerName === kw) s += 30;
        else if (lowerName.includes(kw)) s += 5;
      }
      if (s > bestScore) {
        bestScore = s;
        best = name;
      }
    }
    return best;
  }

  const customersSet = chooseSet(
    overrides.customers,
    ['workflowcustomers', 'postedcustomer', 'customer'],
    ['No', 'number']
  );
  const invoicesSet = chooseSet(
    overrides.invoices,
    ['workflowpostedsalesinvoicecard', 'workflowpostedsalesinvoices', 'posted_sales_invoice', 'sales_invoice_header', 'salesinvoices', 'salesdocuments', 'salesinvoice', 'invoice', 'postedinvoice'],
    ['No', 'number']
  );
  const invoiceLinesSet = chooseSet(
    overrides.invoiceLines,
    ['workflowpostedsalesinvoicecardsalesinvlines', 'workflowpostedsalesinvoicelines', 'posted_sales_invoice_line', 'sales_invoice_line', 'salesinvoicelines', 'salesdocumentlines', 'salesinvoiceline', 'invoiceline', 'salesline'],
    ['Document_No', 'documentNumber']
  );
  const discounts7004Set = chooseSet(
    overrides.discounts7004,
    ['workflowsaleslinediscounts', 'saleslinediscount', 'linediscount'],
    ['Sales_Code']
  );
  const itemsSet = chooseSet(
    overrides.items,
    ['austraitem', 'workflowitems', 'itemcard', 'item'],
    ['No', 'number']
  );

  const customersProps = customersSet ? propsFor(customersSet) : [];
  const invoicesProps = invoicesSet ? propsFor(invoicesSet) : [];
  const invoiceLinesProps = invoiceLinesSet ? propsFor(invoiceLinesSet) : [];
  const discountsProps = discounts7004Set ? propsFor(discounts7004Set) : [];
  const itemsProps = itemsSet ? propsFor(itemsSet) : [];

  const relatedRegex = /^Linked_Cust_No$|linked.*cust.*no|saist.*klient|related.*cust|partner.*cust|sub.*cust|meistar|secondary.*cust/i;

  const customers = {
    entitySet: customersSet || '',
    fields: {
      no: pickField(customersProps, ['No', 'number']),
      name: pickField(customersProps, ['Name', 'displayName']),
      salespersonCode: pickField(customersProps, ['Salesperson_Code', 'salespersonCode'])
    }
  };

  const invoices = {
    entitySet: invoicesSet || '',
    fields: {
      no: pickField(invoicesProps, ['No', 'number']),
      sellToCustomerNo: pickField(invoicesProps, ['Sell_to_Customer_No', 'sellToCustomerNumber', 'customerNumber']),
      sellToCustomerName: pickField(invoicesProps, ['Sell_to_Customer_Name', 'customerName']),
      relatedCustomerNo: fieldOverrides.relatedCustomerNo && invoicesProps.some(p => p.name === fieldOverrides.relatedCustomerNo)
        ? fieldOverrides.relatedCustomerNo
        : (pickField(invoicesProps, ['Linked_Cust_No', 'Related_Customer_No']) || pickFieldByRegex(invoicesProps, relatedRegex)),
      relatedCustomerName: pickField(invoicesProps, ['Linked_Cust_Name', 'Related_Customer_Name'])
        || pickFieldByRegex(invoicesProps, /linked.*cust.*name|saist.*klient.*name|related.*cust.*name|partner.*cust.*name|sub.*cust.*name|meistar.*name|secondary.*cust.*name/i),
      postingDate: pickField(invoicesProps, ['Posting_Date', 'postingDate', 'Document_Date', 'documentDate']),
      salespersonCode: pickField(invoicesProps, ['Salesperson_Code', 'salespersonCode'])
    }
  };

  const invoiceLines = {
    entitySet: invoiceLinesSet || '',
    fields: {
      documentNo: pickField(invoiceLinesProps, ['Document_No', 'documentNumber']),
      lineNo: pickField(invoiceLinesProps, ['Line_No', 'lineNumber']),
      type: pickField(invoiceLinesProps, ['Type', 'lineType']),
      no: pickField(invoiceLinesProps, ['No', 'number', 'Item_No']),
      description: pickField(invoiceLinesProps, ['Description', 'description']),
      unitOfMeasure: pickField(invoiceLinesProps, ['Unit_of_Measure_Code', 'unitOfMeasure', 'unitOfMeasureCode']),
      quantity: pickField(invoiceLinesProps, ['Quantity', 'quantity']),
      unitPrice: pickField(invoiceLinesProps, ['Unit_Price', 'unitPrice']),
      lineDiscountPercent: pickField(invoiceLinesProps, ['Line_Discount_Percent', 'lineDiscountPercent', 'Line_Discount_']),
      lineAmount: pickField(invoiceLinesProps, ['Line_Amount', 'amountExcludingTax', 'Amount']),
      groupCode: fieldOverrides.groupCode && invoiceLinesProps.some(p => p.name === fieldOverrides.groupCode)
        ? fieldOverrides.groupCode
        : pickField(invoiceLinesProps, ['ShortcutDimCode_x005B_6_x005D_', 'Shortcut_Dimension_6_Code', 'ShortcutDimCode6', 'shortcutDimension6Code', 'Item_Disc_Group']),
      sellToCustomerNo: pickField(invoiceLinesProps, ['Sell_to_Customer_No', 'sellToCustomerNumber', 'customerNumber']),
      relatedCustomerNo: pickFieldByRegex(invoiceLinesProps, relatedRegex),
      postingDate: pickField(invoiceLinesProps, ['Posting_Date', 'postingDate', 'Document_Date', 'documentDate'])
    }
  };

  const discounts7004 = {
    entitySet: discounts7004Set || '',
    fields: {
      salesType: pickField(discountsProps, ['Sales_Type']),
      salesCode: pickField(discountsProps, ['Sales_Code']),
      type: pickField(discountsProps, ['Type']),
      code: pickField(discountsProps, ['Code']),
      uom: pickField(discountsProps, ['Unit_of_Measure_Code']),
      minQty: pickField(discountsProps, ['Minimum_Quantity']),
      discount: pickField(discountsProps, ['Line_Discount_Percent', 'Line_Discount_']),
      startDate: pickField(discountsProps, ['Starting_Date']),
      endDate: pickField(discountsProps, ['Ending_Date'])
    }
  };

  const items = {
    entitySet: itemsSet || '',
    fields: {
      no: pickField(itemsProps, ['No', 'number']),
      description: pickField(itemsProps, ['Description', 'displayName']),
      unitOfMeasure: pickField(itemsProps, ['baseUnitOfMeasureCode', 'Base_Unit_of_Measure', 'unitOfMeasure', 'unitOfMeasureCode']),
      itemDiscGroup: pickField(itemsProps, ['Item_Disc_Group', 'itemDiscGroup'])
    }
  };

  return {
    companyUrl,
    entitySets,
    entityTypes,
    customers,
    invoices,
    invoiceLines,
    discounts7004,
    items
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  getPublicConfig,
  odataFetch,
  odataGetAll,
  discoverSchema,
  clearSchemaCache,
  closeBridge,
  buildCompanyUrl
};
