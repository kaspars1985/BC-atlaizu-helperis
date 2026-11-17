'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const assert = require('assert');

const odataBridge = require('./odata-bridge.js');
const odataClient = require('./odata-client.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = process.env.PORT || 3456;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  try {
    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(res, 200, odataClient.getPublicConfig());
    }

    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      const saved = odataClient.saveConfig(body || {});
      return sendJson(res, 200, { ok: true, config: odataClient.getPublicConfig(saved) });
    }

    if (pathname === '/api/schema' && method === 'GET') {
      const schema = await odataClient.discoverSchema();
      return sendJson(res, 200, schema);
    }

    if (pathname === '/api/customers' && method === 'GET') {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const customers = await odataClient.getCustomers(parsedUrl.searchParams.get('salespersonCode') || '');
      return sendJson(res, 200, { customers });
    }

    if (pathname === '/api/audit' && method === 'POST') {
      const body = await readBody(req);
      const result = await odataClient.auditCustomerInvoices(body || {});
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/import-7004-cache' && method === 'POST') {
      const body = await readBody(req);
      const result = odataClient.importCachedDiscounts7004(body.customerNo, body.data);
      return sendJson(res, 200, { ok: true, customerNo: result.customerNo, count: result.count });
    }

    if (pathname === '/api/apply-7004' && method === 'POST') {
      const body = await readBody(req);
      const result = await odataClient.applyDiscountsTo7004(body.customerNo, body.rules);
      return sendJson(res, 200, {
        ok: true,
        customerNo: result.customerNo,
        count: result.count,
        createdCodes: result.createdCodes || [],
        skippedExisting: result.skippedExisting || [],
        odataCreated: result.odataCreated,
        odataErrors: result.odataErrors || []
      });
    }

    if (pathname === '/api/lookup-manual' && method === 'POST') {
      const body = await readBody(req);
      const result = await odataClient.lookupManualEntries(body.customerNo, body.entries || []);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsed.pathname || '/';
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  });
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

function buildSampleLines() {
  return [
    { invoiceNo: 'INV-001', postingDate: '2024-01-10', sellToCustomerNo: 'C001', sellToCustomerName: 'AMF', relatedCustomerNo: '', lineNo: 1, itemCode: '173H7100', description: 'Item A', unitOfMeasure: 'PCS', groupCode: '1101', quantity: 10, unitPrice: 5, lineDiscountPercent: 20, lineAmount: 40 },
    { invoiceNo: 'INV-002', postingDate: '2024-02-10', sellToCustomerNo: 'C001', sellToCustomerName: 'AMF', relatedCustomerNo: '', lineNo: 1, itemCode: '173H7100', description: 'Item A', unitOfMeasure: 'PCS', groupCode: '1101', quantity: 5, unitPrice: 5, lineDiscountPercent: 20, lineAmount: 20 },
    { invoiceNo: 'INV-003', postingDate: '2024-03-10', sellToCustomerNo: 'C001', sellToCustomerName: 'AMF', relatedCustomerNo: '', lineNo: 1, itemCode: '71B3550', description: 'Item B', unitOfMeasure: 'PCS', groupCode: '1102', quantity: 4, unitPrice: 10, lineDiscountPercent: 25, lineAmount: 30 },
    { invoiceNo: 'INV-004', postingDate: '2024-04-10', sellToCustomerNo: 'C001', sellToCustomerName: 'AMF', relatedCustomerNo: '', lineNo: 1, itemCode: '9000100', description: 'Item C', unitOfMeasure: 'PCS', groupCode: '1103', quantity: 2, unitPrice: 20, lineDiscountPercent: 10, lineAmount: 36 },
    { invoiceNo: 'INV-005', postingDate: '2024-05-10', sellToCustomerNo: 'C001', sellToCustomerName: 'AMF', relatedCustomerNo: '', lineNo: 1, itemCode: '5550000', description: 'Item D', unitOfMeasure: 'PCS', groupCode: '9999', quantity: 1, unitPrice: 100, lineDiscountPercent: 0, lineAmount: 100 }
  ];
}

function buildExistingDiscounts() {
  return {
    itemRules: new Map([['9000100', 10]]),
    groupRules: new Map([['1102', 15]]),
    rawRules: [],
    source7004Available: true
  };
}

async function runTests() {
  // 1. Config
  const cfg = odataClient.loadConfig();
  assert.ok(cfg && typeof cfg === 'object', 'loadConfig returns object');
  const pub = odataClient.getPublicConfig();
  assert.ok(pub && typeof pub === 'object', 'getPublicConfig returns object');

  // 2. groupAuditLines
  const result = odataClient.groupAuditLines(buildSampleLines(), buildExistingDiscounts());
  const byCode = new Map(result.items.map((i) => [i.itemCode, i]));

  const a = byCode.get('173H7100');
  assert.ok(a, 'item 173H7100 present');
  assert.strictEqual(a.status, 'MISSING_IN_7004');
  assert.strictEqual(a.isManualUnsaved, true);
  assert.strictEqual(a.suggestedDiscount, 20);

  const b = byCode.get('71B3550');
  assert.ok(b, 'item 71B3550 present');
  assert.strictEqual(b.status, 'DIFFERS_FROM_7004');
  assert.strictEqual(b.isManualUnsaved, true);
  assert.strictEqual(b.suggestedDiscount, 25);

  const c = byCode.get('9000100');
  assert.ok(c, 'item 9000100 present');
  assert.strictEqual(c.status, 'MATCHES_7004');
  assert.strictEqual(c.isManualUnsaved, false);

  const d = byCode.get('5550000');
  assert.ok(d, 'item 5550000 present');
  assert.strictEqual(d.status, 'ZERO_DISCOUNT');
  assert.strictEqual(d.isManualUnsaved, false);

  // 3. Summary
  assert.strictEqual(result.summary.missingIn7004Count, 1);
  assert.strictEqual(result.summary.differsFrom7004Count, 1);
  assert.strictEqual(result.summary.manualUnsavedCount, 2);
  assert.strictEqual(result.summary.zeroDiscountItemsCount, 1);

  // 4. HTTP server
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const fetchJson = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });

  const cfgRes = await fetchJson('/api/config');
  assert.strictEqual(cfgRes.status, 200);
  assert.ok(cfgRes.body && typeof cfgRes.body === 'object');

  const rootRes = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.ok(rootRes === 200 || rootRes === 404, 'root responds');

  await new Promise((resolve) => server.close(resolve));
  odataBridge.closeBridge();

  console.log('ALL TESTS PASSED');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function openBrowser(target) {
  const cmd = process.platform === 'win32'
    ? `start "" "${target}"`
    : process.platform === 'darwin'
      ? `open "${target}"`
      : `xdg-open "${target}"`;
  exec(cmd, () => {});
}

function startServer() {
  const server = createServer();
  const host = process.env.HOST || '127.0.0.1';
  server.listen(DEFAULT_PORT, host, () => {
    const target = `http://localhost:${DEFAULT_PORT}`;
    console.log(`Server running at ${target} (bound to ${host})`);
    if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
      openBrowser(target);
    }
  });
  return server;
}

if (require.main === module) {
  if (process.argv.includes('--test')) {
    runTests().then(() => process.exit(0)).catch((err) => {
      console.error('TEST FAILED:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
  } else {
    startServer();
  }
}

module.exports = { createServer, startServer, runTests };
