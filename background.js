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

  // ODataV4 palīgfunkcijas
  function getCompanyFromUrl(url) {
    if (!url) return "AM Furnitūra EUR";
    try {
      const parsed = new URL(url);
      const comp = parsed.searchParams.get("company");
      if (comp) return decodeURIComponent(comp);
    } catch (e) {}
    return "AM Furnitūra EUR";
  }

  async function fetchODataWithAuth(url, options = {}) {
    let res = await fetch(url, { credentials: "include", ...options });
    if (res.status === 401) {
      try {
        const authTab = await chrome.tabs.create({
          url: "https://amfbc.amf.lv:7048/AMF/ODataV4/Company('AM%20Furnit%C5%ABra%20EUR')/salesDocumentLines?$top=1",
          active: false
        });
        await new Promise(r => setTimeout(r, 1500));
        if (authTab && authTab.id) {
          try { await chrome.tabs.remove(authTab.id); } catch (e) {}
        }
        res = await fetch(url, { credentials: "include", ...options });
      } catch (e) {
        console.warn("[BC Helper BG] Auth tab retry failed:", e);
      }
    }
    return res;
  }

  // ODataV4: Pasūtījuma rindu nolasīšana
  if (request.action === "ODATA_GET_ORDER_LINES") {
    (async () => {
      try {
        const company = request.company || getCompanyFromUrl(sender.tab?.url);
        const orderNo = String(request.orderNo || "").trim();
        if (!orderNo) {
          sendResponse({ success: false, error: "NO_ORDER_NO" });
          return;
        }
        const odataUrl = `https://amfbc.amf.lv:7048/AMF/ODataV4/Company('${encodeURIComponent(company)}')/salesDocumentLines?$filter=${encodeURIComponent("documentNumber eq '" + orderNo + "'")}`;
        const res = await fetchODataWithAuth(odataUrl, {
          method: "GET",
          headers: { "Accept": "application/json" }
        });
        if (res.ok) {
          const data = await res.json();
          sendResponse({ success: true, lines: data.value || [] });
        } else {
          sendResponse({ success: false, status: res.status, error: await res.text() });
        }
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // ODataV4: Atlaižu momentālā ierakstīšana (PATCH)
  if (request.action === "ODATA_APPLY_DISCOUNTS") {
    (async () => {
      try {
        const company = request.company || getCompanyFromUrl(sender.tab?.url);
        const orderNo = String(request.orderNo || "").trim();
        const updates = Array.isArray(request.updates) ? request.updates : [];
        if (!orderNo) {
          sendResponse({ success: false, error: "NO_ORDER_NO" });
          return;
        }

        // 1. solis: Ielasa aktuālās pasūtījuma rindas
        const getUrl = `https://amfbc.amf.lv:7048/AMF/ODataV4/Company('${encodeURIComponent(company)}')/salesDocumentLines?$filter=${encodeURIComponent("documentNumber eq '" + orderNo + "'")}`;
        const getRes = await fetchODataWithAuth(getUrl, {
          method: "GET",
          headers: { "Accept": "application/json" }
        });
        if (!getRes.ok) {
          sendResponse({ success: false, status: getRes.status, error: await getRes.text() });
          return;
        }
        const getData = await getRes.json();
        const serverLines = getData.value || [];

        // 2. solis: Katram u no updates
        let updatedCount = 0;
        const failedIds = [];

        for (const u of updates) {
          let targetRow = null;
          if (u.lineNumber) {
            targetRow = serverLines.find(r => r.lineNumber === u.lineNumber);
          }
          if (!targetRow && u.itemCode) {
            const code = String(u.itemCode || "").trim().toUpperCase();
            const matchedRows = serverLines
              .filter(r => r.type === "Item" && String(r.number || "").trim().toUpperCase() === code)
              .sort((a, b) => (Number(a.lineNumber) || 0) - (Number(b.lineNumber) || 0));
            const ordIdx = Number(u.ordinal) || 0;
            targetRow = matchedRows[ordIdx] || matchedRows[0] || null;
          }

          if (!targetRow) {
            failedIds.push(u.id);
            continue;
          }

          if (Math.abs((Number(targetRow.lineDiscountPercent) || 0) - Number(u.newDiscount)) < 0.05) {
            updatedCount++;
            continue;
          }

          const patchUrl = `https://amfbc.amf.lv:7048/AMF/ODataV4/Company('${encodeURIComponent(company)}')/salesDocumentLines(documentType='${encodeURIComponent(targetRow.documentType)}',documentNumber='${encodeURIComponent(targetRow.documentNumber)}',lineNumber=${targetRow.lineNumber})`;
          const patchOptions = {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "If-Match": "*"
            },
            body: JSON.stringify({ lineDiscountPercent: Number(u.newDiscount) })
          };

          let patchRes = await fetchODataWithAuth(patchUrl, patchOptions);
          if (!patchRes.ok && [409, 412, 500].includes(patchRes.status)) {
            await new Promise(r => setTimeout(r, 40));
            patchRes = await fetchODataWithAuth(patchUrl, patchOptions);
          }

          if (patchRes.ok) {
            updatedCount++;
          } else {
            failedIds.push(u.id);
          }
        }

        sendResponse({ success: true, updatedCount, failedIds });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // Versijas pārbaude (gan manuāla, gan automātiska)
  if (request.action === "CHECK_FOR_UPDATES") {
    checkVersionUpdate(!!request.force).then(info => {
      sendResponse({ success: true, updateInfo: info });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// --------------------------------------------------------------------------
// Versijas pārbaudes dzinējs (GitHub Releases API)
// --------------------------------------------------------------------------
const GITHUB_REPO_API = "https://api.github.com/repos/kaspars1985/BC-atlaizu-helperis/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 stundas

function parseSemVer(v) {
  if (!v) return [0, 0, 0];
  const clean = String(v).replace(/^v/i, "").trim();
  return clean.split(".").map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(latest, current) {
  const l = parseSemVer(latest);
  const c = parseSemVer(current);
  for (let i = 0; i < 3; i++) {
    const lPart = l[i] || 0;
    const cPart = c[i] || 0;
    if (lPart > cPart) return true;
    if (lPart < cPart) return false;
  }
  return false;
}

async function checkVersionUpdate(force = false) {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get(["bcm_update_info"]);
    const now = Date.now();

    if (!force && stored.bcm_update_info && (now - (stored.bcm_update_info.lastChecked || 0) < UPDATE_CHECK_INTERVAL_MS)) {
      if (stored.bcm_update_info.hasUpdate) {
        chrome.action.setBadgeText({ text: "NEW" });
        chrome.action.setBadgeBackgroundColor({ color: "#ff5501" });
      }
      return stored.bcm_update_info;
    }

    const response = await fetch(GITHUB_REPO_API, {
      headers: {
        "Accept": "application/vnd.github.v3+json"
      }
    });

    if (!response.ok) {
      return stored.bcm_update_info || { currentVersion, hasUpdate: false, lastChecked: now };
    }

    const data = await response.json();
    const latestTag = data.tag_name || "";
    const hasUpdate = isNewerVersion(latestTag, currentVersion);
    const asset = Array.isArray(data.assets) ? data.assets.find(a => a.name.endsWith(".zip")) : null;

    const updateInfo = {
      hasUpdate,
      latestVersion: latestTag.replace(/^v/i, ""),
      latestTag: latestTag,
      currentVersion,
      releaseName: data.name || latestTag,
      releaseUrl: data.html_url || "https://github.com/kaspars1985/BC-atlaizu-helperis/releases",
      downloadUrl: asset ? asset.browser_download_url : "https://github.com/kaspars1985/BC-atlaizu-helperis/releases/latest",
      body: data.body || "",
      lastChecked: now
    };

    await chrome.storage.local.set({ bcm_update_info: updateInfo });

    if (hasUpdate) {
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setBadgeBackgroundColor({ color: "#ff5501" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }

    return updateInfo;
  } catch (e) {
    console.warn("[BC Atlaižu Helperis] Neizdevās pārbaudīt versiju:", e);
    const stored = await chrome.storage.local.get(["bcm_update_info"]);
    return stored.bcm_update_info || { currentVersion: chrome.runtime.getManifest().version, hasUpdate: false, error: e.message };
  }
}

// Automātiskā pārbaude pie pārlūka palaišanas
chrome.runtime.onStartup.addListener(() => {
  checkVersionUpdate(false);
});

