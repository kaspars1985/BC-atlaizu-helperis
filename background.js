/**
 * BC Atlaižu Helperis - Background Service Worker
 * Manifest V3
 */

// Initialize default storage on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("[BC Atlaižu Helperis] Paplašinājums veiksmīgi uzstādīts!");
  
  chrome.storage.local.get(["bc_manager_settings", "bc_client_discounts"], (data) => {
    if (!data.bc_manager_settings) {
      chrome.storage.local.set({
        bc_manager_settings: {
          inputDelayMs: 180, // Kavēšanās starp rindu ievadi (ms)
          autoOverwriteExisting: true, // Pārrakstīt jau ievadītās atlaides
          warnOnOverwrite: true, // Brīdināt, ja pārraksta esošu atlaidi
          cacheExpiryHours: 24 // Kešatmiņas derīguma termiņš (stundās)
        }
      });
    }
    if (!data.bc_client_discounts) {
      chrome.storage.local.set({ bc_client_discounts: {} });
    }
  });
});

// Message Listener for coordination between content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Get active BC tabs
  if (request.action === "GET_ACTIVE_BC_TABS") {
    chrome.tabs.query({ url: "*://amfbc.amf.lv/*" }, (tabs) => {
      sendResponse({ success: true, tabs: tabs || [] });
    });
    return true;
  }

  // Sākt automātisku klienta atlaižu sinhronizāciju no Page 7004
  if (request.action === "START_CUSTOMER_SYNC") {
    const customerNo = String(request.customerNo || "").trim().toUpperCase();
    const originTabId = sender.tab ? sender.tab.id : null;

    if (!customerNo) {
      sendResponse({ success: false, error: "NO_CUSTOMER" });
      return true;
    }

    // Nolasām company no origin tab URL, ja iespējams
    let companyParam = "company=AM%20Furnit%C5%ABra%20EUR";
    if (sender.tab && sender.tab.url) {
      const compMatch = sender.tab.url.match(/company=([^&]+)/i);
      if (compMatch) {
        companyParam = `company=${compMatch[1]}`;
      }
    }

    const filterEncoded = encodeURIComponent(`'Sales Code' IS '${customerNo}'`);
    const targetUrl = `https://amfbc.amf.lv:8443/AMF/?${companyParam}&page=7004&filter=${filterEncoded}`;

    chrome.tabs.create({ url: targetUrl, active: true }, async (newTab) => {
      try {
        await chrome.storage.session.set({
          bcm_sync_session: {
            syncTabId: newTab.id,
            originTabId: originTabId,
            customerNo: customerNo,
            startedAt: Date.now()
          }
        });
      } catch (e) {
        console.warn("[BC Atlaižu Helperis] Neizdevās saglabāt storage.session:", e);
      }
      sendResponse({ success: true, syncTabId: newTab.id });
    });
    return true;
  }

  // Pārbauda, vai konkrētā cilne ir automātiskā sinhronizācijas cilne
  if (request.action === "GET_SYNC_SESSION") {
    chrome.storage.session.get("bcm_sync_session").then(({ bcm_sync_session: s }) => {
      const isSyncTab = !!(s && sender.tab && s.syncTabId === sender.tab.id);
      sendResponse({
        isSyncTab: isSyncTab,
        customerNo: isSyncTab ? s.customerNo : null
      });
    }).catch(() => {
      sendResponse({ isSyncTab: false, customerNo: null });
    });
    return true;
  }

  // Pabeigt klienta atlaižu sinhronizāciju un aizvērt Page 7004 cilni
  if (request.action === "FINISH_CUSTOMER_SYNC") {
    chrome.storage.session.get("bcm_sync_session").then(async ({ bcm_sync_session: s }) => {
      const syncTabId = (sender.tab ? sender.tab.id : null) || (s ? s.syncTabId : null);
      const originTabId = (s ? s.originTabId : null) || request.originTabId;
      const customerNo = request.customerNo || (s ? s.customerNo : "");
      const count = request.count || 0;

      // 1. Aizveram sinhronizācijas cilni TIKAI tad, ja tā sakrīt ar reģistrēto sesiju
      if (syncTabId && s && syncTabId === s.syncTabId) {
        chrome.tabs.remove(syncTabId, () => {
          if (chrome.runtime.lastError) {}
        });
      }

      await chrome.storage.session.remove("bcm_sync_session").catch(() => {});

      // 2. Aktivizējam sākotnējo pasūtījuma cilni un sūtām ziņojumu TIKAI uz top frame (frameId: 0)
      if (originTabId) {
        chrome.tabs.update(originTabId, { active: true }, () => {
          chrome.tabs.sendMessage(originTabId, {
            action: "CUSTOMER_SYNC_COMPLETED",
            customerNo: customerNo,
            count: count
          }, { frameId: 0 }, () => {
            if (chrome.runtime.lastError) {}
          });
        });
      } else {
        chrome.tabs.query({ url: "*://amfbc.amf.lv/*" }, (tabs) => {
          if (tabs && tabs.length > 0) {
            const orderTab = tabs.find(t => (t.url || "").includes("page=42") || (t.title || "").toLowerCase().includes("pasūtījums")) || tabs[0];
            chrome.tabs.update(orderTab.id, { active: true }, () => {
              chrome.tabs.sendMessage(orderTab.id, {
                action: "CUSTOMER_SYNC_COMPLETED",
                customerNo: customerNo,
                count: count
              }, { frameId: 0 }, () => {
                if (chrome.runtime.lastError) {}
              });
            });
          }
        });
      }

      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Open Page 7004 in a background or helper tab (manuāli)
  if (request.action === "OPEN_BC_DISCOUNTS_PAGE") {
    const customerNo = request.customerNo ? String(request.customerNo).trim().toUpperCase() : "";
    const filterParam = customerNo ? `&filter=${encodeURIComponent(`'Sales Code' IS '${customerNo}'`)}` : "";
    const url = `https://amfbc.amf.lv:8443/AMF/?company=AM%20Furnit%C5%ABra%20EUR&page=7004${filterParam}`;

    chrome.tabs.create({ url: url, active: true }, (newTab) => {
      sendResponse({ success: true, tabId: newTab.id });
    });
    return true;
  }

  // Storage clearance helper
  if (request.action === "CLEAR_DISCOUNT_CACHE") {
    chrome.storage.local.set({ bc_client_discounts: {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
