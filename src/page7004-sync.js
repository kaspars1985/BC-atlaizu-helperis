/**
 * BC atlaižu pārvaldnieks - Page 7004 (Sales Line Discounts) sinhronizācija
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const {
    APP_VERSION,
    delay,
    parseLvNumber,
    escapeHtml,
    showToast,
    bcmLog,
    getAllBCDocuments
  } = BCM;

  let autoCloseTimer = null;
  let autoCloseCancelled = false;

  function getBCAppDocument() {
    const ifr = document.querySelector("iframe.designer-client-frame");
    try {
      if (ifr && ifr.contentDocument && ifr.contentDocument.body) {
        return ifr.contentDocument;
      }
    } catch (e) {}
    if (document.querySelector('[controlname="SalesCodeFilterCtrl"], table.ms-nav-grid-data-table')) {
      return document;
    }
    const docs = getAllBCDocuments();
    for (const doc of docs) {
      if (doc.querySelector('[controlname="SalesCodeFilterCtrl"], table.ms-nav-grid-data-table')) {
        return doc;
      }
    }
    return null;
  }

  function parseSalesCodeFromUrl(url) {
    if (!url) return "";
    let s = url;
    try { s = decodeURIComponent(url.replace(/\+/g, " ")); } catch (e) {}
    const m = s.match(/'Sales Code'\s+IS\s+'([^']+)'/i);
    return m ? m[1].trim().toUpperCase() : "";
  }

  function readSalesCodeFilter(doc) {
    if (!doc) return null;
    const c = doc.querySelector('[controlname="SalesCodeFilterCtrl"]');
    if (!c) return null;
    const inp = c.querySelector("input");
    if (inp && inp.value !== undefined) return (inp.value || "").trim().toUpperCase();
    const v = c.querySelector('.stringcontrol-read, [role="textbox"], .ms-nav-edit-control');
    return ((v && (v.textContent || v.getAttribute("title") || v.innerText)) || "").trim().toUpperCase();
  }

  function getGridColumnIndices(doc) {
    const indices = {
      salesType: 2, salesCode: 5, type: 6, code: 7,
      uom: 10, minQty: 11, discount: 12, startDate: 13, endDate: 14
    };
    indices._aria = {};
    indices._headerCount = 0;

    if (!doc) return indices;

    const headerCells = Array.from(doc.querySelectorAll(
      "table.ms-nav-grid-header-table th, table.ms-nav-grid-header-table td, [role='columnheader']"
    ));

    if (headerCells.length > 0) {
      indices._headerCount = headerCells.length;

      headerCells.forEach((h, idx) => {
        const cName = (h.getAttribute("controlname") || "").toLowerCase();
        const txt = (h.innerText || h.textContent || h.getAttribute("title") || h.getAttribute("aria-label") || "").toLowerCase().trim();
        const ariaVal = h.getAttribute("aria-colindex") || h.getAttribute("data-col-index");

        const assign = (field) => {
          indices[field] = idx;
          if (ariaVal) indices._aria[field] = ariaVal;
        };

        if (cName === "sales type" || txt.includes("pārdošanas tips") || txt.includes("pārd. tips") || txt.includes("sales type")) {
          assign("salesType");
        } else if (cName === "sales code" || txt.includes("pārdošanas kods") || txt.includes("pārd. kods") || txt.includes("sales code")) {
          assign("salesCode");
        } else if (cName === "type" || txt === "tips" || (txt.includes("tips") && !txt.includes("pārd") && !txt.includes("pārdošanas"))) {
          assign("type");
        } else if (cName === "code" || txt === "kods" || (txt.includes("kods") && !txt.includes("pārd") && !txt.includes("mērvienīb") && !txt.includes("valūt") && !txt.includes("variant"))) {
          assign("code");
        } else if (cName === "unit of measure code" || txt.includes("mērvienīb") || txt.includes("uom") || txt.includes("unit of measure")) {
          assign("uom");
        } else if (cName === "minimum quantity" || txt.includes("minimāl") || txt.includes("minimum quantity")) {
          assign("minQty");
        } else if (cName === "line discount %" || txt.includes("rindas atlaid") || txt.includes("atlaid") || txt.includes("line discount")) {
          assign("discount");
        } else if (cName === "starting date" || txt.includes("sākuma") || txt.includes("starting date")) {
          assign("startDate");
        } else if (cName === "ending date" || txt.includes("beigu") || txt.includes("ending date")) {
          assign("endDate");
        }
      });
    }

    return indices;
  }

  function cellText(tr, controlName, fallbackIdx, ariaColIndex, rowOffset) {
    if (!tr) return "";

    if (controlName) {
      const td = tr.querySelector(`td[controlname="${controlName}"], [controlname="${controlName}"]`);
      if (td) {
        const inp = td.querySelector("input");
        const val = ((inp ? inp.value : td.textContent) || "").replace(/\s+/g, " ").trim();
        if (val) return val;
      }
    }

    if (ariaColIndex !== undefined && ariaColIndex !== null && ariaColIndex !== "") {
      const td = tr.querySelector(`td[aria-colindex="${ariaColIndex}"], td[data-col-index="${ariaColIndex}"], [aria-colindex="${ariaColIndex}"], [data-col-index="${ariaColIndex}"]`);
      if (td) {
        const inp = td.querySelector("input");
        const val = ((inp ? inp.value : td.textContent) || "").replace(/\s+/g, " ").trim();
        if (val) return val;
      }
    }

    if (fallbackIdx !== undefined && fallbackIdx >= 0) {
      const cells = tr.querySelectorAll("td");
      const adjustedIdx = fallbackIdx + (rowOffset || 0);
      const useIdx = (adjustedIdx >= 0 && adjustedIdx < cells.length) ? adjustedIdx : fallbackIdx;
      if (useIdx >= 0 && useIdx < cells.length) {
        const cell = cells[useIdx];
        const inp = cell.querySelector("input");
        return ((inp ? inp.value : cell.textContent) || "").replace(/\s+/g, " ").trim();
      }
    }

    return "";
  }

  function setBanner(type, message, showDiagnosticsBtn = false) {
    const banner = document.getElementById("bcm-page7004-banner");
    const statusText = document.getElementById("bcm-page7004-status-text");
    const actionsBox = document.getElementById("bcm-page7004-actions");
    if (banner) banner.className = `bcm-page7004-banner ${type}`;
    if (statusText) statusText.innerHTML = message;
    if (showDiagnosticsBtn && actionsBox && !document.getElementById("bcm-copy-diag-btn")) {
      const diagBtn = document.createElement("button");
      diagBtn.className = "bcm-page7004-btn";
      diagBtn.id = "bcm-copy-diag-btn";
      diagBtn.style.background = "#475569";
      diagBtn.textContent = "📋 Kopēt diagnostiku";
      diagBtn.onclick = async () => {
        const res = await chrome.storage.local.get(["bcm_debug_log"]);
        const logData = JSON.stringify(res.bcm_debug_log || [], null, 2);
        navigator.clipboard.writeText(logData).then(() => {
          showToast("📋 Diagnostikas žurnāls nokopēts buferī!", "success");
        });
      };
      actionsBox.appendChild(diagBtn);
    }
  }

  function injectPage7004Banner() {
    if (document.getElementById("bcm-page7004-banner")) return;

    const banner = document.createElement("div");
    banner.id = "bcm-page7004-banner";
    banner.className = "bcm-page7004-banner";
    banner.innerHTML = `
      <div class="bcm-page7004-info">
        <span style="font-size: 16px;">⚡</span>
        <span id="bcm-page7004-status-text"><strong>BC atlaižu pārvaldnieks (v${APP_VERSION}):</strong> Gatavs nolasīt un saglabāt klienta rindu atlaides kešā.</span>
      </div>
      <div id="bcm-page7004-actions" style="display: flex; align-items: center; gap: 8px;">
        <button class="bcm-page7004-btn" id="bcm-scrape-7004-btn">💾 Saglabāt atlaides</button>
      </div>
    `;

    document.body.prepend(banner);

    document.getElementById("bcm-scrape-7004-btn").addEventListener("click", async () => {
      const doc = getBCAppDocument() || document;
      let target = readSalesCodeFilter(doc);
      if (!target) {
        const ifr = document.querySelector("iframe.designer-client-frame");
        target = parseSalesCodeFromUrl(ifr ? ifr.src : "") || parseSalesCodeFromUrl(window.location.href);
      }
      if (!target) {
        showToast("⚠️ Nevar noteikt klienta kodu no filtra lauka!", "warning");
        return;
      }
      bcmLog("MANUAL_SYNC_TRIGGERED", { target });
      await runManualSyncPage7004(target);
    });
  }

  async function checkPage7004AutoSync() {
    if (BCM.state.autoSyncTriggered) return;
    BCM.state.autoSyncTriggered = true;
    bcmLog("CHECK_PAGE7004_AUTO_SYNC_START");

    let session = null;
    for (let i = 0; i < 10 && !session; i++) {
      try {
        session = await chrome.runtime.sendMessage({ action: "GET_SYNC_SESSION" });
      } catch (e) {}
      if (!session || (!session.isSyncTab && i < 9)) {
        session = null;
        await delay(500);
      }
    }

    if (!session || !session.isSyncTab) {
      bcmLog("PAGE7004_OPENED_MANUALLY");
      setBanner("info", `<strong>BC atlaižu pārvaldnieks (v${APP_VERSION}):</strong> Lapa atvērta manuāli. Nofiltrējiet klientu un spiediet <em>'💾 Saglabāt atlaides'</em>.`);
      return;
    }

    bcmLog("PAGE7004_AUTO_SYNC_SESSION_CONFIRMED", { customerNo: session.customerNo });
    runAutoSyncPage7004(session.customerNo);
  }

  async function waitForFilteredPage(target, timeoutMs = 25000) {
    const t0 = Date.now();
    let stableSince = 0;
    bcmLog("WAIT_FOR_FILTERED_PAGE_START", { target, timeoutMs });

    while (Date.now() - t0 < timeoutMs) {
      const doc = getBCAppDocument();
      const f = readSalesCodeFilter(doc);
      const table = doc && doc.querySelector("table.ms-nav-grid-data-table");
      if (f === target && table) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 350) {
          bcmLog("WAIT_FOR_FILTERED_PAGE_SUCCESS", { target, elapsedMs: Date.now() - t0 });
          return { ok: true, doc, table };
        }
      } else {
        stableSince = 0;
      }
      await delay(150);
    }

    const doc = getBCAppDocument();
    const actualFilter = readSalesCodeFilter(doc);
    bcmLog("WAIT_FOR_FILTERED_PAGE_TIMEOUT", { target, actualFilter });
    return { ok: false, reason: `Filtrs='${actualFilter ?? "nav atrasts"}', gaidīts='${target}'` };
  }

  function findScroller7004(table) {
    for (let el = table.parentElement; el; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }
    return table.parentElement;
  }

  function expectedRowCount(doc) {
    if (!doc) return -1;
    const g = doc.querySelector('[role="grid"][aria-rowcount]');
    const n = g ? parseInt(g.getAttribute("aria-rowcount"), 10) : NaN;
    return isNaN(n) ? -1 : Math.max(0, n - 1);
  }

  function calibrateRowOffset(tr, colIdx) {
    if (!tr) return 0;

    const probeNames = [
      { name: "Code", field: "code" },
      { name: "Sales Code", field: "salesCode" },
      { name: "Line Discount %", field: "discount" }
    ];

    for (const probe of probeNames) {
      const td = tr.querySelector(`td[controlname="${probe.name}"], [controlname="${probe.name}"]`);
      if (td) {
        const allTds = Array.from(tr.querySelectorAll("td"));
        const actualIdx = allTds.indexOf(td);
        if (actualIdx >= 0 && typeof colIdx[probe.field] === "number") {
          return actualIdx - colIdx[probe.field];
        }
      }
    }

    const tdCount = tr.querySelectorAll("td").length;
    if (colIdx._headerCount > 0 && tdCount > colIdx._headerCount) {
      return tdCount - colIdx._headerCount;
    }

    return 0;
  }

  async function scrapeAllDiscountRows(doc, table, onProgress) {
    const scroller = findScroller7004(table);
    const byIndex = new Map();
    const colIdx = getGridColumnIndices(doc);
    bcmLog("GRID_COLUMN_INDICES", { colIdx, headerCount: colIdx._headerCount, aria: colIdx._aria });

    const collect = () => {
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((r) => {
        return r.getAttribute("role") === "row" || r.hasAttribute("aria-rowindex") || r.hasAttribute("rowkey") || (r.parentElement && r.parentElement.tagName.toLowerCase() === "tbody");
      });

      rows.forEach((tr) => {
        const rowOffset = calibrateRowOffset(tr, colIdx);
        const code = cellText(tr, "Code", colIdx.code, colIdx._aria.code, rowOffset);
        if (!code) return;

        const rowIndex = tr.getAttribute("aria-rowindex") || tr.getAttribute("rowkey") || "";
        const minQty = parseLvNumber(cellText(tr, "Minimum Quantity", colIdx.minQty, colIdx._aria.minQty, rowOffset));
        const discPercent = parseLvNumber(cellText(tr, "Line Discount %", colIdx.discount, colIdx._aria.discount, rowOffset));
        const key = rowIndex || `${code}_${minQty}_${discPercent}`;

        byIndex.set(key, {
          salesType: cellText(tr, "Sales Type", colIdx.salesType, colIdx._aria.salesType, rowOffset) || "Klients",
          salesCode: (cellText(tr, "Sales Code", colIdx.salesCode, colIdx._aria.salesCode, rowOffset) || "").toUpperCase(),
          type: cellText(tr, "Type", colIdx.type, colIdx._aria.type, rowOffset) || "Preces atlaides grupa",
          code,
          uom: cellText(tr, "Unit of Measure Code", colIdx.uom, colIdx._aria.uom, rowOffset),
          minQty,
          discountPercent: discPercent,
          startDate: cellText(tr, "Starting Date", colIdx.startDate, colIdx._aria.startDate, rowOffset),
          endDate: cellText(tr, "Ending Date", colIdx.endDate, colIdx._aria.endDate, rowOffset)
        });
      });
    };

    scroller.scrollTop = 0;
    await delay(250);
    collect();
    onProgress && onProgress(byIndex.size, expectedRowCount(doc));

    const initialExpected = expectedRowCount(doc);
    if (initialExpected > 0 && byIndex.size >= initialExpected) {
      scroller.scrollTop = 0;
      bcmLog("SCRAPE_COMPLETED_ZERO_SCROLL", { collected: byIndex.size, finalExpected: initialExpected });
      return { rows: Array.from(byIndex.values()), expected: initialExpected };
    }

    const clientH = scroller.clientHeight || 800;
    const step = Math.max(350, Math.floor(clientH * 0.85));
    let stagnant = 0;

    for (let pos = step; pos <= scroller.scrollHeight + clientH; pos += step) {
      const before = byIndex.size;
      scroller.scrollTop = pos;
      await delay(120);
      collect();

      const exp = expectedRowCount(doc);
      if (exp > 0 && byIndex.size >= exp) break;

      stagnant = byIndex.size === before ? stagnant + 1 : 0;
      if (stagnant >= 4 && pos >= scroller.scrollHeight - clientH) break;

      onProgress && onProgress(byIndex.size, exp);
    }

    const preBottomExpected = expectedRowCount(doc);
    if (!(preBottomExpected > 0 && byIndex.size >= preBottomExpected)) {
      scroller.scrollTop = scroller.scrollHeight;
      await delay(200);
      collect();
    }

    scroller.scrollTop = 0;
    const finalExpected = expectedRowCount(doc);
    bcmLog("SCRAPE_COMPLETED", { collected: byIndex.size, finalExpected });

    return { rows: Array.from(byIndex.values()), expected: finalExpected };
  }

  function validateAndConvert(rows, expected, target) {
    const foreign = rows.filter((r) => r.salesCode && r.salesCode !== target);
    if (foreign.length > 0) {
      return {
        ok: false,
        reason: `Atrastas ${foreign.length} rindas citam klientam (${foreign[0].salesCode}). Filtrs nav pareizs.`
      };
    }

    if (expected >= 0 && rows.length !== expected) {
      if (rows.length > 0 && Math.abs(rows.length - expected) <= 1) {
        bcmLog("ROW_COUNT_TOLERATED_DIFF", { got: rows.length, expected });
      } else {
        return {
          ok: false,
          reason: `Nolasītas ${rows.length} no ${expected} rindām.`
        };
      }
    }

    const rules = rows
      .filter((r) => /klients|customer/i.test(r.salesType) && r.discountPercent > 0)
      .map((r) => ({
        salesType: "Klients",
        salesCode: target,
        type: /grup|group/i.test(r.type) ? "Preces atlaides grupa" : /visas|all/i.test(r.type) ? "Visas preces" : "Prece",
        code: r.code,
        uom: r.uom,
        minQty: r.minQty,
        discountPercent: r.discountPercent,
        startDate: r.startDate,
        endDate: r.endDate
      }));

    return { ok: true, rules };
  }

  function failKeepOpen(msg) {
    bcmLog("SYNC_FAILED_KEEP_OPEN", { message: msg });
    setBanner("warning", `⚠️ <strong>BC atlaižu pārvaldnieks:</strong> ${escapeHtml(msg)}`, true);
    showToast(`⚠️ ${msg}`, "warning");

    const actionsBox = document.getElementById("bcm-page7004-actions");
    if (actionsBox && !document.getElementById("bcm-retry-sync-btn")) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "bcm-page7004-btn";
      retryBtn.id = "bcm-retry-sync-btn";
      retryBtn.textContent = "🔄 Mēģināt vēlreiz";
      retryBtn.onclick = async () => {
        retryBtn.remove();
        BCM.state.autoSyncTriggered = false;
        await checkPage7004AutoSync();
      };
      actionsBox.prepend(retryBtn);
    }
  }

  async function saveRules(target, rules, totalRowCount = 0) {
    const res = await chrome.storage.local.get(["bc_client_discounts", "bc_client_discounts_meta"]);
    const allDiscounts = res.bc_client_discounts || {};
    const allMeta = res.bc_client_discounts_meta || {};

    allDiscounts[target] = rules;
    allMeta[target] = {
      syncedAt: Date.now(),
      count: rules.length,
      rowCount: totalRowCount || rules.length
    };

    await chrome.storage.local.set({
      bc_client_discounts: allDiscounts,
      bc_client_discounts_meta: allMeta
    });
    bcmLog("RULES_SAVED", { target, count: rules.length });
  }

  async function runAutoSyncPage7004(target) {
    bcmLog("RUN_AUTO_SYNC_START", { target });
    setBanner("work", `Gaida, kamēr BC nofiltrē klientu <strong>${escapeHtml(target)}</strong>...`);

    const ready = await waitForFilteredPage(target);
    if (!ready.ok) {
      return failKeepOpen(`Lapa netika nofiltrēta klientam ${target}. ${ready.reason}`);
    }

    setBanner("work", `Nolasa klienta <strong>${escapeHtml(target)}</strong> atlaides...`);
    const { rows, expected } = await scrapeAllDiscountRows(
      ready.doc,
      ready.table,
      (got, exp) => setBanner("work", `Nolasa klienta <strong>${escapeHtml(target)}</strong> atlaides... <strong>${got}</strong>${exp > 0 ? " / " + exp : ""}`)
    );

    if (expected === 0 || rows.length === 0) {
      await saveRules(target, [], 0);
      chrome.runtime.sendMessage({ action: "FINISH_CUSTOMER_SYNC", customerNo: target, count: 0 });
      return setupAutoCloseCountdown(target, 0, 1, document.getElementById("bcm-page7004-status-text"), document.getElementById("bcm-page7004-actions"));
    }

    const v = validateAndConvert(rows, expected, target);
    if (!v.ok) return failKeepOpen(v.reason);

    await saveRules(target, v.rules, rows.length);
    chrome.runtime.sendMessage({ action: "FINISH_CUSTOMER_SYNC", customerNo: target, count: v.rules.length });
    setupAutoCloseCountdown(target, v.rules.length, 1, document.getElementById("bcm-page7004-status-text"), document.getElementById("bcm-page7004-actions"));
  }

  async function runManualSyncPage7004(target) {
    bcmLog("RUN_MANUAL_SYNC_START", { target });
    const ready = await waitForFilteredPage(target, 10000);
    if (!ready.ok) {
      showToast(`⚠️ Filtrs nesakrīt ar ${target}!`, "warning");
      return;
    }

    setBanner("work", `Nolasa klienta <strong>${escapeHtml(target)}</strong> atlaides...`);
    const { rows, expected } = await scrapeAllDiscountRows(
      ready.doc,
      ready.table,
      (got, exp) => setBanner("work", `Nolasa klienta <strong>${escapeHtml(target)}</strong> atlaides... <strong>${got}</strong>${exp > 0 ? " / " + exp : ""}`)
    );

    const v = validateAndConvert(rows, expected, target);
    if (!v.ok) {
      showToast(`⚠️ Kļūda: ${v.reason}`, "error");
      return;
    }

    await saveRules(target, v.rules, rows.length);
    setBanner("info", `✓ Klienta <strong>${escapeHtml(target)}</strong> atlaides (${v.rules.length} noteikumi) veiksmīgi saglabātas kešā! Cilne paliek atvērta.`);
    showToast(`✓ Saglabāti ${v.rules.length} atlaižu noteikumi klientam ${target}!`, "success");
  }

  function setupAutoCloseCountdown(customerNo, count, seconds, statusEl, actionsEl) {
    autoCloseCancelled = false;
    clearTimeout(autoCloseTimer);

    let remaining = seconds;

    const render = () => {
      if (autoCloseCancelled) return;
      if (statusEl) {
        statusEl.innerHTML = count > 0
          ? `✅ <strong>BC atlaižu pārvaldnieks:</strong> Saglabātas <strong>${count}</strong> atlaides klientam <strong>${escapeHtml(customerNo)}</strong>! Cilne aizvērsies pēc <strong>${remaining}s</strong>...`
          : `ℹ️ <strong>BC atlaižu pārvaldnieks:</strong> Klientam <strong>${escapeHtml(customerNo)}</strong> Business Central nav individuālu atlaižu (0%). Saglabāts. Cilne aizvērsies pēc <strong>${remaining}s</strong>...`;
      }

      if (actionsEl && !document.getElementById("bcm-cancel-close-btn")) {
        actionsEl.innerHTML = `
          <button class="bcm-page7004-btn" id="bcm-cancel-close-btn" style="background: #475569;">✕ Atcelt aizvēršanu</button>
          <button class="bcm-page7004-btn" id="bcm-close-now-btn">Aizvērt tagad</button>
        `;

        document.getElementById("bcm-cancel-close-btn").addEventListener("click", () => {
          autoCloseCancelled = true;
          clearTimeout(autoCloseTimer);
          if (statusEl) {
            statusEl.innerHTML = "✓ <strong>BC atlaižu pārvaldnieks:</strong> Dati saglabāti kešā. Cilne paliek atvērta pārskatīšanai.";
          }
          if (actionsEl) {
            actionsEl.innerHTML = '<button class="bcm-page7004-btn" id="bcm-close-now-btn">Aizvērt cilni</button>';
            document.getElementById("bcm-close-now-btn").addEventListener("click", () => {
              chrome.runtime.sendMessage({ action: "FINISH_CUSTOMER_SYNC", customerNo, count });
            });
          }
          showToast("Automātiskā aizvēršana atcelta.", "info");
        });

        document.getElementById("bcm-close-now-btn").addEventListener("click", () => {
          clearTimeout(autoCloseTimer);
          chrome.runtime.sendMessage({ action: "FINISH_CUSTOMER_SYNC", customerNo, count });
        });
      }
    };

    render();

    const interval = setInterval(() => {
      if (autoCloseCancelled) {
        clearInterval(interval);
        return;
      }
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        if (!autoCloseCancelled) {
          chrome.runtime.sendMessage({ action: "FINISH_CUSTOMER_SYNC", customerNo, count });
        }
      } else {
        render();
      }
    }, 1000);
  }

  Object.assign(BCM, {
    injectPage7004Banner,
    checkPage7004AutoSync
  });
})();
