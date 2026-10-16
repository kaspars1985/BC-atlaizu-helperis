/**
 * BC Atlaižu Helperis - Content Script
 * Manifest V3 - Integrācija ar Microsoft Dynamics 365 Business Central
 */

(function () {
  if (window.__bcmManagerLoaded) return;
  window.__bcmManagerLoaded = true;

  console.log("[BC Atlaižu Helperis] Sākotnējā ielāde Business Central lapā.");

  // --------------------------------------------------------------------------
  // Konstantas un Stāvoklis (State)
  // --------------------------------------------------------------------------
  const APP_VERSION = "1.3.9";
  let activeModal = null;
  let activeToastTimeout = null;
  let autoSyncTriggered = false;
  let bcmBusy = false; // true, kamēr notiek atlaižu ierakstīšana (aptur fona skenēšanu)

  function isExtensionContextValid() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

  function isDateString(str) {
    if (!str) return false;
    const s = String(str).trim();
    if (/^\d{1,2}[\.\/\-]\d{1,2}[\.\/\-]\d{2,4}$/.test(s)) return true;
    if (/^\d{4}[\.\/\-]\d{1,2}[\.\/\-]\d{1,2}$/.test(s)) return true;
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(s)) return true;
    return false;
  }

  function parseNum(str) {
    let s = String(str == null ? "" : str).replace(/\s/g, "").replace(/%/g, "");
    if (!s) return 0;

    const hasComma = s.indexOf(",") !== -1;
    const hasDot = s.indexOf(".") !== -1;

    if (hasComma && hasDot) {
      // The last occurring separator is the decimal separator.
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        // European: '.' thousands, ',' decimal
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        // US: ',' thousands, '.' decimal
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      // Only commas present.
      if (/,\d{3}$/.test(s) && (s.match(/,/g) || []).length > 1) {
        // e.g. '1,000,000' -> thousands separators
        s = s.replace(/,/g, "");
      } else {
        s = s.replace(",", ".");
      }
    }

    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function detectBcDecimalSeparator(bcDoc) {
    const doc = bcDoc || (typeof getBCDocument === "function" ? getBCDocument() : null);
    if (!doc) return ",";

    let cells = [];
    if (typeof findSalesLinesListPart === "function") {
      const part = findSalesLinesListPart(doc);
      if (part) {
        cells = part.querySelectorAll ? part.querySelectorAll("td, th, span, div") : [];
      }
    }
    if (!cells || !cells.length) {
      cells = doc.querySelectorAll ? doc.querySelectorAll("td, th, span, div") : [];
    }

    let sawDot = false;
    let sawComma = false;
    for (let i = 0; i < cells.length; i++) {
      const el = cells[i];
      if (el.offsetParent === null && el.getClientRects && el.getClientRects().length === 0) continue;
      const txt = (el.textContent || "").trim();
      if (!/^\d+[.,]\d{2,3}$/.test(txt)) continue;
      if (txt.indexOf(".") !== -1) sawDot = true;
      if (txt.indexOf(",") !== -1) sawComma = true;
      if (sawDot && sawComma) break;
    }

    if (sawDot && !sawComma) return ".";
    return ",";
  }

  function formatBcNumber(num, bcDoc) {
    const s = String(num);
    if (detectBcDecimalSeparator(bcDoc) === ".") {
      return s.replace(",", ".");
    }
    return s.replace(".", ",");
  }
  async function waitFor(fn, timeoutMs, stepMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {}
      await sleep(stepMs);
    }
    return null;
  }

  function getTargetDoc() {
    try {
      if (window.top && window.top.document && window.top.document.body) {
        return window.top.document;
      }
    } catch (e) {}
    return document;
  }

  // Diagnostikas žurnāla palīgfunkcija (saglabā pēdējos 200 ierakstus storage un console)
  async function bcmLog(step, data = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      version: APP_VERSION,
      step,
      url: window.location.href,
      isTop: window === window.top,
      ...data
    };
    console.log(`[BC Atlaižu Helperis v${APP_VERSION}] [${step}]`, data);
    if (!isExtensionContextValid()) return;
    try {
      const res = await chrome.storage.local.get(["bcm_debug_log"]);
      const log = res.bcm_debug_log || [];
      log.push(entry);
      if (log.length > 200) log.shift();
      await chrome.storage.local.set({ bcm_debug_log: log });
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 1. Inicializācija un ziņojumu klausītājs
  // --------------------------------------------------------------------------
  async function init() {
    bcmLog("INIT", { userAgent: navigator.userAgent });
    await cleanupLegacySeeds();
    setupMessageListener();
    setupMutationObserver();
    checkAndInjectUI();
  }

  // Iztīra vecās nepārbaudītās sēklas, kurām nav metadatu
  async function cleanupLegacySeeds() {
    try {
      const res = await chrome.storage.local.get(["bc_client_discounts", "bc_client_discounts_meta"]);
      const discounts = res.bc_client_discounts || {};
      const meta = res.bc_client_discounts_meta || {};
      let changed = false;
      for (const cust of Object.keys(discounts)) {
        if (!meta[cust]) {
          delete discounts[cust];
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage.local.set({ bc_client_discounts: discounts });
      }
    } catch (e) {}
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      // Kad Page 7004 ir veiksmīgi pabeidzis sinhronizāciju un aizvēries
      if (request.action === "CUSTOMER_SYNC_COMPLETED") {
        // Apstrādājam TIKAI top frame (K3 aizsardzība)
        if (window !== window.top) return;

        bcmLog("CUSTOMER_SYNC_COMPLETED_RECEIVED", { customerNo: request.customerNo, count: request.count });
        console.log(`[BC Atlaižu Helperis] Sinhronizācija pabeigta klientam ${request.customerNo} (${request.count} noteikumi).`);
        if (request.count > 0) {
          showToast(`✓ Klienta ${request.customerNo} atlaides (${request.count} noteikumi) veiksmīgi ielasītas!`, "success");
        } else {
          showToast(`ℹ️ Klientam ${request.customerNo} Business Central nav konfigurētu atlaižu (0 noteikumi).`, "info");
        }

        // Atveram priekšskatījuma logu ar jaunajiem datiem
        openDiscountManagerModal(request.customerNo);
        sendResponse({ success: true });
        return true;
      }

      // Galvenes informācijas pieprasījums no popup
      if (request.action === "GET_HEADER_INFO") {
        const info = extractHeaderCustomerInfo();
        sendResponse(info);
        return true;
      }

      // Pieprasījums atvērt modālo logu no pārlūka rīkjoslas popup
      if (request.action === "OPEN_DISCOUNT_MODAL") {
        openDiscountManagerModal();
        sendResponse({ success: true });
        return true;
      }
    });
  }

  // Novēro dinamiskās izmaiņas Business Central vienlapas aplikācijā (SPA)
  function setupMutationObserver() {
    let debounceTimer = null;
    const runCheck = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkAndInjectUI();
      }, 300);
    };

    const observer = new MutationObserver(runCheck);

    try {
      const topDoc = (window.top && window.top.document) ? window.top.document : document;
      observer.observe(topDoc.body || topDoc.documentElement, {
        childList: true,
        subtree: true
      });
      if (document !== topDoc && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) {
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // Papildus periodiska pārbaude (1.2s), lai droši uztvertu SPA ciļņu vai virsraksta izmaiņas
    setInterval(checkAndInjectUI, 1200);
  }

  function checkAndInjectUI() {
    if (bcmBusy) return;
    const isSalesOrderPage = detectSalesOrderPage();
    const isDiscountsPage = detectDiscountsPage();

    if (isSalesOrderPage) {
      injectSalesOrderLauncher();
    } else {
      removeSalesOrderLauncher();
    }

    if (isDiscountsPage) {
      if (window === window.top) {
        injectPage7004Banner();
        checkPage7004AutoSync();
      }
    }
  }

  // Pārbauda, vai lietotājs atrodas pārdošanas pasūtījuma logā (Page 42 / PPAS)
  function detectSalesOrderPage() {
    const topDoc = (window.top && window.top.document) ? window.top.document : document;
    const topTitle = (topDoc.title || "").toLowerCase();
    const curTitle = (document.title || "").toLowerCase();
    const combinedTitle = `${topTitle} ${curTitle}`;

    const topUrl = (window.top ? window.top.location.href : "").toLowerCase();
    const curUrl = window.location.href.toLowerCase();
    const combinedUrl = `${topUrl} ${curUrl}`;

    // 1. Pārbaude pēc URL vai virsraksta (PPAS vai Page 42 vai Pārdošanas pasūtījums)
    if (
      combinedUrl.includes("page=42") ||
      combinedTitle.includes("pārdošanas pasūtījums") ||
      combinedTitle.includes("sales order") ||
      /\bppas\d+/i.test(combinedTitle)
    ) {
      return true;
    }

    // 2. Pārbaude pa visiem pieejamajiem Business Central dokumentiem
    const docs = getAllBCDocuments();
    for (const d of docs) {
      try {
        const dTitle = (d.title || "").toLowerCase();
        if (dTitle.includes("pārdošanas pasūtījums") || dTitle.includes("sales order") || /\bppas\d+/i.test(dTitle)) {
          return true;
        }

        // Pārbaude pēc specifiskiem laukiem vai uzrakstiem pasūtījuma formā
        const hasOrderHeader = d.querySelector('[aria-label*="Pārdošanas pasūtījums"], [title*="Pārdošanas pasūtījums"], .caption[title*="Pārdošanas pasūtījums"]');
        if (hasOrderHeader) return true;

        const hasCustomerField = d.querySelector('[controlname="Sell-to Customer No."], [controlname="SellToCustomerNo"]');
        const hasLinesPart = d.querySelector('.ms-nav-listpartform, [role="grid"], table.ms-nav-grid-data-table');
        if (hasCustomerField && hasLinesPart) return true;

        // Teksta pārbaude dokumenta saturā
        const txt = (d.body ? d.body.innerText : "").slice(0, 15000).toLowerCase();
        if (
          txt.includes("pārdošanas pasūtījums") ||
          (/\bppas\d+/i.test(txt) && txt.includes("rindas")) ||
          (txt.includes("saistītā klienta") && txt.includes("rindas"))
        ) {
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  // Pārbauda, vai atvērta lapa 7004 (Sales Line Discounts / Pārdošanas rindu atlaides)
  function detectDiscountsPage() {
    const url = window.location.href.toLowerCase();
    const title = (document.title || "").toLowerCase();

    if (
      url.includes("page=7004") ||
      title.includes("sales line discounts") ||
      title.includes("pārdošanas rindu atlaides") ||
      title.includes("pārd. rindu atlaides") ||
      title.includes("pārd. rindas atlaides")
    ) {
      return true;
    }

    const ifr = document.querySelector("iframe.designer-client-frame");
    if (ifr && ifr.src && ifr.src.toLowerCase().includes("page=7004")) {
      return true;
    }

    const header = document.querySelector(".caption, [aria-label*='Sales Line Discounts'], [aria-label*='Pārdošanas rindu atlaides'], [aria-label*='Pārd. rindu atlaides'], [aria-label*='Pārd. rindas atlaides']");
    return !!header;
  }

  // --------------------------------------------------------------------------
  // 2. Peldošā poga pasūtījuma logā (Launcher Button)
  // --------------------------------------------------------------------------
  // Palīgfunkcija: atrod visus pieejamos Business Central dokumentus (top logs un visi iframe rekursīvi)
  function getAllBCDocuments() {
    const docs = [];
    const visited = new Set();

    function scan(win) {
      if (!win) return;
      try {
        if (visited.has(win)) return;
        visited.add(win);
      } catch (e) {
        return;
      }

      try {
        if (win.document && !docs.includes(win.document)) {
          docs.push(win.document);
        }
        const iframes = Array.from(win.document.querySelectorAll("iframe, frame"));
        for (const ifr of iframes) {
          try {
            const subDoc = ifr.contentDocument || ifr.contentWindow?.document;
            if (subDoc && !docs.includes(subDoc)) {
              docs.push(subDoc);
            }
            if (ifr.contentWindow) {
              scan(ifr.contentWindow);
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    scan(window);
    try {
      if (window.top && window.top !== window) {
        scan(window.top);
      }
    } catch (e) {}

    return docs.length > 0 ? docs : [document];
  }

  // Palīgfunkcija: atrod galveno Business Central dokumentu ar datiem
  function getBCDocument() {
    const docs = getAllBCDocuments();
    for (const d of docs) {
      try {
        if (
          d.querySelector('.ms-nav-listpartform') ||
          d.querySelector('.ms-nav-collapsible-part') ||
          d.querySelector('[role="grid"]') ||
          d.querySelector('.ms-nav-grid') ||
          d.querySelector('table.ms-nav-grid') ||
          d.querySelector('[role="dialog"]')
        ) {
          return d;
        }
      } catch (e) {}
    }
    for (const d of docs) {
      try {
        if (d.querySelector('table') || (d.body && d.body.innerText.length > 100)) {
          return d;
        }
      } catch (e) {}
    }
    return document;
  }

  function injectSalesOrderLauncher() {
    const targetDoc = (window.top && window.top.document) ? window.top.document : document;

    if (targetDoc.getElementById("bcm-launcher-btn") || document.getElementById("bcm-launcher-btn")) {
      updateLauncherBadge();
      return;
    }

    const btn = targetDoc.createElement("div");
    btn.id = "bcm-launcher-btn";
    btn.className = "bcm-launcher-btn";
    btn.innerHTML = `
      <span class="bcm-launcher-icon">⚡</span>
      <span>Piemērot atlaides</span>
      <span style="font-size: 10px; opacity: 0.8; margin-left: 2px;">v${APP_VERSION}</span>
      <span id="bcm-launcher-badge" class="bcm-launcher-client-badge">Meklē klientu...</span>
    `;
    btn.title = `BC Atlaižu Helperis v${APP_VERSION}`;

    btn.addEventListener("click", () => {
      if (!isExtensionContextValid()) {
        alert("Paplašinājums ir atjaunināts! Lūdzu, pārlādējiet šo lapu (nospiediet F5).");
        return;
      }
      openDiscountManagerModal();
    });

    (targetDoc.body || document.body).appendChild(btn);
    updateLauncherBadge();
  }

  function removeSalesOrderLauncher() {
    const targetDoc = (window.top && window.top.document) ? window.top.document : document;
    const existing = targetDoc.getElementById("bcm-launcher-btn") || document.getElementById("bcm-launcher-btn");
    if (existing) existing.remove();
  }

  function updateLauncherBadge() {
    const targetDoc = (window.top && window.top.document) ? window.top.document : document;
    const badge = targetDoc.getElementById("bcm-launcher-badge") || document.getElementById("bcm-launcher-badge");
    if (!badge) return;

    const headerInfo = extractHeaderCustomerInfo();
    if (headerInfo && headerInfo.relatedCustomerNo) {
      badge.textContent = `${headerInfo.relatedCustomerNo}${headerInfo.relatedCustomerName ? " · " + headerInfo.relatedCustomerName : ""}`;
      badge.title = `Saistītais klients: ${headerInfo.relatedCustomerNo} (${headerInfo.relatedCustomerName || "Nav nosaukuma"})`;
      badge.style.background = "rgba(0,0,0,0.25)";
    } else {
      badge.textContent = "Nav norādīts saistītais klients";
      badge.title = "Pasūtījumā nav aizpildīts lauks 'Saistītā klienta nr.'";
      badge.style.background = "rgba(220,38,38,0.4)";
    }
  }

  // --------------------------------------------------------------------------
  // 3. Pasūtījuma galvenes datu nolasīšana
  // --------------------------------------------------------------------------
  function extractHeaderCustomerInfo() {
    const info = {
      orderNo: "",
      customerNo: "",
      customerName: "",
      relatedCustomerNo: "",
      relatedCustomerName: "",
      documentDate: ""
    };

    const bcDoc = getBCDocument();
    const docs = [document];
    if (bcDoc && bcDoc !== document) docs.push(bcDoc);

    for (const d of docs) {
      const titleMatch = ((d.title || "") + " " + (document.title || "")).match(/PPAS\d+/i);
      if (titleMatch && !info.orderNo) info.orderNo = titleMatch[0].toUpperCase();

      const inputs = Array.from(d.querySelectorAll("input, div[role='textbox'], .ms-nav-edit-control, [aria-label], [title]"));

      inputs.forEach((el) => {
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();

        const nearbyLabel = getNearbyLabelText(el).toLowerCase();
        const combinedDesc = `${aria} ${title} ${name} ${placeholder} ${nearbyLabel}`;

        const val = (el.value || el.innerText || "").trim();
        if (!val) return;

        // Saistītā klienta nr.
        if (
          (combinedDesc.includes("saistīt") && combinedDesc.includes("klient") && combinedDesc.includes("nr")) ||
          combinedDesc.includes("saistītā klienta nr") ||
          combinedDesc.includes("saistītā klienta kods")
        ) {
          if (!info.relatedCustomerNo) info.relatedCustomerNo = val;
        }
        // Saistītā klienta nosaukums
        else if (
          (combinedDesc.includes("saistīt") && combinedDesc.includes("klient") && (combinedDesc.includes("nosauk") || combinedDesc.includes("name"))) &&
          !val.toLowerCase().includes("meklēt") && !val.toLowerCase().includes("pieejam")
        ) {
          if (!info.relatedCustomerName) info.relatedCustomerName = val;
        }
        // Pamatklienta numurs
        else if (
          (combinedDesc.includes("klienta nr") || combinedDesc.includes("sell-to customer no") || combinedDesc.includes("customer no")) &&
          !combinedDesc.includes("saistīt") && !combinedDesc.includes("preces")
        ) {
          if (!info.customerNo && !/klienta|customer|nr\.?$/i.test(val) && val.length <= 25 && !isInsideFactBox(el)) info.customerNo = val;
        }
        // Dokumenta datums
        else if (combinedDesc.includes("dokumenta datums") || combinedDesc.includes("document date")) {
          if (!info.documentDate) info.documentDate = val;
        }
      });

      if (!info.relatedCustomerNo) {
        const textNodes = findTextByRegexInDoc(d, /saistīt[aā]\s*klient[a-z]*\s*nr/i);
        for (const node of textNodes) {
          const parent = node.closest(".ms-nav-control-container, div, tr, td") || node.parentElement;
          if (parent) {
            const foundInput = parent.querySelector("input, .ms-nav-edit-control");
            if (foundInput && foundInput.value) {
              info.relatedCustomerNo = foundInput.value.trim();
              break;
            }
            const nextVal = parent.nextElementSibling ? parent.nextElementSibling.innerText.trim() : "";
            if (nextVal && nextVal.length <= 15) {
              info.relatedCustomerNo = nextVal;
              break;
            }
          }
        }
      }
    }

    return info;
  }

  function getNearbyLabelText(el) {
    let label = "";
    if (el.labels && el.labels.length) {
      label = Array.from(el.labels).map(l => l.innerText).join(" ");
    }
    if (!label && el.parentElement) {
      const cap = el.parentElement.querySelector(".ms-nav-label, .caption, label, .label");
      if (cap) label = cap.innerText;
    }
    if (!label && el.previousElementSibling) {
      label = el.previousElementSibling.innerText;
    }
    return (label || "").trim();
  }

  function findTextByRegexInDoc(targetDoc, regex) {
    const d = targetDoc || document;
    if (!d || typeof d.createTreeWalker !== "function" || !d.body) return [];
    try {
      const walker = d.createTreeWalker(d.body, (typeof NodeFilter !== "undefined" && NodeFilter.SHOW_TEXT) || 4);
      const matches = [];
      let node;
      while ((node = walker.nextNode())) {
        if (regex.test(node.nodeValue)) {
          matches.push(node.parentElement);
        }
      }
      return matches;
    } catch (e) {
      return [];
    }
  }

  function findTextByRegex(regex) {
    return findTextByRegexInDoc(document, regex);
  }

  // --------------------------------------------------------------------------
  // Palīgfunkcijas: Šūnu iezīmēšana un precīzā atrašana
  // --------------------------------------------------------------------------
  function ensureHighlightStyles(doc) {
    if (!doc) return;
    try {
      if (doc.getElementById("bcm-injected-highlight-style")) return;
      const style = doc.createElement("style");
      style.id = "bcm-injected-highlight-style";
      style.textContent = `
        .bcm-highlight-cell {
          outline: 4px solid #ff5501 !important;
          outline-offset: -2px !important;
          background-color: rgba(255, 85, 1, 0.45) !important;
          box-shadow: 0 0 24px rgba(255, 85, 1, 0.95) !important;
          animation: bcm-pulse-highlight 1.2s infinite alternate !important;
          position: relative !important;
          z-index: 9999 !important;
        }
        .bcm-highlight-cell * {
          background-color: transparent !important;
        }
        @keyframes bcm-pulse-highlight {
          0% {
            outline-color: #ff5501;
            background-color: rgba(255, 85, 1, 0.3);
            box-shadow: 0 0 10px rgba(255, 85, 1, 0.6);
          }
          100% {
            outline-color: #ff8844;
            background-color: rgba(255, 85, 1, 0.6);
            box-shadow: 0 0 28px rgba(255, 85, 1, 1);
          }
        }
        .bcm-paste-badge {
          position: fixed !important;
          background: #ff5501 !important;
          color: #ffffff !important;
          padding: 6px 14px !important;
          border-radius: 20px !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 13px !important;
          font-weight: 700 !important;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35), 0 0 16px rgba(255, 85, 1, 0.8) !important;
          z-index: 1000000 !important;
          pointer-events: none !important;
          transform: translate(-50%, -100%) !important;
          display: flex !important;
          align-items: center !important;
          gap: 6px !important;
          animation: bcmBadgeBounce 1s infinite alternate ease-in-out !important;
          white-space: nowrap !important;
        }
        .bcm-paste-badge::after {
          content: "" !important;
          position: absolute !important;
          bottom: -6px !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          border-width: 6px 6px 0 !important;
          border-style: solid !important;
          border-color: #ff5501 transparent transparent transparent !important;
        }
        @keyframes bcmBadgeBounce {
          0% { transform: translate(-50%, -100%) translateY(0); }
          100% { transform: translate(-50%, -100%) translateY(-6px); }
        }
      `;
      (doc.head || doc.body || doc.documentElement).appendChild(style);
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Neizdevās ievietot stilus dokumentā:", e);
    }
  }

  // Normalizē galvenes tekstu: noņem mīkstos defises, savāc atstarpes, mazie burti.
  function normHeaderCaption(el) {
    if (!el) return "";
    const raw = (el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "");
    return String(raw)
      .replace(/\u00AD/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Vai elements atrodas FactBox / papildu informācijas panelī
  function isInsideFactBox(el) {
    if (!el || !el.closest) return false;
    if (el.closest('.ms-nav-factboxArea, .factbox-area, [class*="factbox"], [class*="FactBox"], [class*="Factbox"], aside, [role="complementary"]')) return true;
    let p = el;
    while (p && p !== p.ownerDocument?.body) {
      const cls = ((p.className && typeof p.className === "string" ? p.className : "") + " " + (p.getAttribute?.("aria-label") || "")).toLowerCase();
      if (cls.includes("factbox") || cls.includes("pielikumi") || cls.includes("detalizēta informācija")) return true;
      p = p.parentElement;
    }
    return false;
  }

  // Atrod pasūtījuma rindu saraksta daļu (listpart), izslēdzot FactBox.
  function findSalesLinesListPart(bcDoc) {
    const docs = [];
    if (bcDoc) docs.push(bcDoc);
    try {
      const all = (typeof getAllBCDocuments === "function") ? getAllBCDocuments() : [];
      for (const d of all) if (d && d !== bcDoc) docs.push(d);
    } catch (e) { /* ignorējam */ }

    const selector = '.ms-nav-listpartform, .ms-nav-collapsible-part, .hosting-list, div[class*="listpartform"]';
    const candidates = [];
    const seen = new Set();
    for (const d of docs) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll(selector)); } catch (e) { nodes = []; }
      for (const n of nodes) {
        if (seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
    }

    // Filtrējam ārā FactBox un "faila paplašinājums" blokus
    const filtered = candidates.filter(c => {
      if (isInsideFactBox(c)) return false;
      const headerText = normHeaderCaption(c);
      if (headerText.includes("faila paplašinājums")) return false;
      return true;
    });

    // Vērtējam kandidātus
    let best = null;
    let bestScore = 0;
    for (const c of filtered) {
      let score = 0;

      // +50 par raksturīgiem controlname
      if (c.querySelector('[controlname="No."], [controlname="Line Discount %"], [controlname="Quantity"], [controlname="ShortcutDimCode6"]')) {
        score += 50;
      }

      // +35 par galvenes kolonnu tekstiem
      try {
        const headerCells = Array.from(c.querySelectorAll('th, [role="columnheader"]'));
        const headerText = headerCells.map(h => normHeaderCaption(h)).join(" ");
        const hasCode = /\bnr\.?\b|\bno\.?\b|artikuls/i.test(headerText);
        const hasOther = /apraksts|description|daudzums|quantity|rind.*atlaid|line\s*disc|vienības\s*cena/i.test(headerText);
        if (hasCode && hasOther) score += 35;
      } catch (e) { /* ignorējam */ }

      // +20 par 'rindas' / 'lines' tekstu vai tuvējo parakstu
      try {
        const ownText = normHeaderCaption(c);
        let nearby = "";
        const parent = c.parentElement;
        if (parent) {
          const cap = parent.querySelector('h1, h2, h3, h4, .ms-nav-caption, [class*="caption"]');
          if (cap) nearby = normHeaderCaption(cap);
        }
        if (ownText.includes("rindas") || ownText.includes("lines") || nearby.includes("rindas") || nearby.includes("lines")) {
          score += 20;
        }
      } catch (e) { /* ignorējam */ }

      // +10 par tabulas/grid klātbūtni
      if (c.querySelector('table.ms-nav-grid-data-table, [role="grid"]')) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best && bestScore > 0) return best;

    // Rezerves variants: meklējam grid/tabulu ārpus FactBox ar 'nr.' un 'apraksts'/'daudzums'
    for (const d of docs) {
      let grids = [];
      try {
        grids = Array.from(d.querySelectorAll('[role="grid"], table.ms-nav-grid-data-table, table'));
      } catch (e) { grids = []; }
      for (const g of grids) {
        if (isInsideFactBox(g)) continue;
        const txt = normHeaderCaption(g);
        if (txt.includes("faila paplašinājums")) continue;
        const hasNr = /\bnr\.?\b|\bno\.?\b|artikuls/i.test(txt);
        const hasDesc = /apraksts|daudzums/i.test(txt);
        if (hasNr && hasDesc) return g;
      }
    }

    return null;
  }

  // Atrod precīzo 'Rindas atlaides %' šūnu datu rindā. Nekad neminam — ja nav droši atrasts, atgriežam null.
  function findExactDiscountCell(rowElement, bcDoc) {
    if (!rowElement) return null;
    const rowCells = Array.from(rowElement.querySelectorAll('[role="gridcell"], td, th'));
    if (rowCells.length === 0) return null;
    const discRe = /rind.*atlaid|atlaid.*%|line\s*disc/i;

    // 1. BC controlname tieši šūnai
    const byName = rowElement.querySelector('td[controlname="Line Discount %"], td[controlname="Line Discount Pct"], td[controlname="LineDiscountPct"], [controlname="Line Discount %"]');
    if (byName) return byName;

    // 2. Šūnas/input title vai aria-label
    for (const cell of rowCells) {
      const title = (cell.getAttribute("title") || cell.getAttribute("aria-label") || "");
      if (discRe.test(title)) return cell;
      const inp = cell.querySelector("input");
      if (inp) {
        const inpTitle = (inp.getAttribute("title") || inp.getAttribute("aria-label") || inp.name || "");
        if (discRe.test(inpTitle)) return cell;
      }
    }

    // 3. Galvene tajā pašā saraksta daļā
    try {
      const rowLp = rowElement.closest('.ms-nav-listpartform, .ms-nav-collapsible-part, .hosting-list, div[class*="listpartform"]');
      const listPart = (rowLp && !isInsideFactBox(rowLp) ? rowLp : null) ||
        findSalesLinesListPart(bcDoc) ||
        (rowElement.ownerDocument && findSalesLinesListPart(rowElement.ownerDocument)) ||
        findSalesLinesListPart(document);

      if (listPart) {
        const headers = Array.from(listPart.querySelectorAll('table.ms-nav-grid-header-table th, [role="columnheader"], th'))
          .filter(h => !rowElement.contains(h));
        const discHeader = headers.find(h => {
          const cName = (h.getAttribute("controlname") || "").toLowerCase();
          const caption = normHeaderCaption(h);
          return cName.includes("discount") || discRe.test(caption);
        });
        if (discHeader) {
          // 3a. Pēc aria-colindex / data-col-index
          const colIdx = discHeader.getAttribute("aria-colindex") || discHeader.getAttribute("data-col-index");
          if (colIdx) {
            const m = rowCells.find(c => (c.getAttribute("aria-colindex") || c.getAttribute("data-col-index")) === colIdx);
            if (m) return m;
          }
          // 3b. Pēc galvenes indeksa ar dinamisku nobīdes kalibrēšanu
          const headerRow = discHeader.closest('tr, [role="row"]');
          if (headerRow) {
            const hCells = Array.from(headerRow.querySelectorAll('[role="columnheader"], th, td'));
            const hIdx = hCells.indexOf(discHeader);
            if (hIdx >= 0) {
              // Kalibrējam nobīdi, salīdzinot jebkuru rindas šūnu ar zināmu controlname pret tās galvenes indeksu
              let offset = null;
              const knownNames = ["No.", "Description", "Quantity", "Type", "Line Discount %", "Line Discount Pct", "LineDiscountPct"];
              for (const name of knownNames) {
                const hCell = hCells.find(h => (h.getAttribute("controlname") || "") === name);
                if (!hCell) continue;
                const hCellIdx = hCells.indexOf(hCell);
                const rCell = rowElement.querySelector(`[controlname="${name}"]`);
                if (!rCell) continue;
                const rCellIdx = rowCells.indexOf(rCell);
                if (rCellIdx >= 0 && hCellIdx >= 0) {
                  offset = rCellIdx - hCellIdx;
                  break;
                }
              }
              if (offset === null) offset = Math.max(0, rowCells.length - hCells.length);
              const idx = hIdx + offset;
              if (idx >= 0 && idx < rowCells.length) return rowCells[idx];
            }
          }
        }
      }
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Galvenes saskaņošanas kļūda:", e);
    }

    bcmLog("CELL_NOT_FOUND", { cells: rowCells.length });
    return null;
  }

  // Universāls un uzticams atlaižu šūnas meklētājs konkrētai rindai
  function getDiscountCellForRow(row, line, bcDoc) {
    if (!row) return null;

    // 1. Tiešais BC controlname
    const byName = row.querySelector('td[controlname="Line Discount %"], td[controlname="Line Discount Pct"], td[controlname="LineDiscountPct"], [controlname="Line Discount %"]');
    if (byName) return byName;

    // 2. Pēc nolasītā aria-colindex
    if (line && line.discountAriaColIndex) {
      const c = row.querySelector(`[aria-colindex="${line.discountAriaColIndex}"], [data-col-index="${line.discountAriaColIndex}"]`);
      if (c) return c;
    }

    // 3. Ar precīzo meklēšanu caur saraksta galveni
    const cExact = findExactDiscountCell(row, bcDoc);
    if (cExact) return cExact;

    // 4. Pēc kolonnas numura
    if (line && line.discountColIndex >= 0) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
      if (line.discountColIndex < cells.length) return cells[line.discountColIndex];
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // 4. Pasūtījuma rindu tabulas nolasīšana (Lines Grid Parser)
  // --------------------------------------------------------------------------
  function extractSalesLines(knownGroupCodes) {
    const lines = [];
    const bcDoc = getBCDocument();

    // Normalizējam zināmos grupu kodus
    let knownGroups = null;
    if (knownGroupCodes) {
      if (knownGroupCodes instanceof Set) {
        knownGroups = new Set(Array.from(knownGroupCodes).map(v => String(v).toUpperCase()));
      } else if (Array.isArray(knownGroupCodes)) {
        knownGroups = new Set(knownGroupCodes.map(v => String(v).toUpperCase()));
      }
    }

    // Meklējam Rindu konteineru Business Central formā (izslēdzot FactBox)
    const listPart = findSalesLinesListPart(bcDoc);

    if (!listPart) {
      console.warn("[BC Atlaižu Helperis] Neizdevās atrast pasūtījuma rindu tabulu.");
      return lines;
    }

    const allRows = Array.from(listPart.querySelectorAll('[role="row"], tr'));
    if (allRows.length === 0) {
      console.warn("[BC Atlaižu Helperis] Rindu konteinerā nav atrasta neviena rinda.");
      return lines;
    }

    // 1. Atrodam galvenes rindu un kolonnu indeksus / aria-colindex
    let headerRow = null;
    let headerCellsCount = 0;
    const colIndices = {
      type: -1,
      code: -1,
      desc: -1,
      qty: -1,
      discount: -1,
      price: -1,
      amount: -1,
      group: -1,
      uom: -1
    };
    const colAriaIndices = {
      type: null,
      code: null,
      desc: null,
      qty: null,
      discount: null,
      price: null,
      amount: null,
      group: null,
      uom: null
    };

    for (const r of allRows) {
      const headerCells = Array.from(r.querySelectorAll('[role="columnheader"], th, td, [role="gridcell"]'));
      const texts = headerCells.map(c => {
        const cName = (c.getAttribute("controlname") || "").toLowerCase().trim();
        const t = normHeaderCaption(c);
        return `${cName} ${t}`;
      });

      const hasType = texts.some(t => /type|\btips\b/i.test(t));
      const hasCode = texts.some(t => /\bno\.?\b|\bnr\.?\b|itemno|artikuls|preces\s*nr/i.test(t));

      if (hasType || hasCode) {
        headerRow = r;
        headerCellsCount = headerCells.length;
        headerCells.forEach((h, idx) => {
          const cName = (h.getAttribute("controlname") || "").toLowerCase().trim();
          const caption = normHeaderCaption(h);
          const colIdx = h.getAttribute("aria-colindex") || h.getAttribute("data-col-index");

          if (cName === "type" || /^tips\b|^type\b/i.test(caption)) {
            colIndices.type = idx;
            if (colIdx) colAriaIndices.type = colIdx;
          } else if (cName === "no." || cName === "no" || cName === "itemno" || cName === "item no." ||
                     ((/^nr\.?$|^no\.?$|artikuls|preces\s*nr/i.test(caption)) && !/rindas|sērijas|partijas|klienta|dok/i.test(caption))) {
            colIndices.code = idx;
            if (colIdx) colAriaIndices.code = colIdx;
          } else if (cName === "description" || /^apraksts\b|^description\b/i.test(caption)) {
            colIndices.desc = idx;
            if (colIdx) colAriaIndices.desc = colIdx;
          } else if (cName === "quantity" || (/^(daudzums|quantity)\b/i.test(caption) && !/rezerv|pasūtīt/i.test(caption))) {
            if (colIndices.qty === -1) {
              colIndices.qty = idx;
              if (colIdx) colAriaIndices.qty = colIdx;
            }
          } else if (/pasūtītais\s*daudzums/i.test(caption) && colIndices.qty === -1) {
            colIndices.qty = idx;
            if (colIdx) colAriaIndices.qty = colIdx;
          } else if (cName.includes("discount") || /rind.*atlaid|atlaid.*%|line\s*disc/i.test(caption)) {
            colIndices.discount = idx;
            if (colIdx) colAriaIndices.discount = colIdx;
          } else if (cName.includes("unit price") || /vienības\s*cena|unit\s*price/i.test(caption)) {
            colIndices.price = idx;
            if (colIdx) colAriaIndices.price = colIdx;
          } else if (cName.includes("line amount") || /rindas\s*summa|line\s*amount/i.test(caption)) {
            colIndices.amount = idx;
            if (colIdx) colAriaIndices.amount = colIdx;
          } else if (/shortcutdimcode6|item\s*disc|itemdiscgroup/i.test(cName) ||
                     /apakšgrup|preces\s*atlaid|preču\s*atlaid|atlaižu\s*grup|item\s*disc|shortcutdimcode6|6\.\s*dimensij/i.test(caption)) {
            colIndices.group = idx;
            if (colIdx) colAriaIndices.group = colIdx;
          } else if (cName === "unit of measure code" || /mērvien|unit\s*of\s*measure|\buom\b/i.test(caption)) {
            colIndices.uom = idx;
            if (colIdx) colAriaIndices.uom = colIdx;
          }
        });
        break;
      }
    }

    console.log("[BC Atlaižu Helperis] Kolonnu indeksi:", colIndices, "Aria-indices:", colAriaIndices);

    // 2. Apstrādājam datu rindas (izslēdzam galveni un galvenes šūnas)
    const dataRows = allRows.filter(r => {
      if (r === headerRow) return false;
      if (r.closest('thead, table.ms-nav-grid-header-table')) return false;
      const hasHeaderCell = r.querySelector('th, [role="columnheader"]');
      if (hasHeaderCell && !r.querySelector('td[role="gridcell"]')) return false;
      return true;
    });
    let validRowCounter = 0;

    dataRows.forEach((row, rowIdx) => {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
      if (cells.length < 4) return;

      // Dinamiskā nobīde starp galveni un datu rindu
      let rowOffset = null;
      const knownNames = ["No.", "Description", "Quantity", "Type", "Line Discount %", "Line Discount Pct", "LineDiscountPct"];
      if (headerRow) {
        const hCells = Array.from(headerRow.querySelectorAll('[role="columnheader"], th, td, [role="gridcell"]'));
        for (const name of knownNames) {
          const hCell = hCells.find(h => (h.getAttribute("controlname") || "") === name);
          if (!hCell) continue;
          const hCellIdx = hCells.indexOf(hCell);
          const rCell = row.querySelector(`[controlname="${name}"]`);
          if (!rCell) continue;
          const rCellIdx = cells.indexOf(rCell);
          if (rCellIdx >= 0 && hCellIdx >= 0) {
            rowOffset = rCellIdx - hCellIdx;
            break;
          }
        }
      }
      if (rowOffset === null) rowOffset = Math.max(0, cells.length - headerCellsCount);

      const getCellVal = (idx) => {
        if (idx >= 0 && idx < cells.length) {
          const el = cells[idx];
          const inp = el.querySelector("input");
          const val = inp ? inp.value : (el.innerText || el.textContent || "");
          return (val || "").replace(/\n+/g, " ").trim();
        }
        return "";
      };

      const getCellByCol = (ariaIdx, fallbackIdx) => {
        if (ariaIdx) {
          const el = row.querySelector(`[aria-colindex="${ariaIdx}"], [data-col-index="${ariaIdx}"]`);
          if (el) return el;
        }
        const realIdx = fallbackIdx + rowOffset;
        if (fallbackIdx >= 0 && realIdx >= 0 && realIdx < cells.length) {
          return cells[realIdx];
        }
        return null;
      };

      const getVal = (cell) => {
        if (!cell) return "";
        const inp = cell.querySelector("input");
        const val = inp ? inp.value : (cell.innerText || cell.textContent || "");
        return (val || "").replace(/\n+/g, " ").trim();
      };

      const typeCell = row.querySelector('td[controlname="Type"], [controlname="Type"]') || getCellByCol(colAriaIndices.type, colIndices.type);
      const typeVal = getVal(typeCell);
      // Tipa filtrs: izlaižam tikai skaidri definētus ne-prece tipus
      if (typeVal && /^(virsraksts|komentārs|virsr\.?|konts|g\/l\s*account|resurss|resource|pamatlīdzeklis|fixed\s*asset|preces\s*papildu|charge)/i.test(typeVal)) return;
      if (typeCell && (typeCell.getAttribute("controlname") || "") === "Type" && typeVal && !/prece|item/i.test(typeVal)) return;

      // 1. Primāri: no Business Central controlname="No."
      let codeVal = "";
      const noTd = row.querySelector('td[controlname="No."], td[controlname="No"], td[controlname="ItemNo"], td[controlname="Item No."], [controlname="No."]');
      if (noTd) {
        const val = getVal(noTd);
        if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
          codeVal = val;
        }
      }

      // 2. Sekundāri: no aria-colindex kolonnai "No."
      if (!codeVal && colAriaIndices.code) {
        const ariaCell = row.querySelector(`[aria-colindex="${colAriaIndices.code}"], [data-col-index="${colAriaIndices.code}"]`);
        if (ariaCell) {
          const val = getVal(ariaCell);
          if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
            codeVal = val;
          }
        }
      }

      // 3. Terciāri: no colIndices.code (ar nobīdi), bet TIKAI ja tas nav datums
      if (!codeVal && colIndices.code >= 0) {
        const realIdx = colIndices.code + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) {
          const val = getCellVal(realIdx);
          if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
            codeVal = val;
          }
        }
      }

      // 4. Rezerves variants: meklējam šūnu, KATEGORISKI IGNORĒJOT datumus un citus laukus
      if (!codeVal) {
        for (let i = 0; i < cells.length; i++) {
          if (i === 0 || i === colIndices.type + rowOffset) continue;
          const val = getCellVal(i);
          if (!val || val.length < 2 || val.length > 30) continue;
          if (isDateString(val)) continue;
          if (/^(prece|item|resurss|konts|komentārs|pamatlīdzeklis|gab|komp|m|kg|rull|paka|pcs|set|on|off|nr\.?|tips|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) continue;
          if (/^\d+([,\.]\d+)?\s*(%|eur)?$/i.test(val)) continue;
          if (/^[0-9A-Za-z]+[0-9A-Za-z\.\-_/]*$/.test(val)) {
            codeVal = val;
            break;
          }
        }
      }

      // KATEGORISKS filtrs: tukšs artikuls vai datums nedrīkst būt rinda
      if (!codeVal || isDateString(codeVal)) return;

      let descVal = "";
      const descCell = row.querySelector('td[controlname="Description"], [controlname="Description"]') || getCellByCol(colAriaIndices.desc, colIndices.desc);
      if (descCell) {
        descVal = getVal(descCell);
      }
      if (!descVal || descVal.length < 3) {
        for (let i = 0; i < cells.length; i++) {
          const txt = getCellVal(i);
          if (txt.length > 8 && txt !== codeVal && !txt.includes("http") && !/^\d+[\.,]\d+$/.test(txt) && !isDateString(txt)) {
            descVal = txt;
            break;
          }
        }
      }

      // Daudzums
      let rawQty = "";
      const qtyCell = row.querySelector('td[controlname="Quantity"], [controlname="Quantity"]') || getCellByCol(colAriaIndices.qty, colIndices.qty);
      if (qtyCell) {
        rawQty = getVal(qtyCell);
      } else if (colIndices.qty >= 0) {
        const realIdx = colIndices.qty + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) rawQty = getCellVal(realIdx);
      }
      const qty = parseNum(rawQty || "1") || 1;

      // Šūna, kurā ierakstīt atlaidi
      let discountCell = null;
      if (colAriaIndices.discount) {
        discountCell = row.querySelector(`[aria-colindex="${colAriaIndices.discount}"], [data-col-index="${colAriaIndices.discount}"]`);
      }
      if (!discountCell) {
        discountCell = findExactDiscountCell(row, bcDoc);
      }
      if (!discountCell && colIndices.discount >= 0) {
        const realIdx = colIndices.discount + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) discountCell = cells[realIdx];
      }

      // Esošā atlaide
      let currentDiscount = 0;
      if (discountCell) {
        const inp = discountCell.querySelector("input");
        const val = (inp ? inp.value : (discountCell.innerText || discountCell.textContent || "")).trim();
        const parsed = parseNum(val);
        if (!isNaN(parsed)) currentDiscount = parsed;
      }
      if (currentDiscount === 0 && colIndices.discount >= 0) {
        const realIdx = colIndices.discount + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) {
          const rawDiscount = getCellVal(realIdx);
          currentDiscount = parseNum(rawDiscount) || 0;
        }
      }

      // Grupas kods — daudzslāņu noteikšana
      let groupCode = "";
      // (a) td ar controlname ShortcutDimCode6 vai Item Disc. Group
      const groupTd = row.querySelector('td[controlname="ShortcutDimCode6"], td[controlname="Item Disc. Group"], td[controlname="Item Disc Group"]');
      if (groupTd) {
        const inp = groupTd.querySelector("input");
        groupCode = (inp ? inp.value : groupTd.textContent).trim();
      }
      // (b) pēc aria/kolonnas indeksa
      if (!groupCode) {
        const gCell = getCellByCol(colAriaIndices.group, colIndices.group);
        if (gCell) groupCode = getVal(gCell);
      }
      // (c) viedā inferēšana
      if (!groupCode) {
        const excludeIdx = new Set();
        const addIdx = (ariaIdx, fallbackIdx) => {
          if (fallbackIdx >= 0) excludeIdx.add(fallbackIdx + rowOffset);
        };
        addIdx(colAriaIndices.type, colIndices.type);
        addIdx(colAriaIndices.code, colIndices.code);
        addIdx(colAriaIndices.desc, colIndices.desc);
        addIdx(colAriaIndices.qty, colIndices.qty);
        addIdx(colAriaIndices.uom, colIndices.uom);
        addIdx(colAriaIndices.discount, colIndices.discount);
        addIdx(colAriaIndices.price, colIndices.price);
        addIdx(colAriaIndices.amount, colIndices.amount);
        for (let i = 0; i < cells.length; i++) {
          if (excludeIdx.has(i)) continue;
          const val = getCellVal(i);
          if (!val) continue;
          if (val === codeVal) continue;
          if (isDateString(val)) continue;
          const upper = val.toUpperCase();
          if (knownGroups && knownGroups.has(upper)) {
            groupCode = val;
            break;
          }
          if (/^\d{4}(_\d+)?$/.test(val)) {
            groupCode = val;
            break;
          }
        }
      }

      // Mērvienības kods
      let lineUom = "";
      const uomTd = row.querySelector('td[controlname="Unit of Measure Code"]');
      if (uomTd) {
        const inp = uomTd.querySelector("input");
        lineUom = (inp ? inp.value : uomTd.textContent).trim();
      }
      if (!lineUom) {
        const uCell = getCellByCol(colAriaIndices.uom, colIndices.uom);
        if (uCell) lineUom = getVal(uCell);
      }

      const rowCellTexts = cells.map(c => {
        const inp = c.querySelector("input");
        const val = inp ? inp.value : (c.innerText || c.textContent || "");
        return (val || "").replace(/\n+/g, " ").trim();
      });

      validRowCounter++;
      lines.push({
        id: `line_${rowIdx}_${codeVal}`,
        rowIndex: validRowCounter,
        rowElement: row,
        gridElement: row.closest('table, [role="grid"]') || listPart,
        codeIdx: getCellVal(colIndices.code + rowOffset) === codeVal ? colIndices.code : -1,
        ariaRowIndex: row.getAttribute("aria-rowindex") || "",
        ordinal: 0,
        discountCell: discountCell,
        discountAriaColIndex: colAriaIndices.discount,
        discountColIndex: colIndices.discount >= 0 ? colIndices.discount + rowOffset : -1,
        itemCode: codeVal,
        description: descVal,
        groupCode: groupCode,
        uom: lineUom,
        qty: qty,
        rowCellTexts: rowCellTexts,
        currentDiscount: currentDiscount,
        newDiscount: currentDiscount,
        matchedReason: "Gaida aprēķinu",
        status: "idle"
      });
    });

    // Kārtas nr. starp rindām ar vienādu artikulu
    const codeCounts = {};
    lines.forEach(l => {
      const k = l.itemCode.toUpperCase();
      l.ordinal = codeCounts[k] || 0;
      codeCounts[k] = l.ordinal + 1;
    });

    console.log(`[BC Atlaižu Helperis] Veiksmīgi nolasītas ${lines.length} pasūtījuma rindas.`);

    // Metadati par pieejamajām kolonnām
    lines.listPart = listPart;
    lines.hasDiscountColumn = (colIndices.discount !== -1 || !!colAriaIndices.discount || lines.some(l => !!l.discountCell));
    lines.hasGroupColumn = (colIndices.group !== -1 || !!colAriaIndices.group || lines.some(l => !!l.groupCode));

    return lines;
  }
  // Atrod vertikāli ritināmo konteineru
  function findScroller(el) {
    if (!el) return null;
    let s = el;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const body = doc.body;
    while (s && s !== body && s !== doc.documentElement) {
      try {
        if (s.scrollHeight > s.clientHeight + 10) {
          const style = (win.getComputedStyle ? win.getComputedStyle(s) : null) || {};
          const ov = (style.overflowY || style.overflow || "");
          if (/auto|scroll|overlay/i.test(ov)) return s;
        }
      } catch (e) {}
      s = s.parentElement;
    }
    return null;
  }

  // Atrod horizontāli ritināmo konteineru (el, tā iekšienē vai vecākos)
  function findHorizontalScroller(el) {
    if (!el) return null;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const body = doc.body;

    const isH = (s) => {
      if (!s) return false;
      try {
        if (s.scrollWidth <= s.clientWidth + 10) return false;
        if (s.classList && s.classList.contains("ms-nav-scrollable")) return true;
        const style = (win.getComputedStyle ? win.getComputedStyle(s) : null) || {};
        const ov = (style.overflowX || style.overflow || "");
        return /auto|scroll|overlay/i.test(ov);
      } catch (e) {
        return false;
      }
    };

    // 1) pats elements
    if (isH(el)) return el;

    // 2) iekšējie kandidāti
    try {
      const inner = el.querySelectorAll(".ms-nav-scrollable, .scroll-source, [role=grid]");
      for (const c of inner) {
        if (isH(c)) return c;
      }
    } catch (e) {}

    // 3) vecāki
    let s = el.parentElement;
    while (s && s !== body && s !== doc.documentElement) {
      if (isH(s)) return s;
      s = s.parentElement;
    }
    return null;
  }

  // Nolasa VISAS pasūtījuma rindas, ritinot tabulu vertikāli un horizontāli
  async function extractAllSalesLines(onProgress, knownGroupCodes) {
    const first = extractSalesLines(knownGroupCodes);
    const anchor = (first[0] && first[0].gridElement) || first.listPart || findSalesLinesListPart(getBCDocument());
    const vScroller = anchor ? (findScroller(anchor) || findScroller(anchor.querySelector('[role="row"], tr') || anchor)) : null;
    const hScroller = anchor ? (findHorizontalScroller(anchor) || findHorizontalScroller(anchor.querySelector('[role="row"], tr') || anchor)) : null;
    if (!vScroller && !hScroller) return first;

    bcmBusy = true;
    const origTop = vScroller ? vScroller.scrollTop : 0;
    const origLeft = hScroller ? hScroller.scrollLeft : 0;
    const merged = new Map();
    let hasDiscountColumn = false;
    let hasGroupColumn = false;

    const keyOf = (l, occ) => l.ariaRowIndex ? `r${l.ariaRowIndex}` : `${l.itemCode}|${l.qty}|${l.rowCellTexts.join("|")}#${occ}`;

    const addSnapshot = (snap, currentScrollLeft) => {
      const occ = {};
      if (snap && snap.hasDiscountColumn) hasDiscountColumn = true;
      if (snap && snap.hasGroupColumn) hasGroupColumn = true;
      for (const l of snap) {
        if (l.discountCell || l.discountAriaColIndex || l.discountColIndex >= 0) hasDiscountColumn = true;
        if (l.groupCode) hasGroupColumn = true;

        const base = l.ariaRowIndex ? "" : `${l.itemCode}|${l.qty}`;
        occ[base] = (occ[base] || 0) + 1;
        const k = keyOf(l, occ[base]);

        if (!merged.has(k)) {
          merged.set(k, l);
          continue;
        }

        // Apvienojam datus, ja tā pati rinda redzēta vairākos horizontālos skatos
        const existing = merged.get(k);
        const fields = ["itemCode", "description", "qty", "uom", "groupCode", "discountCell", "discountAriaColIndex"];
        for (const f of fields) {
          const ev = existing[f];
          const nv = l[f];
          const missing = ev === undefined || ev === null || ev === "";
          if (missing && nv !== undefined && nv !== null && nv !== "") {
            existing[f] = nv;
          }
        }
        if ((existing.currentDiscount === 0 || existing.currentDiscount === undefined || existing.currentDiscount === null) &&
            l.currentDiscount !== undefined && l.currentDiscount !== null && l.currentDiscount !== 0) {
          existing.currentDiscount = l.currentDiscount;
        }
        if (l.discountCell) {
          existing.discountScrollLeft = currentScrollLeft;
        }

        // Apvienojam šūnu tekstus (tikai ne-tukšos)
        if (Array.isArray(l.rowCellTexts)) {
          if (!Array.isArray(existing.rowCellTexts)) existing.rowCellTexts = [];
          const seen = new Set(existing.rowCellTexts.filter(t => t));
          for (const t of l.rowCellTexts) {
            if (t && !seen.has(t)) {
              existing.rowCellTexts.push(t);
              seen.add(t);
            }
          }
        }
      }
    };


    // Papildina jau nolasītās rindas pēc aria-rowindex, ja pie horizontālā skrolla kreisā 'Nr.' kolonna ir paslēpusies
    const enrichByAriaRowAtHorizontalStep = (currentScrollLeft) => {
      try {
        const bcDoc = getBCDocument();
        const lp = first.listPart || findSalesLinesListPart(bcDoc);
        if (!lp) return;
        const headers = Array.from(lp.querySelectorAll('table.ms-nav-grid-header-table th, [role="columnheader"], th'));
        let grpAria = null;
        let discAria = null;
        for (const h of headers) {
          const cName = (h.getAttribute("controlname") || "").toLowerCase().trim();
          const cap = (h.innerText || h.getAttribute("title") || h.getAttribute("aria-label") || "").trim().toLowerCase();
          const aIdx = h.getAttribute("aria-colindex") || h.getAttribute("data-col-index");
          if (/shortcutdimcode6|item\s*disc|itemdiscgroup/i.test(cName) || /apakšgrup|preces\s*atlaid|preču\s*atlaid|atlaižu\s*grup|item\s*disc|shortcutdimcode6|6\.\s*dimensij/i.test(cap)) {
            hasGroupColumn = true;
            if (aIdx) grpAria = aIdx;
          }
          if (cName.includes("discount") || /rind[a-z]*\s*atlaid|line\s*disc/i.test(cap)) {
            hasDiscountColumn = true;
            if (aIdx) discAria = aIdx;
          }
        }
        const domRows = Array.from(lp.querySelectorAll('[role="row"][aria-rowindex], tr[aria-rowindex]'));
        for (const r of domRows) {
          const aRow = r.getAttribute("aria-rowindex");
          const existing = aRow ? merged.get("r" + aRow) : null;
          if (!existing) continue;
          const gTd = r.querySelector('td[controlname="ShortcutDimCode6"], td[controlname="Item Disc. Group"], td[controlname="Item Disc Group"]') ||
                      (grpAria ? r.querySelector(`[aria-colindex="${grpAria}"], [data-col-index="${grpAria}"]`) : null);
          if (gTd) {
            hasGroupColumn = true;
            const inp = gTd.querySelector("input");
            const gVal = (inp ? inp.value : (gTd.innerText || gTd.textContent || "")).trim();
            if (gVal && !existing.groupCode) existing.groupCode = gVal;
          }
          const dTd = findExactDiscountCell(r, bcDoc) ||
                      (discAria ? r.querySelector(`[aria-colindex="${discAria}"], [data-col-index="${discAria}"]`) : null);
          if (dTd) {
            hasDiscountColumn = true;
            existing.discountCell = dTd;
            if (discAria && !existing.discountAriaColIndex) existing.discountAriaColIndex = discAria;
            existing.discountScrollLeft = currentScrollLeft;
            const inp = dTd.querySelector("input");
            const dVal = parseFloat(((inp ? inp.value : (dTd.innerText || dTd.textContent || "")) || "").replace(",", ".").replace(/\s/g, ""));
            if (!isNaN(dVal) && dVal > 0 && !existing.currentDiscount) existing.currentDiscount = dVal;
          }
        }
      } catch (e) {}
    };

    // Horizontālā skenēšana pie esošās vertikālās pozīcijas
    const scanHorizontalAtCurrentVertical = async () => {
      if (!hScroller) return;
      if (hScroller.scrollWidth <= hScroller.clientWidth + 15) return;
      const maxLeft = hScroller.scrollWidth - hScroller.clientWidth;
      const stepSize = Math.max(200, Math.floor(hScroller.clientWidth * 0.65));
      const savedLeft = hScroller.scrollLeft;
      try {
        for (let left = 0; left <= maxLeft; left += stepSize) {
          hScroller.scrollLeft = left;
          await sleep(150);
          addSnapshot(extractSalesLines(knownGroupCodes), hScroller.scrollLeft);
          enrichByAriaRowAtHorizontalStep(hScroller.scrollLeft);
          if (typeof onProgress === "function") onProgress(merged.size);
        }
        // Pēdējais solis, ja solis nepārklāj pašu galu
        if (hScroller.scrollLeft < maxLeft) {
          hScroller.scrollLeft = maxLeft;
          await sleep(150);
          addSnapshot(extractSalesLines(knownGroupCodes), hScroller.scrollLeft);
          enrichByAriaRowAtHorizontalStep(hScroller.scrollLeft);
          if (typeof onProgress === "function") onProgress(merged.size);
        }
      } finally {
        try { hScroller.scrollLeft = savedLeft; } catch (e) {}
      }
    };

    try {
      addSnapshot(first, origLeft);

      if (vScroller) {
        vScroller.scrollTop = 0;
        await sleep(150);
        addSnapshot(extractSalesLines(knownGroupCodes), hScroller ? hScroller.scrollLeft : 0);
        await scanHorizontalAtCurrentVertical();

        for (let step = 0; step < 25; step++) {
          const prevTop = vScroller.scrollTop;
          const scrollDelta = Math.max(80, Math.floor(vScroller.clientHeight * 0.7));
          vScroller.scrollTop += scrollDelta;
          await sleep(150);

          addSnapshot(extractSalesLines(knownGroupCodes), hScroller ? hScroller.scrollLeft : 0);
          await scanHorizontalAtCurrentVertical();

          if (typeof onProgress === "function") onProgress(merged.size);

          if (vScroller.scrollTop === prevTop || vScroller.scrollTop + vScroller.clientHeight >= vScroller.scrollHeight - 2) {
            const beforeHeight = vScroller.scrollHeight;
            await sleep(200);
            if (vScroller.scrollHeight === beforeHeight) break;
          }
        }
      } else {
        // Nav vertikālā ritinātāja — skenējam tikai horizontāli
        await scanHorizontalAtCurrentVertical();
      }
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Kļūda extractAllSalesLines:", e);
    } finally {
      try { if (vScroller) vScroller.scrollTop = origTop; } catch (e) {}
      try { if (hScroller) hScroller.scrollLeft = origLeft; } catch (e) {}
      bcmBusy = false;
    }

    let all = Array.from(merged.values());
    if (all.some(l => l.ariaRowIndex)) {
      all.sort((a, b) => (parseInt(a.ariaRowIndex, 10) || 0) - (parseInt(b.ariaRowIndex, 10) || 0));
    }
    const codeCounts = {};
    all.forEach((l, i) => {
      l.rowIndex = i + 1;
      l.id = `line_${i}_${l.itemCode}`;
      const k = (l.itemCode || "").toUpperCase();
      l.ordinal = codeCounts[k] || 0;
      codeCounts[k] = l.ordinal + 1;
    });
    all.hasDiscountColumn = hasDiscountColumn;
    all.hasGroupColumn = hasGroupColumn;
    bcmLog("LINES_FULL_SCAN", { visible: first.length, total: all.length, hasDiscountColumn, hasGroupColumn });
    return all.length > 0 ? all : first;
  }
  // Nolasām kešotos klienta atlaižu datus (tikai reāli sinhronizētos)
  async function getClientRulesData(customerNo) {
    if (!customerNo) return { rules: [], isSynced: false };
    if (!isExtensionContextValid()) return { rules: [], isSynced: false };
    const normCust = customerNo.trim().toUpperCase();
    try {
      const storageData = await chrome.storage.local.get(["bc_client_discounts", "bc_client_discounts_meta"]);
      const allDiscounts = storageData.bc_client_discounts || {};
      const meta = storageData.bc_client_discounts_meta || {};

      const isSynced = (normCust in allDiscounts) || (normCust in meta);
      const rules = Array.isArray(allDiscounts[normCust]) ? allDiscounts[normCust] : [];

      return { rules, isSynced };
    } catch (e) {
      return { rules: [], isSynced: false };
    }
  }

  async function getClientRules(customerNo) {
    const data = await getClientRulesData(customerNo);
    return data.rules;
  }


  // Palīgfunkcija datuma (DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD u.c.) parsēšanai
  function parseLvDate(str) {
    if (!str) return null;
    const s = String(str).trim();

    // ISO: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
    let m = s.match(/^(\d{4})[\.\/\-](\d{1,2})[\.\/\-](\d{1,2})$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return new Date(year, month - 1, day);
    }

    // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (2-digit year -> 20YY)
    m = s.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})$/);
    if (!m) return null;

    let day = parseInt(m[1], 10);
    let month = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;

    // US MM/DD/YYYY: second part > 12 and first part <= 12 -> swap
    if (month > 12 && day <= 12) {
      const tmp = day;
      day = month;
      month = tmp;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

  // Pārbauda, vai atlaižu noteikuma datums ir aktīvs šodien
  function isRuleDateActive(rule) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (rule.startDate) {
      const s = parseLvDate(rule.startDate);
      if (s && s > today) return false;
    }
    if (rule.endDate) {
      const e = parseLvDate(rule.endDate);
      if (e && e < today) return false;
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // 5. Atlaižu saskaņošanas dzinējs (Discount Matching Engine)
  // --------------------------------------------------------------------------
  async function matchDiscountsForLines(lines, relatedCustomerNo) {
    if (!relatedCustomerNo) {
      lines.forEach(l => {
        l.newDiscount = l.currentDiscount;
        l.matchedReason = "Nav norādīts saistītais klients";
        l.status = "nodisc";
      });
      return lines;
    }

    const { rules: clientRules, isSynced } = await getClientRulesData(relatedCustomerNo);

    if (!clientRules || clientRules.length === 0) {
      lines.forEach(l => {
        l.newDiscount = l.currentDiscount;
        if (isSynced) {
          l.matchedReason = `Klientam ${relatedCustomerNo} nav individuālu atlaižu Business Central`;
        } else {
          l.matchedReason = `Klientam ${relatedCustomerNo} atlaides vēl nav kešā (nospiediet 'Ielasīt no Page 7004')`;
        }
        l.status = "nodisc";
      });
      return lines;
    }

    // Atlasām tikai šobrīd datumiski derīgos noteikumus
    const activeRules = clientRules.filter(isRuleDateActive);

    lines.forEach(line => {
      const codeUpper = (line.itemCode || "").toUpperCase().trim();
      const descUpper = (line.description || "").toUpperCase().trim();
      const groupCodeUpper = (line.groupCode || "").toUpperCase().trim();
      const lineUomUpper = (line.uom || "").toUpperCase().trim();
      const qty = line.qty;

      // Meklējam visus piemērojamos noteikumus (kandidātus)
      const candidates = [];

      for (const rule of activeRules) {
        // Daudzuma slieksnis
        if (rule.minQty && qty < rule.minQty) continue;

        // Mērvienības sakritība (ja noteikumā definēta)
        if (rule.uom && lineUomUpper && rule.uom.toUpperCase().trim() !== lineUomUpper) {
          continue;
        }

        const ruleCodeUpper = (rule.code || "").toUpperCase().trim();
        const ruleType = rule.type || "";

        // A. Tiešā preces atlaide (Prece)
        if (/prece|item/i.test(ruleType) && ruleCodeUpper === codeUpper) {
          candidates.push({
            rule,
            priority: 3,
            reason: `Preces tiešā atlaide (${rule.discountPercent}%)`
          });
          continue;
        }

        // B. Preču atlaižu grupa (Preces atlaides grupa)
        if (/grup|disc|atlai/i.test(ruleType) && ruleCodeUpper) {
          // Primāri: sakrīt ar ShortcutDimCode6
          if (groupCodeUpper && ruleCodeUpper === groupCodeUpper) {
            candidates.push({
              rule,
              priority: 2,
              reason: `Grupas "${rule.code}" atlaide (${rule.discountPercent}%)`
            });
            continue;
          }
          // Sekundāri: sakrīt ar kādu citu šūnas tekstu šajā rindā
          if (line.rowCellTexts && line.rowCellTexts.some(txt => txt.toUpperCase() === ruleCodeUpper)) {
            candidates.push({
              rule,
              priority: 2,
              reason: `Grupas "${rule.code}" atlaide (${rule.discountPercent}%)`
            });
            continue;
          }
        }

        // C. Visu preču atlaide
        if (/visas\s*preces|all\s*items/i.test(ruleType)) {
          candidates.push({
            rule,
            priority: 1,
            reason: `Klienta vispārējā atlaide (${rule.discountPercent}%)`
          });
        }
      }

      // Business Central princips: izvēlamies lielāko atlaidi (Best Line Discount)
      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          // Lielākais procents uzvar
          if (b.rule.discountPercent !== a.rule.discountPercent) {
            return b.rule.discountPercent - a.rule.discountPercent;
          }
          // Pie vienāda procenta uzvar specifiskākā (Prece > Grupa > Visas)
          return b.priority - a.priority;
        });

        const best = candidates[0];
        line.newDiscount = best.rule.discountPercent;
        line.matchedReason = best.reason;

        if (line.currentDiscount > 0 && line.currentDiscount !== line.newDiscount) {
          line.status = "overwritten";
        } else {
          line.status = "new";
        }
      } else {
        line.newDiscount = line.currentDiscount;
        line.matchedReason = "Nav definēta atlaide šai precei";
        line.status = "nodisc";
      }
    });

    return lines;
  }

  // --------------------------------------------------------------------------
  // 6. Priekšskatījuma modālais logs (Preview Modal Dialog)
  // --------------------------------------------------------------------------
  async function openDiscountManagerModal(forcedCustomerNo) {
    if (!isExtensionContextValid()) {
      showToast("Paplašinājums tika atjaunināts! Lūdzu, pārlādējiet šo lapu (nospiediet F5).", "warning");
      return;
    }
    try {
      const targetDoc = getTargetDoc();
      const existingOverlays = Array.from(document.querySelectorAll(".bcm-modal-overlay")).concat(
        targetDoc !== document ? Array.from(targetDoc.querySelectorAll(".bcm-modal-overlay")) : []
      );
      existingOverlays.forEach(o => o.remove());
      activeModal = null;

      const headerInfo = extractHeaderCustomerInfo();
      if (forcedCustomerNo) {
        headerInfo.relatedCustomerNo = forcedCustomerNo.trim().toUpperCase();
      }

      // Ja saistītais klients nav atrasts galvenē, mēģinām iegūt pēdējo izmantoto
      try {
        if (!headerInfo.relatedCustomerNo) {
          const storageLast = await chrome.storage.local.get(["bcm_last_customer"]);
          if (storageLast.bcm_last_customer) {
            headerInfo.relatedCustomerNo = storageLast.bcm_last_customer;
          }
        } else {
          chrome.storage.local.set({ bcm_last_customer: headerInfo.relatedCustomerNo });
        }
      } catch (e) {}

      // 1. Vispirms nolasām klienta noteikumus, lai zinātu grupu kodus
      const { rules: clientRules, isSynced } = await getClientRulesData(headerInfo.relatedCustomerNo);
      const knownGroupCodes = new Set((clientRules || []).filter(r => /grup|disc|atlai/i.test(r.type || '') && r.code).map(r => String(r.code).trim().toUpperCase()));

      // 2. ZIBENĪGI nolasām uzreiz redzamās rindas, lai modālis atvērtos uzreiz (<10ms)
      const rawLines = extractSalesLines(knownGroupCodes);

      let lines = await matchDiscountsForLines(rawLines, headerInfo.relatedCustomerNo);
      let updateInfo = null;
      try {
        const stored = await chrome.storage.local.get(["bcm_update_info"]);
        updateInfo = stored.bcm_update_info;
      } catch (e) {}

      const renderTableRows = (currentLines) => {
        if (!currentLines || currentLines.length === 0) {
          return `
            <tr>
              <td colspan="8" style="text-align: center; padding: 40px 20px; color: #64748b;">
                <div style="font-size: 26px; margin-bottom: 8px;">📋</div>
                <div style="font-weight: 600; font-size: 14px; margin-bottom: 6px; color: #1e293b;">Pasūtījumā netika atrastas aktīvas preču rindas</div>
                <div style="font-size: 12px; margin-bottom: 16px;">Pārliecinieties, ka pasūtījuma lapa ir ielādējusies un sadaļā "Rindas" ir ievadītas preces.</div>
                <button class="bcm-btn bcm-btn-secondary" id="bcm-reload-lines-btn" style="display: inline-flex; width: auto; margin: 0 auto; padding: 6px 16px;">
                  🔄 Pārlasīt pasūtījuma rindas
                </button>
              </td>
            </tr>
          `;
        }
        return currentLines.map((l, idx) => `
          <tr data-line-id="${l.id}">
            <td class="bcm-row-num">${l.rowIndex}</td>
            <td class="bcm-item-code">${escapeHtml(l.itemCode)}</td>
            <td class="bcm-item-desc" title="${escapeHtml(l.description)}">${escapeHtml(l.description)}</td>
            <td style="text-align: center; font-weight: 600;">${l.qty}</td>
            <td style="text-align: center; color: var(--bcm-text-muted);">${l.currentDiscount > 0 ? l.currentDiscount + '%' : '0%'}</td>
            <td style="text-align: center;">
              <input 
                type="number" 
                step="0.5" 
                min="0" 
                max="100" 
                class="bcm-discount-input ${l.status === 'new' ? 'highlight-new' : l.status === 'overwritten' ? 'highlight-warn' : ''}" 
                value="${l.newDiscount}"
                data-idx="${idx}"
              />
            </td>
            <td>
              <span style="font-size: 12px; color: #4b5563;">${escapeHtml(l.matchedReason)}</span>
            </td>
            <td>
              ${l.status === 'new' ? '<span class="bcm-badge item-match">✓ Jauna atlaide</span>' :
                l.status === 'overwritten' ? '<span class="bcm-badge warn-overwrite">⚠️ Pārrakstīs</span>' :
                '<span class="bcm-badge no-match">— Standarta</span>'}
            </td>
          </tr>
        `).join("");
      };

      const totalLines = lines.length;
      const withDiscount = lines.filter(l => l.newDiscount > 0).length;
      const overwritten = lines.filter(l => l.status === "overwritten").length;
      const noDiscount = lines.filter(l => l.status === "nodisc").length;

      const modal = targetDoc.createElement("div");
      modal.className = "bcm-modal-overlay";
      modal.innerHTML = `
        <div class="bcm-modal-card">
          <!-- Galvene -->
          <div class="bcm-modal-header">
            <div class="bcm-modal-title-box">
              <div class="bcm-logo-icon">⚡</div>
              <div>
                <h3 class="bcm-modal-title" style="display: flex; align-items: center; gap: 8px;">
                  <span>BC Atlaižu Helperis <small style="font-weight:600;opacity:0.75;">v${APP_VERSION}</small> · Atlaižu Pārvaldnieks</span>
                  ${updateInfo && updateInfo.hasUpdate ? `<a href="${updateInfo.releaseUrl}" target="_blank" style="text-decoration: none; font-size: 11px; background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; padding: 2px 7px; border-radius: 12px; font-weight: 600;">🚀 Pieejama v${escapeHtml(updateInfo.latestVersion)}</a>` : ""}
                </h3>
                <div class="bcm-modal-subtitle">Pasūtījums: ${headerInfo.orderNo || "Pārdošanas pasūtījums"} · AM Furnitūra</div>
              </div>
            </div>
            <button class="bcm-close-btn" id="bcm-modal-close" title="Aizvērt logu">✕</button>
          </div>

          <!-- Klienta informācijas josla -->
          <div class="bcm-client-banner">
            <div class="bcm-client-meta">
              <div class="bcm-meta-pill" style="display: flex; align-items: center; gap: 6px;">
                <span class="bcm-meta-label">Saistītais klients:</span>
                <input 
                  type="text" 
                  id="bcm-client-no-input" 
                  value="${escapeHtml(headerInfo.relatedCustomerNo || '')}" 
                  placeholder="Piem. K318220" 
                  style="padding: 2px 7px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: 700; width: 100px; font-size: 12px; text-transform: uppercase;"
                  title="Ievadiet vai mainiet saistītā klienta kodu"
                />
                <button class="bcm-btn bcm-btn-secondary" id="bcm-apply-client-btn" style="padding: 2px 8px; font-size: 11px; margin: 0; width: auto;" title="Pārrēķināt atlaides ar šo klientu">Pielietot</button>
                ${headerInfo.relatedCustomerName ? `<span class="bcm-meta-val">(${headerInfo.relatedCustomerName})</span>` : ""}
              </div>
              ${headerInfo.customerNo ? `
                <div class="bcm-meta-pill">
                  <span class="bcm-meta-label">Rēķina klients:</span>
                  <span class="bcm-meta-val">${headerInfo.customerNo}</span>
                </div>
              ` : ""}
              <div class="bcm-meta-pill">
                <span class="bcm-meta-label">Kešotie noteikumi:</span>
                <span class="bcm-meta-val ${isSynced ? '' : 'highlight'}">
                  ${isSynced ? (clientRules.length > 0 ? `${clientRules.length} atlaides` : '0 (Standarta cenas)') : 'Nav kešā'}
                </span>
              </div>
            </div>

            <div>
              <button class="bcm-btn ${isSynced ? 'bcm-btn-secondary' : 'bcm-btn-primary'}" id="bcm-refresh-discounts-btn" style="padding: 6px 14px; font-size: 12.5px; margin: 0; width: auto;" title="Atvērt Page 7004, nofiltrēt un ielasīt klienta atlaides">
                🔄 ${isSynced ? 'Atjaunot no Page 7004' : 'Ielasīt atlaides no Page 7004'}
              </button>
            </div>
          </div>

          <!-- Kopsavilkuma josla -->
          <div class="bcm-summary-bar">
            <span class="bcm-chip total">Kopā rindas: ${totalLines}</span>
            <span class="bcm-chip matched">Ar atlaidi: ${withDiscount}</span>
            ${overwritten > 0 ? `<span class="bcm-chip overwritten">⚠️ Mainītas esošās: ${overwritten}</span>` : ""}
            <span class="bcm-chip nodisc">Bez atlaides: ${noDiscount}</span>
            ${!isSynced && headerInfo.relatedCustomerNo ? `<span class="bcm-chip overwritten" style="margin-left: 6px;">⚠️ Atlaides vēl nav kešā. Spiediet 'Ielasīt atlaides no Page 7004'!</span>` : ""}
            ${isSynced && clientRules.length === 0 && headerInfo.relatedCustomerNo ? `<span class="bcm-chip" style="margin-left: 6px; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;">ℹ️ Klientam nav īpašu atlaižu BC (standarta 0%)</span>` : ""}
            <button class="bcm-btn bcm-btn-secondary" id="bcm-scan-all-lines-btn" style="padding: 2px 9px; font-size: 11px; margin-left: auto; width: auto; display: inline-flex; align-items: center; gap: 4px;" title="Ritina pasūtījuma rindu tabulu, lai nolasītu un pievienotu visas rindas">
              <span>🔍</span> Ielasīt visas rindas (ritināt)
            </button>
          </div>

          <!-- Brīdinājuma josla par trūkstošām kolonnām -->
          <div id='bcm-missing-col-banner' style='display: none; margin: 0 20px 10px 20px; padding: 10px 14px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; color: #92400e; font-size: 12.5px; line-height: 1.45;'></div>

          <!-- Rindu tabula -->
          <div class="bcm-table-container">
            <table class="bcm-lines-table">
              <thead>
                <tr>
                  <th style="width: 32px;">#</th>
                  <th style="width: 130px;">Artikuls</th>
                  <th>Apraksts</th>
                  <th style="width: 60px; text-align: center;">Daudzums</th>
                  <th style="width: 80px; text-align: center;">Esošā %</th>
                  <th style="width: 90px; text-align: center;">Jaunā %</th>
                  <th>Pamatojums</th>
                  <th style="width: 100px;">Statuss</th>
                </tr>
              </thead>
              <tbody id="bcm-table-body">
                ${renderTableRows(lines)}
              </tbody>
            </table>
          </div>

          <!-- Progresa josla -->
          <div class="bcm-progress-box" id="bcm-progress-box">
            <div class="bcm-progress-label">
              <span id="bcm-progress-text">Ieraksta atlaides pasūtījumā...</span>
              <span id="bcm-progress-percent">0%</span>
            </div>
            <div class="bcm-progress-track">
              <div class="bcm-progress-bar" id="bcm-progress-bar"></div>
            </div>
          </div>

          <!-- Apakšdaļa (Footer) -->
          <div class="bcm-modal-footer">
            <div>
              <button class="bcm-btn bcm-btn-secondary" id="bcm-copy-clipboard-btn" ${lines.length === 0 ? "disabled" : ""} title="Nokopēt visu atlaižu kolonnu buferī ātrai ielīmēšanai">
                📋 Kopēt kolonnu buferī
              </button>
            </div>
            <div class="bcm-footer-actions">
              <button class="bcm-btn bcm-btn-secondary" id="bcm-cancel-btn">Aizvērt</button>
              <button class="bcm-btn bcm-btn-primary" id="bcm-apply-btn" ${withDiscount === 0 ? "disabled" : ""}>
                ⚡ Automātiski ierakstīt (${withDiscount})
              </button>
            </div>
          </div>
        </div>
      `;

      (targetDoc.body || document.body).appendChild(modal);
      activeModal = modal;

      // Brīdinājumu par trūkstošām kolonnām atjaunināšana
      const updateColumnWarnings = (curLines, scanCompleted) => {
        const banner = modal.querySelector("#bcm-missing-col-banner");
        if (!banner) return;
        const hasGroupRules = (clientRules || []).some(r => /grup|disc|atlai/i.test(r.type || ''));
        const hasDiscCol = !!(curLines.hasDiscountColumn || curLines.some(l => !!l.discountCell));
        const hasGrpCol = !!(curLines.hasGroupColumn || curLines.some(l => !!l.groupCode));

        // Rādām tikai tad, ja ir rindas un skenēšana pabeigta
        if (!(curLines.length > 0 && scanCompleted)) {
          banner.style.display = "none";
          return;
        }

        if (!hasDiscCol) {
          banner.innerHTML = "⚠️ <strong>Pasūtījuma tabulā netika atrasta kolonna \"Rindas atlaides %\" (Line Discount %).</strong> Bez tās nevar nolasīt esošās atlaides. Lūdzu, pievienojiet to: nospiediet <strong>Settings (zobrats) ⚙️ → Personalizēt → + Lauks</strong> un atzīmējiet <em>Rindas atlaides %</em> Business Central pasūtījuma rindu skatā.";
          banner.style.display = "block";
        } else if (hasGroupRules && !hasGrpCol) {
          banner.innerHTML = "⚠️ <strong>Klientam ir preču atlaižu grupas, bet pasūtījuma rindās nav atrasta grupas koda kolonna</strong> (Apakšgrupas kods / Preces atlaides grupa / ShortcutDimCode6). Lūdzu, pievienojiet to: <strong>Settings (zobrats) ⚙️ → Personalizēt → + Lauks</strong>, lai grupu atlaides varētu sasaistīt ar rindām.";
          banner.style.display = "block";
        } else {
          banner.style.display = "none";
        }
      };

      modal.querySelector("#bcm-modal-close").addEventListener("click", closeModal);
      modal.querySelector("#bcm-cancel-btn").addEventListener("click", closeModal);

      // Saistītā klienta maiņa
      const applyClientBtn = modal.querySelector("#bcm-apply-client-btn");
      const clientInput = modal.querySelector("#bcm-client-no-input");
      if (applyClientBtn && clientInput) {
        const applyNewClient = () => {
          const val = clientInput.value.trim().toUpperCase();
          if (val) openDiscountManagerModal(val);
        };
        applyClientBtn.addEventListener("click", applyNewClient);
        clientInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") applyNewClient();
        });
      }

      // Pārlasīt rindas
      const attachReloadListener = () => {
        const reloadLinesBtn = modal.querySelector("#bcm-reload-lines-btn");
        if (reloadLinesBtn) {
          reloadLinesBtn.addEventListener("click", () => {
            openDiscountManagerModal(headerInfo.relatedCustomerNo);
          });
        }
      };
      attachReloadListener();

      const updateModalSummaryAndButton = () => {
        const withDiscCount = lines.filter(l => l.newDiscount > 0).length;
        const applyBtn = modal.querySelector("#bcm-apply-btn");
        if (applyBtn) {
          applyBtn.textContent = `⚡ Automātiski ierakstīt (${withDiscCount})`;
          applyBtn.disabled = withDiscCount === 0;
        }
        const summaryBar = modal.querySelector(".bcm-summary-bar");
        if (summaryBar) {
          const overwCount = lines.filter(l => l.status === "overwritten").length;
          const noDiscCount = lines.filter(l => l.newDiscount === 0).length;
          summaryBar.innerHTML = `
            <span class="bcm-chip total">Kopā rindas: ${lines.length}</span>
            <span class="bcm-chip matched">Ar atlaidi: ${withDiscCount}</span>
            ${overwCount > 0 ? `<span class="bcm-chip overwritten">⚠️ Mainītas esošās: ${overwCount}</span>` : ""}
            <span class="bcm-chip nodisc">Bez atlaides: ${noDiscCount}</span>
            <button class="bcm-btn bcm-btn-secondary" id="bcm-scan-all-lines-btn" style="padding: 2px 9px; font-size: 11px; margin-left: auto; width: auto; display: inline-flex; align-items: center; gap: 4px;" title="Ritina pasūtījuma rindu tabulu, lai nolasītu un pievienotu visas rindas">
              <span>🔍</span> Ielasīt visas rindas (ritināt)
            </button>
          `;
          bindScanAllBtn();
        }
        const copyBtn = modal.querySelector("#bcm-copy-clipboard-btn");
        if (copyBtn) copyBtn.disabled = lines.length === 0;
      };

      const bindDiscountInputs = () => {
        modal.querySelectorAll(".bcm-discount-input").forEach(input => {
          input.addEventListener("input", (e) => {
            const idx = parseInt(e.target.dataset.idx, 10);
            const val = parseFloat(e.target.value) || 0;
            lines[idx].newDiscount = val;
            const rowEl = modal.querySelector(`tr[data-line-id="${lines[idx].id}"]`);
            if (val > 0) {
              if (lines[idx].currentDiscount > 0 && lines[idx].currentDiscount !== val) {
                lines[idx].status = "overwritten";
              } else {
                lines[idx].status = "new";
              }
              lines[idx].matchedReason = "Ievadīts manuāli";
            } else {
              lines[idx].status = "nodisc";
              lines[idx].matchedReason = "Bez atlaides (0%)";
            }
            if (rowEl) {
              const badgeCell = rowEl.cells[7];
              if (badgeCell) {
                badgeCell.innerHTML = lines[idx].status === 'new' ? '<span class="bcm-badge item-match">✓ Jauna atlaide</span>' :
                  lines[idx].status === 'overwritten' ? '<span class="bcm-badge warn-overwrite">⚠️ Pārrakstīs</span>' :
                  '<span class="bcm-badge no-match">— Standarta</span>';
              }
              const reasonCell = rowEl.cells[6];
              if (reasonCell) {
                reasonCell.innerHTML = `<span style="font-size: 12px; color: #4b5563;">${escapeHtml(lines[idx].matchedReason)}</span>`;
              }
            }
            updateModalSummaryAndButton();
          });
        });
      };
      bindDiscountInputs();

      const bindScanAllBtn = () => {
        const scanAllBtn = modal.querySelector("#bcm-scan-all-lines-btn");
        if (!scanAllBtn) return;
        scanAllBtn.addEventListener("click", async () => {
          scanAllBtn.disabled = true;
          scanAllBtn.textContent = "⏳ Ritinām pasūtījumu...";
          const progressBox = modal.querySelector("#bcm-progress-box");
          const progressText = modal.querySelector("#bcm-progress-text");
          const progressBar = modal.querySelector("#bcm-progress-bar");
          if (progressBox) progressBox.style.display = "block";
          if (progressText) progressText.textContent = "Ritinām pasūtījumu un meklējam papildu rindas...";
          if (progressBar) progressBar.style.width = "40%";

          try {
            const allExtracted = await extractAllSalesLines((count) => {
              if (progressText) progressText.textContent = `Ritinām pasūtījumu... atrasta(s) ${count} rindas`;
              if (progressBar) progressBar.style.width = `${Math.min(95, 40 + count * 2)}%`;
            }, knownGroupCodes);
            const matchedAll = await matchDiscountsForLines(allExtracted, headerInfo.relatedCustomerNo);
            lines.length = 0;
            lines.push(...matchedAll);
            // Pārkopējam kolonnu esamības karodziņus no pilnās skenēšanas
            lines.hasDiscountColumn = allExtracted.hasDiscountColumn;
            lines.hasGroupColumn = allExtracted.hasGroupColumn;
            const tbody = modal.querySelector("#bcm-table-body");
            if (tbody) {
              tbody.innerHTML = renderTableRows(lines);
              bindDiscountInputs();
              attachReloadListener();
            }
            updateModalSummaryAndButton();
            updateColumnWarnings(lines, true);
            if (progressText) progressText.textContent = `✓ Veiksmīgi ielasītas visas ${lines.length} rindas!`;
            if (progressBar) progressBar.style.width = "100%";
            setTimeout(() => { if (progressBox) progressBox.style.display = "none"; }, 1200);
            showToast(`✓ Ielasītas visas ${lines.length} pasūtījuma rindas!`, "success");
          } catch (e) {
            console.warn("Kļūda skenējot visas rindas:", e);
            if (progressBox) progressBox.style.display = "none";
          } finally {
            scanAllBtn.disabled = false;
            scanAllBtn.innerHTML = "<span>🔍</span> Ielasīt visas rindas (ritināt)";
          }
        });
      };
      bindScanAllBtn();

      modal.querySelector("#bcm-copy-clipboard-btn").addEventListener("click", () => {
        copyDiscountsToClipboard(lines);
      });

      modal.querySelector("#bcm-refresh-discounts-btn").addEventListener("click", async () => {
        const targetCust = (modal.querySelector("#bcm-client-no-input")?.value || headerInfo.relatedCustomerNo || "").trim().toUpperCase();
        if (!targetCust) {
          showToast("Lūdzu, ievadiet saistītā klienta kodu!", "warning");
          return;
        }
        showToast(`⚡ Atver Page 7004 klienta ${targetCust} atlaižu nolasīšanai...`, "info");
        chrome.runtime.sendMessage({
          action: "START_CUSTOMER_SYNC",
          customerNo: targetCust
        });
      });

      modal.querySelector("#bcm-apply-btn").addEventListener("click", async () => {
        await executeApplyDiscounts(lines);
      });

      // Fona papildu rindu pārbaude (ja tabula ir ritināma 2D virzienā, nebloķējot lietotāju)
      setTimeout(() => {
        const anchor = (lines[0] && lines[0].gridElement) || findSalesLinesListPart(getBCDocument());
        const vScroller = anchor ? findScroller(anchor) : null;
        const hScroller = anchor ? findHorizontalScroller(anchor) : null;
        const needs2DScan =
          (vScroller && vScroller.scrollHeight > vScroller.clientHeight + 40) ||
          (hScroller && hScroller.scrollWidth > hScroller.clientWidth + 20) ||
          !lines.hasDiscountColumn ||
          !lines.hasGroupColumn;
        if (needs2DScan && (vScroller || hScroller)) {
          const scanBtn = modal.querySelector("#bcm-scan-all-lines-btn");
          if (scanBtn && !scanBtn.disabled) {
            scanBtn.click();
          }
        } else {
          updateColumnWarnings(lines, true);
        }
      }, 400);

    } catch (err) {
      console.error("[BC Atlaižu Helperis] Kļūda atverot modālo logu:", err);
      if (err.message && err.message.includes("Extension context invalidated")) {
        showToast("Paplašinājums tika atjaunināts! Lūdzu, pārlādējiet šo lapu (F5).", "warning");
      } else {
        bcmLog("MODAL_OPEN_ERROR", { error: err.message, stack: err.stack });
        showToast("Neizdevās atvērt atlaižu logu: " + err.message, "error");
      }
    }
  }

  function closeModal() {
    if (activeModal) {
      activeModal.remove();
      activeModal = null;
    }
  }

  // --------------------------------------------------------------------------
  // 7. Pilnībā automātiskā ierakstīšana Business Central pasūtījuma rindās
  // --------------------------------------------------------------------------
  function resetGridSelection(doc) {
    if (!doc) return;
    try {
      // Noņemam atzīmes no checkboxiem, ja tādi ir atzīmēti (NEKAD nesūtām Escape taustiņu, jo tas aizver pasūtījuma logu!)
      const checkedBoxes = Array.from(doc.querySelectorAll('input[type="checkbox"]:checked'));
      checkedBoxes.forEach(el => {
        el.checked = false;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Kļūda resetGridSelection:", e);
    }
  }

  function clearCellHighlight(cell) {
    if (!cell) return;
    try {
      cell.classList.remove("bcm-highlight-cell");
      cell.style.removeProperty("outline");
      cell.style.removeProperty("outline-offset");
      cell.style.removeProperty("background-color");
      cell.style.removeProperty("box-shadow");
      cell.style.removeProperty("z-index");
      Array.from(cell.querySelectorAll("*")).forEach(ch => {
        ch.style.removeProperty("background-color");
      });
    } catch (e) {}
  }

  function clearAllHighlights() {
    const docs = [document];
    if (window.top && window.top.document && window.top.document !== document) {
      docs.push(window.top.document);
    }
    const iframes = Array.from(document.querySelectorAll("iframe"));
    for (const ifr of iframes) {
      try {
        const subDoc = ifr.contentDocument || ifr.contentWindow?.document;
        if (subDoc && !docs.includes(subDoc)) docs.push(subDoc);
      } catch (e) {}
    }
    docs.forEach(d => {
      try {
        Array.from(d.querySelectorAll(".bcm-highlight-cell")).forEach(clearCellHighlight);
        Array.from(d.querySelectorAll(".bcm-paste-badge")).forEach(b => b.remove());
      } catch (e) {}
    });
  }



  function readCellValue(cell) {
    if (!cell) return null;
    const inp = cell.querySelector("input");
    return parseNum(inp ? inp.value : (cell.innerText || cell.textContent || ""));
  }

  function rowMatchesItem(row, targetItemCode) {
    if (!row || !targetItemCode) return false;
    const target = targetItemCode.trim().toUpperCase();

    // 1. Primāri: šūna ar controlname="No."
    const noCell = row.querySelector('td[controlname="No."], td[controlname="No"], td[controlname="ItemNo"], td[controlname="Item No."], [controlname="No."]');
    if (noCell) {
      const inp = noCell.querySelector("input");
      const val = (inp ? inp.value : (noCell.innerText || noCell.textContent || "")).trim().toUpperCase();
      if (val === target) return true;
    }

    // 2. Visas rindas šūnas
    const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
    for (const c of cells) {
      const inp = c.querySelector("input");
      const val = (inp ? inp.value : (c.innerText || c.textContent || "")).trim().toUpperCase();
      if (val === target) return true;
    }

    return false;
  }

  // Atrod rindu PAŠREIZĒJĀ DOM pēc stabilas atslēgas (artikuls + kārtas nr. starp vienādiem artikuliem).
  // BC grids pārzīmē/pārizmanto rindu elementus, tāpēc saglabātās atsauces nedrīkst izmantot aklā.
  function findRowNow(line, bcDoc) {
    if (!line || !line.itemCode) return null;
    const targetCode = line.itemCode.trim();

    // 1. Pārbaudām ariaRowIndex, ja pieejams
    if (line.ariaRowIndex) {
      const g = (line.gridElement && line.gridElement.isConnected) ? line.gridElement : bcDoc;
      const r = g.querySelector(`[aria-rowindex="${line.ariaRowIndex}"]`);
      if (r && rowMatchesItem(r, targetCode)) return r;
    }

    // 2. Pārbaudām saglabāto rowElement, ja tas vēl ir pieslēgts DOM un sakrīt
    if (line.rowElement && line.rowElement.isConnected) {
      if (rowMatchesItem(line.rowElement, targetCode)) {
        return line.rowElement;
      }
    }

    // 3. Meklējam visās grida rindās pēc artikula un kārtas skaitļa (ordinal)
    const grid = (line.rowElement && line.rowElement.isConnected && line.rowElement.closest('table, [role="grid"]')) || line.gridElement;
    const scope = (grid && grid.isConnected) ? grid : bcDoc;
    const rows = Array.from(scope.querySelectorAll('[role="row"], tr'));
    let seen = 0;
    for (const r of rows) {
      if (!rowMatchesItem(r, targetCode)) continue;
      if (seen === (line.ordinal || 0)) return r;
      seen++;
    }

    // 4. Ja pēc ordinal neatrada, meklējam jebkuru rindu ar šo artikulu
    for (const r of rows) {
      if (rowMatchesItem(r, targetCode)) return r;
    }

    return null;
  }

  // Atrod rindu; ja tā nav DOM (virtualizācija), ritina grida konteineru un meklē vēlreiz
  async function resolveRow(line, bcDoc) {
    let row = findRowNow(line, bcDoc);
    if (row) return row;
    let anchor = (line.gridElement && line.gridElement.isConnected) ? line.gridElement
      : findSalesLinesListPart(bcDoc);
    const scroller = anchor ? findScroller(anchor) : null;
    if (!scroller) return null;

    // 1. Ritinām uz leju
    for (let step = 0; step < 20; step++) {
      const prev = scroller.scrollTop;
      scroller.scrollTop += Math.max(60, Math.floor(scroller.clientHeight * 0.7));
      await sleep(150);
      row = findRowNow(line, bcDoc);
      if (row) return row;
      if (scroller.scrollTop === prev) break;
    }

    // 2. Ja uz leju neatrada, pārbaudām ritinot atpakaļ uz augšu
    for (let step = 0; step < 25; step++) {
      const prev = scroller.scrollTop;
      scroller.scrollTop -= Math.max(60, Math.floor(scroller.clientHeight * 0.7));
      await sleep(150);
      row = findRowNow(line, bcDoc);
      if (row) return row;
      if (scroller.scrollTop === prev) break;
    }

    return null;
  }

  // Nodrošina, ka atlaides šūna ir redzama (atrisina horizontālās virtualizācijas dēļ)
  async function ensureDiscountCellVisible(row, line, bcDoc) {
    // 1. Mēģinām atrast šūnu uzreiz
    let cell = getDiscountCellForRow(row, line, bcDoc);
    if (cell && cell.getBoundingClientRect().width > 0) return cell;

    // 2. Atrodam horizontālo ritinātāju
    let hScroller = findHorizontalScroller(row);
    if (!hScroller) {
      const anchor = (line && line.gridElement && line.gridElement.isConnected)
        ? line.gridElement
        : findSalesLinesListPart(bcDoc);
      hScroller = findHorizontalScroller(anchor);
    }
    if (!hScroller) return getDiscountCellForRow(row, line, bcDoc);

    // 3. Ja zinām iepriekšējo horizontālo pozīciju, mēģinām to uzreiz
    if (line && typeof line.discountScrollLeft === "number") {
      hScroller.scrollLeft = line.discountScrollLeft;
      await sleep(120);
      row = findRowNow(line, bcDoc) || row;
      cell = getDiscountCellForRow(row, line, bcDoc);
      if (cell && cell.getBoundingClientRect().width > 0) return cell;
    }

    // 4. Soli pa solim ritinām horizontāli, līdz atrodam šūnu
    const stepSize = Math.max(150, Math.floor(hScroller.clientWidth * 0.6));
    const maxLeft = hScroller.scrollWidth;
    for (let left = 0; left <= maxLeft; left += stepSize) {
      hScroller.scrollLeft = left;
      await sleep(100);
      row = findRowNow(line, bcDoc) || row;
      cell = getDiscountCellForRow(row, line, bcDoc);
      if (cell && cell.getBoundingClientRect().width > 0) {
        if (line) line.discountScrollLeft = hScroller.scrollLeft;
        return cell;
      }
    }

    // 5. Atgriežam pēdējo mēģinājumu (var būt null)
    return getDiscountCellForRow(row, line, bcDoc);
  }

  function highlightCell(cell) {
    cell.classList.add("bcm-highlight-cell");
    cell.style.setProperty("outline", "4px solid #ff5501", "important");
    cell.style.setProperty("outline-offset", "-2px", "important");
    cell.style.setProperty("background-color", "rgba(255, 85, 1, 0.45)", "important");
    cell.style.setProperty("box-shadow", "0 0 24px rgba(255, 85, 1, 0.95)", "important");
    cell.style.setProperty("z-index", "9999", "important");
    Array.from(cell.querySelectorAll("*")).forEach(ch => ch.style.setProperty("background-color", "transparent", "important"));
  }

  function clickAt(el) {
    try {
      if (typeof el.focus === "function") el.focus();
    } catch (e) {}
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: el.ownerDocument.defaultView };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {}
  }

  function sendKey(el, key, keyCode) {
    const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // Ieraksta atlaidi vienā rindā ar svaigu rindas/šūnas noteikšanu, commit (Tab) un verifikāciju
  async function writeDiscountForLine(line, bcDoc) {
    const valStr = formatBcNumber(line.newDiscount, bcDoc);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let row = await resolveRow(line, bcDoc);
      if (!row) {
        bcmLog("WRITE_ROW_NOT_FOUND", { item: line.itemCode, ordinal: line.ordinal, attempt });
        continue;
      }

      // Nodrošinām, ka atlaides šūna ir redzama (horizontālā virtualizācija)
      let cell = await ensureDiscountCellVisible(row, line, bcDoc);
      if (!cell) {
        bcmLog("WRITE_CELL_NOT_FOUND", { item: line.itemCode, attempt, ariaIdx: line.discountAriaColIndex, colIdx: line.discountColIndex });
        continue;
      }

      // Ja ritināšanas laikā rinda tika pārzīmēta, atkārtoti to atrodam
      if (!row.isConnected) {
        row = findRowNow(line, bcDoc) || row;
      }
      if (!cell.isConnected) {
        cell = getDiscountCellForRow(row, line, bcDoc) || cell;
      }

      const doc = cell.ownerDocument || document;
      ensureHighlightStyles(doc);
      cell.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      await nextFrame();
      await nextFrame();
      highlightCell(cell);

      let inp = cell.querySelector("input") || (doc.activeElement && doc.activeElement.tagName === "INPUT" && cell.contains(doc.activeElement) ? doc.activeElement : null);
      if (!inp) {
        clickAt(cell);
        inp = await waitFor(() => cell.isConnected && (cell.querySelector("input") || (doc.activeElement && doc.activeElement.tagName === "INPUT" && cell.contains(doc.activeElement) ? doc.activeElement : null)), 800);
      }
      if (!inp) {
        const inner = cell.firstElementChild || cell;
        clickAt(inner);
        try {
          inner.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: doc.defaultView }));
        } catch (e) {}
        inp = await waitFor(() => cell.isConnected && (cell.querySelector("input") || (doc.activeElement && doc.activeElement.tagName === "INPUT" && cell.contains(doc.activeElement) ? doc.activeElement : null)), 800);
      }
      if (!inp) {
        bcmLog("WRITE_NO_INPUT", { item: line.itemCode, attempt });
        continue;
      }

      try {
        inp.focus();
        inp.select();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(inp, valStr);
        inp.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        sendKey(inp, "Tab", 9);
        inp.blur();
      } catch (e) {
        bcmLog("WRITE_ERROR", { item: line.itemCode, error: String(e) });
        continue;
      }

      const target = line.newDiscount;
      const verified = await waitFor(() => {
        const r = findRowNow(line, bcDoc);
        const c = r && getDiscountCellForRow(r, line, bcDoc);
        if (!c) return null;
        const val = readCellValue(c);
        return Math.abs(val - target) < 0.05 ? c : null;
      }, 1500, 40);

      if (verified) return { ok: true, cell: verified };
      bcmLog("WRITE_VERIFY_FAILED", { item: line.itemCode, attempt, target, readVal: readCellValue(cell) });
    }
    return { ok: false, cell: null };
  }
  async function writeDiscountToCell(cell, discountValue) {
    // Saderībai ar veco API — izmanto tikai highlightTargetCell
    if (!cell) return false;
    ensureHighlightStyles(cell.ownerDocument || document);
    highlightCell(cell);
    return true;
  }

  function highlightTargetCell(cell, discountValue) {
    if (!cell) return;
    writeDiscountToCell(cell, discountValue);
  }

  async function executeApplyDiscounts(lines) {
    const linesToUpdate = lines.filter(l => l.newDiscount > 0);
    const total = linesToUpdate.length;

    if (total === 0) {
      showToast("Nav nevienas rindas ar atlaidi!", "warning");
      return;
    }

    // Rezerves nolūkam iekopējam VISAS rindas buferī (lai ielīmēšana sakristu 1:1)
    try {
      const bcDocClip = getBCDocument();
      const discountsText = lines.map(l => formatBcNumber(l.newDiscount, bcDocClip)).join("\r\n");
      await navigator.clipboard.writeText(discountsText);
    } catch (e) {}

    closeModal();
    bcmBusy = true;

    try {
      const bcDoc = getBCDocument();
      resetGridSelection(bcDoc);
      await sleep(100);

      showToast(`⚡ Automātiski ieraksta atlaides ${total} rindās...`, "info");

      const touchedCells = [];
      const failed = [];
      let successCount = 0;
      for (const line of linesToUpdate) {
        const res = await writeDiscountForLine(line, bcDoc);
        if (res.ok) {
          successCount++;
          if (res.cell) touchedCells.push(res.cell);
        } else {
          failed.push(line);
        }
      }

      setTimeout(() => touchedCells.forEach(clearCellHighlight), 1000);

      if (failed.length === 0) {
        clearAllHighlights();
        showToast(`✅ Veiksmīgi ierakstītas atlaides ${successCount} no ${total} rindām!`, "success");
      } else {
        const list = failed.map(l => `${l.rowIndex} (${l.itemCode})`).join(", ");
        bcmLog("APPLY_PARTIAL", { successCount, total, failed: failed.map(l => l.itemCode) });
        showToast(`⚠️ Ierakstītas ${successCount}/${total}. Neizdevās rindām: ${list}. Pārbaudiet tās manuāli.`, "warning");
      }

      const onAnyClick = () => {
        touchedCells.forEach(clearCellHighlight);
        clearAllHighlights();
        window.removeEventListener("click", onAnyClick, true);
      };
      window.addEventListener("click", onAnyClick, true);
    } finally {
      bcmBusy = false;
    }
  }

  function copyDiscountsToClipboard(lines) {
    const targetLines = lines;
    const bcDocClip = getBCDocument();
    const discountsText = targetLines.map(l => formatBcNumber(l.newDiscount !== undefined ? l.newDiscount : (l.currentDiscount || 0), bcDocClip)).join("\r\n");
    navigator.clipboard.writeText(discountsText).then(() => {
      showToast(`📋 Atlaižu kolonna (${targetLines.length} rindām) nokopēta buferī!`, "success");
    }).catch(err => {
      console.error("Kļūda kopējot buferī:", err);
      showToast("Neizdevās nokopēt buferī.", "error");
    });
  }


  // --------------------------------------------------------------------------
  // 8. Lapas 7004 (Sales Line Discounts) automatizācija un nolasīšana (v1.3.0)
  // --------------------------------------------------------------------------
  let autoCloseTimer = null;
  let autoCloseCancelled = false;

  function getBCAppDocument() {
    const ifr = document.querySelector("iframe.designer-client-frame");
    try {
      if (ifr && ifr.contentDocument && ifr.contentDocument.body) {
        return ifr.contentDocument;
      }
    } catch (e) {}
    // Fallback: pārbaudām top document vai visus dokumentus
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

  // Strādā gan ar oriģinālo, gan ar BC pārrakstīto formu: 'Sales Line Discount'.'Sales Code' IS 'K427800'
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
    if (!c) return null; // lauks vēl nav ielādēts
    const inp = c.querySelector("input");
    if (inp && inp.value !== undefined) return (inp.value || "").trim().toUpperCase();
    const v = c.querySelector('.stringcontrol-read, [role="textbox"], .ms-nav-edit-control');
    return ((v && (v.textContent || v.getAttribute("title") || v.innerText)) || "").trim().toUpperCase();
  }

  // Nosaka kolonnu indeksus Page 7004 tabulā no galvenes tabulas vai verificētajām noklusējuma vērtībām
  function getGridColumnIndices(doc) {
    const indices = {
      salesType: 2,
      salesCode: 5,
      type: 6,
      code: 7,
      uom: 10,
      minQty: 11,
      discount: 12,
      startDate: 13,
      endDate: 14
    };

    // Papildu metadati: aria-colindex/data-col-index kartējums un galvenes šūnu skaits
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

        // Saglabājam aria-colindex / data-col-index, ja tāds ir uz galvenes šūnas
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

    // 1. Mēģinām atrast pēc controlname (ja šūnai ir controlname atribūts, piem. aktīvajā rindā)
    if (controlName) {
      const td = tr.querySelector(`td[controlname="${controlName}"], [controlname="${controlName}"]`);
      if (td) {
        const inp = td.querySelector("input");
        const val = ((inp ? inp.value : td.textContent) || "").replace(/\s+/g, " ").trim();
        if (val) return val;
      }
    }

    // 2. Ja pēc controlname nav atrasts, mēģinām pēc aria-colindex / data-col-index
    if (ariaColIndex !== undefined && ariaColIndex !== null && ariaColIndex !== "") {
      const td = tr.querySelector(`td[aria-colindex="${ariaColIndex}"], td[data-col-index="${ariaColIndex}"], [aria-colindex="${ariaColIndex}"], [data-col-index="${ariaColIndex}"]`);
      if (td) {
        const inp = td.querySelector("input");
        const val = ((inp ? inp.value : td.textContent) || "").replace(/\s+/g, " ").trim();
        if (val) return val;
      }
    }

    // 3. Ja pēc atribūtiem nav atrasts, ņemam šūnu pēc indeksa (ar pielāgotu nobīdi)
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

  function parseLvNumber(s) {
    return parseNum(s);
  }

  function setBanner(type, message, showDiagnosticsBtn = false) {
    const banner = document.getElementById("bcm-page7004-banner");
    const statusText = document.getElementById("bcm-page7004-status-text");
    const actionsBox = document.getElementById("bcm-page7004-actions");
    if (banner) {
      banner.className = `bcm-page7004-banner ${type}`;
    }
    if (statusText) {
      statusText.innerHTML = message;
    }
    if (showDiagnosticsBtn && actionsBox) {
      if (!document.getElementById("bcm-copy-diag-btn")) {
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
  }

  function injectPage7004Banner() {
    if (document.getElementById("bcm-page7004-banner")) return;

    const banner = document.createElement("div");
    banner.id = "bcm-page7004-banner";
    banner.className = "bcm-page7004-banner";
    banner.innerHTML = `
      <div class="bcm-page7004-info">
        <span style="font-size: 16px;">⚡</span>
        <span id="bcm-page7004-status-text"><strong>BC Atlaižu Helperis (v${APP_VERSION}):</strong> Gatavs nolasīt un saglabāt klienta rindu atlaides kešā.</span>
      </div>
      <div id="bcm-page7004-actions" style="display: flex; align-items: center; gap: 8px;">
        <button class="bcm-page7004-btn" id="bcm-scrape-7004-btn">💾 Saglabāt atlaides helperim</button>
      </div>
    `;

    document.body.prepend(banner);

    document.getElementById("bcm-scrape-7004-btn").addEventListener("click", async () => {
      const doc = getBCAppDocument() || document;
      let target = readSalesCodeFilter(doc);
      if (!target) {
        // Mēģinām no iframe src vai top URL
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
    if (autoSyncTriggered) return;
    autoSyncTriggered = true;
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
      setBanner("info", `<strong>BC Atlaižu Helperis (v${APP_VERSION}):</strong> Lapa atvērta manuāli. Nofiltrējiet klientu un spiediet <em>'💾 Saglabāt atlaides helperim'</em>.`);
      return; // K5: NEKAD neautomatizē un neaizver cilni, ko lietotājs atvēra pats
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
        if (Date.now() - stableSince > 1200) {
          bcmLog("WAIT_FOR_FILTERED_PAGE_SUCCESS", { target, elapsedMs: Date.now() - t0 });
          return { ok: true, doc, table };
        }
      } else {
        stableSince = 0;
      }
      await delay(300);
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
    return table.parentElement; // F4: div.ms-nav-scrollable.scroll-source
  }

  function expectedRowCount(doc) {
    if (!doc) return -1;
    const g = doc.querySelector('[role="grid"][aria-rowcount]');
    const n = g ? parseInt(g.getAttribute("aria-rowcount"), 10) : NaN;
    return isNaN(n) ? -1 : Math.max(0, n - 1); // -1 = galvene
  }

  // Dinamiski nosaka rindas nobīdi (rowOffset), lai kompensētu atšķirības starp galvenes un datu šūnu skaitu
  function calibrateRowOffset(tr, colIdx) {
    if (!tr) return 0;

    // 1. Mēģinām atrast šūnu ar controlname, kas atbilst zināmai kolonnai, un salīdzinām ar gaidīto indeksu
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

    // 2. Ja controlname nav atrasts, bet datu rindā ir vairāk šūnu nekā galvenē, pieņemam nobīdi
    const tdCount = tr.querySelectorAll("td").length;
    if (colIdx._headerCount > 0 && tdCount > colIdx._headerCount) {
      return tdCount - colIdx._headerCount;
    }

    // 3. Noklusējums — bez nobīdes
    return 0;
  }

  async function scrapeAllDiscountRows(doc, table, onProgress) {
    const scroller = findScroller7004(table);
    const byIndex = new Map();
    const colIdx = getGridColumnIndices(doc);
    bcmLog("GRID_COLUMN_INDICES", { colIdx, headerCount: colIdx._headerCount, aria: colIdx._aria });

    const collect = () => {
      // Meklējam visas datu rindas (ar role="row" vai tbody iekšpusē)
      const rows = Array.from(table.querySelectorAll('tbody tr, tr')).filter(r => {
        return r.getAttribute("role") === "row" || r.hasAttribute("aria-rowindex") || r.hasAttribute("rowkey") || (r.parentElement && r.parentElement.tagName.toLowerCase() === 'tbody');
      });

      rows.forEach(tr => {
        // Dinamiski kalibrējam nobīdi katrai rindai atsevišķi
        const rowOffset = calibrateRowOffset(tr, colIdx);

        const code = cellText(tr, "Code", colIdx.code, colIdx._aria.code, rowOffset);
        if (!code) return; // Izlaižam rindas bez koda (piem. tukšā ievades rinda)

        const rowIndex = tr.getAttribute("aria-rowindex") || tr.getAttribute("rowkey") || "";
        const minQty = parseLvNumber(cellText(tr, "Minimum Quantity", colIdx.minQty, colIdx._aria.minQty, rowOffset));
        const discPercent = parseLvNumber(cellText(tr, "Line Discount %", colIdx.discount, colIdx._aria.discount, rowOffset));

        // Unikāla atslēga: aria-rowindex, vai satura kombinācija
        const key = rowIndex || `${code}_${minQty}_${discPercent}`;

        byIndex.set(key, {
          salesType: cellText(tr, "Sales Type", colIdx.salesType, colIdx._aria.salesType, rowOffset) || "Klients",
          salesCode: (cellText(tr, "Sales Code", colIdx.salesCode, colIdx._aria.salesCode, rowOffset) || "").toUpperCase(),
          type: cellText(tr, "Type", colIdx.type, colIdx._aria.type, rowOffset) || "Preces atlaides grupa",
          code: code,
          uom: cellText(tr, "Unit of Measure Code", colIdx.uom, colIdx._aria.uom, rowOffset),
          minQty: minQty,
          discountPercent: discPercent,
          startDate: cellText(tr, "Starting Date", colIdx.startDate, colIdx._aria.startDate, rowOffset),
          endDate: cellText(tr, "Ending Date", colIdx.endDate, colIdx._aria.endDate, rowOffset)
        });
      });
    };

    // 1. Nolasām augšā
    scroller.scrollTop = 0;
    await delay(700);
    collect();
    onProgress && onProgress(byIndex.size, expectedRowCount(doc));

    // 2. Ritinām pakāpeniski uz leju līdz beigām
    const clientH = scroller.clientHeight || 800;
    const step = Math.max(350, Math.floor(clientH * 0.7));
    let stagnant = 0;

    for (let pos = step; pos <= scroller.scrollHeight + clientH; pos += step) {
      const before = byIndex.size;
      scroller.scrollTop = pos;
      await delay(600); // Ļaujam BC serverim un DOM asinhroni ielādēt virtuālās rindas
      collect();

      const exp = expectedRowCount(doc);
      if (exp > 0 && byIndex.size >= exp) break;

      stagnant = byIndex.size === before ? stagnant + 1 : 0;
      if (stagnant >= 4 && pos >= scroller.scrollHeight - clientH) break;

      onProgress && onProgress(byIndex.size, exp);
    }

    // 3. Pārliecināmies arī pašā apakšā
    scroller.scrollTop = scroller.scrollHeight;
    await delay(700);
    collect();

    // Atgriežam ritjoslu uz augšu
    scroller.scrollTop = 0;
    const finalExpected = expectedRowCount(doc);
    bcmLog("SCRAPE_COMPLETED", { collected: byIndex.size, finalExpected });

    return {
      rows: Array.from(byIndex.values()),
      expected: finalExpected
    };
  }
  function validateAndConvert(rows, expected, target) {
    const foreign = rows.filter(r => r.salesCode && r.salesCode !== target);
    if (foreign.length > 0) {
      return {
        ok: false,
        reason: `Atrastas ${foreign.length} rindas citam klientam (${foreign[0].salesCode}). Filtrs nav pareizs.`
      };
    }

    if (expected >= 0 && rows.length !== expected) {
      // Ja nolasītas visas reālās datu rindas (pieļaujam mazu nobīdi ±1, ja nav citu kļūdu un rindas > 0)
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
      .filter(r => /klients|customer/i.test(r.salesType) && r.discountPercent > 0)
      .map(r => ({
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
    setBanner("warning", `⚠️ <strong>BC Atlaižu Helperis:</strong> ${escapeHtml(msg)}`, true);
    showToast(`⚠️ ${msg}`, "warning");

    const actionsBox = document.getElementById("bcm-page7004-actions");
    if (actionsBox && !document.getElementById("bcm-retry-sync-btn")) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "bcm-page7004-btn";
      retryBtn.id = "bcm-retry-sync-btn";
      retryBtn.textContent = "🔄 Mēģināt vēlreiz";
      retryBtn.onclick = async () => {
        retryBtn.remove();
        autoSyncTriggered = false;
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
    setBanner("work", `Gaida, kamēr BC nofiltrē klientu <strong>${target}</strong>...`);

    const ready = await waitForFilteredPage(target);
    if (!ready.ok) {
      return failKeepOpen(`Lapa netika nofiltrēta klientam ${target}. ${ready.reason}`);
    }

    setBanner("work", `Nolasa klienta <strong>${target}</strong> atlaides...`);
    const { rows, expected } = await scrapeAllDiscountRows(
      ready.doc,
      ready.table,
      (got, exp) => setBanner("work", `Nolasa klienta <strong>${target}</strong> atlaides... <strong>${got}</strong>${exp > 0 ? " / " + exp : ""}`)
    );

    if (expected === 0 || rows.length === 0) {
      // Īsts "0 atlaižu" gadījums ir pieļaujams TIKAI tad, ja filtrs ir apstiprināts (waitForFilteredPage ok) un režģis ir tukšs
      await saveRules(target, [], 0);
      return setupAutoCloseCountdown(target, 0, 1, document.getElementById("bcm-page7004-status-text"), document.getElementById("bcm-page7004-actions"));
    }

    const v = validateAndConvert(rows, expected, target);
    if (!v.ok) {
      return failKeepOpen(v.reason); // NEKAD nesaglabā un neaizver
    }

    await saveRules(target, v.rules, rows.length);
    setupAutoCloseCountdown(target, v.rules.length, 1, document.getElementById("bcm-page7004-status-text"), document.getElementById("bcm-page7004-actions"));
  }

  async function runManualSyncPage7004(target) {
    bcmLog("RUN_MANUAL_SYNC_START", { target });
    const bannerStatus = document.getElementById("bcm-page7004-status-text");
    const actionsBox = document.getElementById("bcm-page7004-actions");

    const ready = await waitForFilteredPage(target, 10000);
    if (!ready.ok) {
      showToast(`⚠️ Filtrs nesakrīt ar ${target}!`, "warning");
      return;
    }

    setBanner("work", `Nolasa klienta <strong>${target}</strong> atlaides...`);
    const { rows, expected } = await scrapeAllDiscountRows(
      ready.doc,
      ready.table,
      (got, exp) => setBanner("work", `Nolasa klienta <strong>${target}</strong> atlaides... <strong>${got}</strong>${exp > 0 ? " / " + exp : ""}`)
    );

    const v = validateAndConvert(rows, expected, target);
    if (!v.ok) {
      showToast(`⚠️ Kļūda: ${v.reason}`, "error");
      return;
    }

    await saveRules(target, v.rules, rows.length);
    setBanner("info", `✓ Klienta <strong>${target}</strong> atlaides (${v.rules.length} noteikumi) veiksmīgi saglabātas kešā! Cilne paliek atvērta.`);
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
          ? `✅ <strong>BC Atlaižu Helperis:</strong> Saglabātas <strong>${count}</strong> atlaides klientam <strong>${customerNo}</strong>! Cilne aizvērsies pēc <strong>${remaining}s</strong>...`
          : `ℹ️ <strong>BC Atlaižu Helperis:</strong> Klientam <strong>${customerNo}</strong> Business Central nav individuālu atlaižu (0%). Saglabāts. Cilne aizvērsies pēc <strong>${remaining}s</strong>...`;
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
            statusEl.innerHTML = `✓ <strong>BC Atlaižu Helperis:</strong> Dati saglabāti kešā. Cilne paliek atvērta pārskatīšanai.`;
          }
          if (actionsEl) {
            actionsEl.innerHTML = `<button class="bcm-page7004-btn" id="bcm-close-now-btn">Aizvērt cilni</button>`;
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

  // --------------------------------------------------------------------------
  // 9. Palīgfunkcijas (Utilities)
  // --------------------------------------------------------------------------
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(message, type = "info") {
    const targetDoc = (window.top && window.top.document) ? window.top.document : document;
    const existing = targetDoc.querySelector(".bcm-toast");
    if (existing) existing.remove();

    clearTimeout(activeToastTimeout);

    const toast = targetDoc.createElement("div");
    toast.className = `bcm-toast ${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✓' : type === 'warning' ? '⚠️' : type === 'error' ? '✕' : 'ℹ️'}</span>
      <span>${escapeHtml(message)}</span>
    `;

    (targetDoc.body || document.body).appendChild(toast);

    activeToastTimeout = setTimeout(() => {
      toast.remove();
    }, 4500);
  }

  // Sākam inicializāciju
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
