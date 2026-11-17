/**
 * BC atlaižu pārvaldnieks - Palīgfunkcijas un stāvoklis
 */
(function () {
  if (window.__bcmManagerLoaded) return;
  if (
    location.port !== "8443" &&
    location.port !== "7048" &&
    !/[?&](company|page|tenant)=/i.test(location.search)
  ) {
    return;
  }
  window.__bcmManagerLoaded = true;

  let manifestVersion = "3.1.2";
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function") {
      manifestVersion = chrome.runtime.getManifest().version || manifestVersion;
    }
  } catch (e) {}

  const BCM = (window.__BCM = window.__BCM || {});
  BCM.APP_VERSION = manifestVersion;
  BCM.state = {
    activeModal: null,
    activeToastTimeout: null,
    autoSyncTriggered: false,
    bcmBusy: false
  };

  function isExtensionContextValid() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const delay = sleep;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

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
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      if (/,\d{3}$/.test(s) && (s.match(/,/g) || []).length > 1) {
        s = s.replace(/,/g, "");
      } else {
        s = s.replace(",", ".");
      }
    }

    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function detectBcDecimalSeparator(bcDoc) {
    const doc = bcDoc || (typeof BCM.getBCDocument === "function" ? BCM.getBCDocument() : null);
    if (!doc) return ",";
    if (doc.__bcmDecimalSep) return doc.__bcmDecimalSep;

    let cells = [];
    if (typeof BCM.findSalesLinesListPart === "function") {
      const part = BCM.findSalesLinesListPart(doc);
      if (part && part.querySelectorAll) {
        cells = part.querySelectorAll("td, span");
      }
    }
    if (!cells || !cells.length) {
      cells = doc.querySelectorAll ? doc.querySelectorAll("td, span") : [];
    }

    let sawDot = false;
    let sawComma = false;
    const limit = Math.min(cells.length, 120);
    for (let i = 0; i < limit; i++) {
      const el = cells[i];
      const txt = (el.textContent || "").trim();
      if (!/^\d+[.,]\d{2,3}$/.test(txt)) continue;
      if (txt.indexOf(".") !== -1) sawDot = true;
      if (txt.indexOf(",") !== -1) sawComma = true;
      if (sawDot && sawComma) break;
    }

    const sep = sawDot && !sawComma ? "." : ",";
    try { doc.__bcmDecimalSep = sep; } catch (e) {}
    return sep;
  }

  function formatBcNumber(num, bcDoc) {
    const s = String(num);
    if (detectBcDecimalSeparator(bcDoc) === ".") {
      return s.replace(",", ".");
    }
    return s.replace(".", ",");
  }

  async function waitFor(fn, timeoutMs, stepMs = 12) {
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

  async function bcmLog(step, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      version: BCM.APP_VERSION,
      step,
      url: window.location.href,
      isTop: window === window.top,
      ...data
    };
    console.log(`[BC Atlaižu Helperis v${BCM.APP_VERSION}] [${step}]`, data);
    if (!isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage({ action: "BCM_LOG", entry }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  function parseLvDate(str) {
    if (!str) return null;
    const s = String(str).split("T")[0].trim();
    if (!s || s.startsWith("0001-")) return null;

    let m = s.match(/^(\d{4})[\.\/\-](\d{1,2})[\.\/\-](\d{1,2})$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return new Date(year, month - 1, day);
    }

    m = s.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})$/);
    if (!m) return null;

    let day = parseInt(m[1], 10);
    let month = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;

    if (month > 12 && day <= 12) {
      const tmp = day;
      day = month;
      month = tmp;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

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

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(message, type = "info") {
    const targetDoc = getTargetDoc();
    const existing = targetDoc.querySelector(".bcm-toast");
    if (existing) existing.remove();

    clearTimeout(BCM.state.activeToastTimeout);

    const toast = targetDoc.createElement("div");
    toast.className = `bcm-toast ${type}`;
    toast.innerHTML = `
      <span>${type === "success" ? "✓" : type === "warning" ? "⚠️" : type === "error" ? "✕" : "ℹ️"}</span>
      <span>${escapeHtml(message)}</span>
    `;

    (targetDoc.body || document.body).appendChild(toast);

    BCM.state.activeToastTimeout = setTimeout(() => {
      toast.remove();
    }, 4500);
  }

  Object.assign(BCM, {
    isExtensionContextValid,
    sleep,
    delay,
    nextFrame,
    isDateString,
    parseNum,
    parseLvNumber: parseNum,
    detectBcDecimalSeparator,
    formatBcNumber,
    waitFor,
    getTargetDoc,
    bcmLog,
    parseLvDate,
    isRuleDateActive,
    escapeHtml,
    showToast
  });
})();
