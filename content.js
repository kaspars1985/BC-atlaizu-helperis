/**
 * BC atlaižu pārvaldnieks - Content Script (Ieejas punkts)
 * Manifest V3 - Integrācija ar Microsoft Dynamics 365 Business Central
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const {
    bcmLog,
    showToast,
    extractHeaderCustomerInfo,
    openDiscountManagerModal,
    injectPage7004Banner,
    checkPage7004AutoSync
  } = BCM;

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

  function checkAndInjectUI() {
    if (BCM.state.bcmBusy) return;
    if (detectDiscountsPage()) {
      injectPage7004Banner();
      checkPage7004AutoSync();
    }
  }

  function setupMutationObserver() {
    let debounceTimer = null;
    const runCheck = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndInjectUI, 300);
    };

    const observer = new MutationObserver(runCheck);
    const target = document.body || document.documentElement;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }

    setInterval(checkAndInjectUI, 1200);
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "CUSTOMER_SYNC_COMPLETED") {
        if (window !== window.top) return;

        bcmLog("CUSTOMER_SYNC_COMPLETED_RECEIVED", { customerNo: request.customerNo, count: request.count });
        if (request.count > 0) {
          showToast(`✓ Klienta ${request.customerNo} atlaides (${request.count} noteikumi) veiksmīgi ielasītas!`, "success");
        } else {
          showToast(`ℹ️ Klientam ${request.customerNo} Business Central nav konfigurētu atlaižu (0 noteikumi).`, "info");
        }

        openDiscountManagerModal(request.customerNo);
        sendResponse({ success: true });
        return true;
      }

      if (request.action === "GET_HEADER_INFO") {
        sendResponse(extractHeaderCustomerInfo());
        return true;
      }

      if (request.action === "OPEN_DISCOUNT_MODAL") {
        if (window === window.top) {
          openDiscountManagerModal();
        }
        sendResponse({ success: true });
        return true;
      }
    });
  }

  async function init() {
    if (window !== window.top) return;

    bcmLog("INIT", { userAgent: navigator.userAgent });
    try {
      chrome.runtime.sendMessage({ action: "INJECT_STYLES" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}

    await cleanupLegacySeeds();
    setupMessageListener();
    setupMutationObserver();
    checkAndInjectUI();
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "d" || e.key === "D")) {
      if (window === window.top) {
        e.preventDefault();
        openDiscountManagerModal();
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
