/**
 * BC atlaižu pārvaldnieks - Background Service Worker
 * Manifest V3
 */

// Initialize default storage on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("[BC atlaižu pārvaldnieks] Paplašinājums veiksmīgi uzstādīts!");
  
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

function parseBcEnvFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split("/").filter(Boolean);
    const instance = pathParts[0] || "BC";
    const company = u.searchParams.get("company") ? decodeURIComponent(u.searchParams.get("company")) : "";
    return {
      protocol: u.protocol || "https:",
      hostname: u.hostname,
      port: u.port || "8443",
      instance,
      company
    };
  } catch (e) {
    return null;
  }
}

async function resolveBcEnv(senderUrl, reqCompany) {
  const parsed = parseBcEnvFromUrl(senderUrl);
  const stored = await chrome.storage.local.get(["bc_env_config"]);
  const prev = stored.bc_env_config || {};
  const env = {
    protocol: (parsed && parsed.protocol) || prev.protocol || "https:",
    hostname: (parsed && parsed.hostname) || prev.hostname || "",
    port: (parsed && parsed.port) || prev.port || "8443",
    instance: (parsed && parsed.instance) || prev.instance || "BC",
    company: reqCompany || (parsed && parsed.company) || prev.company || ""
  };
  if (!env.company) {
    env.company = "AM Furnitūra EUR";
  }
  if (env.hostname && env.company) {
    await chrome.storage.local.set({ bc_env_config: env });
  }
  return env;
}

// Message Listener for coordination between content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Get active BC tabs
  if (request.action === "GET_ACTIVE_BC_TABS") {
    chrome.tabs.query({}, (tabs) => {
      const bcTabs = (tabs || []).filter(t => (t.url || "").includes(":8443") || (t.url || "").includes("page="));
      sendResponse({ success: true, tabs: bcTabs });
    });
    return true;
  }

  // Sākt automātisku klienta atlaižu sinhronizāciju no Page 7004
  if (request.action === "START_CUSTOMER_SYNC") {
    (async () => {
      const customerNo = String(request.customerNo || "").trim().toUpperCase();
      const originTabId = sender.tab ? sender.tab.id : null;

      if (!customerNo) {
        sendResponse({ success: false, error: "NO_CUSTOMER" });
        return;
      }

      const env = await resolveBcEnv(sender.tab?.url, request.company);
      const filterEncoded = encodeURIComponent(`'Sales Code' IS '${customerNo}'`);
      const targetUrl = `${env.protocol}//${env.hostname}:${env.port}/${env.instance}/?company=${encodeURIComponent(env.company)}&page=7004&filter=${filterEncoded}`;

      chrome.tabs.create({ url: targetUrl, active: false }, async (newTab) => {
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
          console.warn("[BC atlaižu pārvaldnieks] Neizdevās saglabāt storage.session:", e);
        }
        sendResponse({ success: true, syncTabId: newTab.id });
      });
    })();
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
        chrome.tabs.query({}, (tabs) => {
          const bcTabs = (tabs || []).filter(t => (t.url || "").includes(":8443") || (t.url || "").includes("page="));
          if (bcTabs.length > 0) {
            const orderTab = bcTabs.find(t => (t.url || "").includes("page=42") || (t.title || "").toLowerCase().includes("pasūtījums")) || bcTabs[0];
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
    (async () => {
      const env = await resolveBcEnv(sender.tab?.url, request.company);
      const customerNo = request.customerNo ? String(request.customerNo).trim().toUpperCase() : "";
      const filterParam = customerNo ? `&filter=${encodeURIComponent(`'Sales Code' IS '${customerNo}'`)}` : "";
      const url = `${env.protocol}//${env.hostname}:${env.port}/${env.instance}/?company=${encodeURIComponent(env.company)}&page=7004${filterParam}`;

      chrome.tabs.create({ url: url, active: true }, (newTab) => {
        sendResponse({ success: true, tabId: newTab.id });
      });
    })();
    return true;
  }

  // Storage clearance helper
  if (request.action === "CLEAR_DISCOUNT_CACHE") {
    chrome.storage.local.set({ bc_client_discounts: {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Saglabāt OData akreditācijas datus
  if (request.action === "SAVE_ODATA_CREDENTIALS") {
    chrome.storage.local.set({
      bc_odata_credentials: {
        username: String(request.username || "").trim(),
        password: String(request.password || "")
      }
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Web Services (SOAP :7047): Klienta atlaižu tiešā nolasīšana bez Page 7004 cilnes
  if (request.action === "FETCH_CUSTOMER_DISCOUNTS_WS") {
    (async () => {
      try {
        const env = await resolveBcEnv(sender.tab?.url, request.company);
        const customerNo = String(request.customerNo || "").trim().toUpperCase();
        if (!customerNo) {
          sendResponse({ success: false, error: "NO_CUSTOMER" });
          return;
        }

        const soapUrl = `https://${env.hostname}:7047/${env.instance}/WS/${encodeURIComponent(env.company)}/Page/workflowSalesLineDiscounts`;
        const escXml = (s) => String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;");

        const soapBody =
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
            '<soap:Body>' +
              '<ReadMultiple xmlns="urn:microsoft-dynamics-schemas/page/workflowsaleslinediscounts">' +
                '<filter><Field>Sales_Type</Field><Criteria>Customer</Criteria></filter>' +
                '<filter><Field>Sales_Code</Field><Criteria>' + escXml(customerNo) + '</Criteria></filter>' +
                '<filter><Field>Type</Field><Criteria>0|1</Criteria></filter>' +
                '<setSize>5000</setSize>' +
              '</ReadMultiple>' +
            '</soap:Body>' +
          '</soap:Envelope>';

        const res = await fetch(soapUrl, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": "urn:microsoft-dynamics-schemas/page/workflowsaleslinediscounts:ReadMultiple"
          },
          body: soapBody
        });

        if (!res.ok) {
          let errText = "";
          try { errText = await res.text(); } catch (_) {}
          sendResponse({
            success: false,
            status: res.status,
            authRequired: res.status === 401 || res.status === 403,
            error: errText || `HTTP ${res.status}`
          });
          return;
        }

        const xml = await res.text();
        const decodeXml = (s) => String(s == null ? "" : s)
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, "&");

        const items = [];
        const itemRe = /<workflowSalesLineDiscounts>([\s\S]*?)<\/workflowSalesLineDiscounts>/g;
        let m;
        while ((m = itemRe.exec(xml)) !== null) {
          const block = m[1];
          const getTag = (tag) => {
            const re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">");
            const mm = block.match(re);
            return mm ? decodeXml(mm[1]) : "";
          };
          items.push({
            Sales_Type: getTag("Sales_Type"),
            Sales_Code: getTag("Sales_Code"),
            Type: getTag("Type"),
            Code: getTag("Code"),
            Unit_of_Measure_Code: getTag("Unit_of_Measure_Code"),
            Minimum_Quantity: getTag("Minimum_Quantity"),
            Line_Discount_Percent: getTag("Line_Discount_Percent"),
            Starting_Date: getTag("Starting_Date"),
            Ending_Date: getTag("Ending_Date")
          });
        }

        const rules = [];
        for (const it of items) {
          if (String(it.Sales_Code).trim().toUpperCase() !== customerNo) continue;
          const pct = parseFloat(it.Line_Discount_Percent);
          if (!(pct > 0)) continue;
          const typeStr = String(it.Type || "");
          rules.push({
            salesType: "Klients",
            salesCode: customerNo,
            type: (typeStr === "Item_Disc_Group" || /grup|group/i.test(typeStr))
              ? "Preces atlaides grupa"
              : "Prece",
            code: it.Code,
            uom: it.Unit_of_Measure_Code || "",
            minQty: parseFloat(it.Minimum_Quantity) || 0,
            discountPercent: pct || 0,
            startDate: (!it.Starting_Date || it.Starting_Date.startsWith("0001-")) ? "" : it.Starting_Date,
            endDate: (!it.Ending_Date || it.Ending_Date.startsWith("0001-")) ? "" : it.Ending_Date
          });
        }

        const stored = await chrome.storage.local.get(["bc_client_discounts", "bc_client_discounts_meta"]);
        const discounts = stored.bc_client_discounts || {};
        const meta = stored.bc_client_discounts_meta || {};
        discounts[customerNo] = rules;
        meta[customerNo] = {
          syncedAt: Date.now(),
          count: rules.length,
          rowCount: items.length,
          source: "ws"
        };
        await chrome.storage.local.set({
          bc_client_discounts: discounts,
          bc_client_discounts_meta: meta
        });

        sendResponse({ success: true, count: rules.length, rowCount: items.length, rules });
      } catch (err) {
        sendResponse({ success: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  // ODataV4: Pasūtījuma rindu nolasīšana
  if (request.action === "ODATA_GET_ORDER_LINES") {
    (async () => {
      try {
        const env = await resolveBcEnv(sender.tab?.url, request.company);
        const orderNo = String(request.orderNo || "").trim();
        if (!orderNo) {
          sendResponse({ success: false, error: "NO_ORDER_NO" });
          return;
        }
        const odataUrl = `https://${env.hostname}:7048/${env.instance}/ODataV4/Company('${encodeURIComponent(env.company)}')/salesDocumentLines?$filter=${encodeURIComponent("documentNumber eq '" + orderNo + "'")}`;
        const res = await fetch(odataUrl, {
          method: "GET",
          credentials: "include",
          headers: { "Accept": "application/json" }
        });
        if (res.ok) {
          const data = await res.json();
          const lines = data.value || [];

          const itemNumbers = Array.from(new Set(
            lines
              .filter(r => r.type === "Item" && r.number)
              .map(r => String(r.number))
          ));

          try {
            const itemInfo = {};
            for (let i = 0; i < itemNumbers.length; i += 25) {
              const batch = itemNumbers.slice(i, i + 25);
              const orExpr = batch.map(n => `number eq '${n.replace(/'/g, "''")}'`).join(" or ");
              const itemUrl = `https://${env.hostname}:7048/${env.instance}/ODataV4/Company('${encodeURIComponent(env.company)}')/AustraItem?$filter=${encodeURIComponent(orExpr)}&$select=number,itemDiscGroup,itemCategoryCode`;
              const itemRes = await fetch(itemUrl, {
                method: "GET",
                credentials: "include",
                headers: { "Accept": "application/json" }
              });
              if (itemRes.ok) {
                const itemData = await itemRes.json();
                (itemData.value || []).forEach(it => {
                  if (it && it.number) {
                    itemInfo[String(it.number).toUpperCase()] = {
                      itemDiscGroup: it.itemDiscGroup,
                      itemCategoryCode: it.itemCategoryCode
                    };
                  }
                });
              }
            }
            lines.forEach(r => {
              const info = itemInfo[String(r.number || "").toUpperCase()];
              if (info) {
                r.itemDiscGroup = info.itemDiscGroup || "";
                r.itemCategoryCode = r.itemCategoryCode || info.itemCategoryCode || "";
              }
            });
          } catch (e) {
            // Ignorēt AustraItem papildināšanas kļūdas
          }

          sendResponse({ success: true, lines });
        } else {
          sendResponse({
            success: false,
            status: res.status,
            authRequired: res.status === 401 || res.status === 403,
            error: (await res.text()) || `HTTP ${res.status}`
          });
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
        const env = await resolveBcEnv(sender.tab?.url, request.company);
        const orderNo = String(request.orderNo || "").trim();
        const updates = Array.isArray(request.updates) ? request.updates : [];
        if (!orderNo) {
          sendResponse({ success: false, error: "NO_ORDER_NO" });
          return;
        }

        const baseUrl = `https://${env.hostname}:7048/${env.instance}/ODataV4/Company('${encodeURIComponent(env.company)}')/salesDocumentLines`;
        const getUrl = `${baseUrl}?$filter=${encodeURIComponent("documentNumber eq '" + orderNo + "'")}`;
        const getRes = await fetch(getUrl, {
          method: "GET",
          credentials: "include",
          headers: { "Accept": "application/json" }
        });
        if (!getRes.ok) {
          sendResponse({
            success: false,
            status: getRes.status,
            authRequired: getRes.status === 401 || getRes.status === 403,
            error: (await getRes.text()) || `HTTP ${getRes.status}`
          });
          return;
        }
        const getData = await getRes.json();
        const serverLines = getData.value || [];

        let updatedCount = 0;
        const failedIds = [];
        const usedLineNumbers = new Set();

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
            targetRow = matchedRows[ordIdx] || matchedRows.find(r => !usedLineNumbers.has(r.lineNumber)) || matchedRows[0] || null;
          }
          if (targetRow) usedLineNumbers.add(targetRow.lineNumber);

          if (!targetRow) {
            failedIds.push(u.id);
            continue;
          }

          if (Math.abs((Number(targetRow.lineDiscountPercent) || 0) - Number(u.newDiscount)) < 0.05) {
            updatedCount++;
            continue;
          }

          const patchUrl = `${baseUrl}(documentType='${encodeURIComponent(targetRow.documentType)}',documentNumber='${encodeURIComponent(targetRow.documentNumber)}',lineNumber=${targetRow.lineNumber})`;
          const patchOptions = {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "If-Match": "*"
            },
            body: JSON.stringify({ lineDiscountPercent: Number(u.newDiscount) })
          };

          let patchRes = await fetch(patchUrl, patchOptions);
          if (!patchRes.ok && [409, 412, 500, 503].includes(patchRes.status)) {
            for (const waitMs of [80, 180, 350]) {
              if (patchRes.ok) break;
              await new Promise(r => setTimeout(r, waitMs));
              patchRes = await fetch(patchUrl, patchOptions);
            }
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
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 stunda

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
    console.warn("[BC atlaižu pārvaldnieks] Neizdevās pārbaudīt versiju:", e);
    const stored = await chrome.storage.local.get(["bcm_update_info"]);
    return stored.bcm_update_info || { currentVersion: chrome.runtime.getManifest().version, hasUpdate: false, error: e.message };
  }
}

// Automātiskā pārbaude pie pārlūka palaišanas
chrome.runtime.onStartup.addListener(() => {
  checkVersionUpdate(false);
});

// Atver modālo logu aktīvajā cilnē uzklikšķinot uz rīkjoslas ikonas vai nospiežot Alt+D
function triggerOpenModal(tab) {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: "OPEN_DISCOUNT_MODAL" }, () => {
      if (chrome.runtime.lastError) {}
    });
    // Pārbaudām atjauninājumus fonā pie katras modāļa atvēršanas
    checkVersionUpdate(false);
  }
}

chrome.action.onClicked.addListener(triggerOpenModal);

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "open_discount_modal") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) triggerOpenModal(tabs[0]);
      });
    }
  });
}

const triedODataAuthReqs = new Set();

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.url || (!details.url.includes(":7048/") && !details.url.includes(":7047/"))) {
        callback({});
        return;
      }
      if (triedODataAuthReqs.has(details.requestId)) {
        triedODataAuthReqs.delete(details.requestId);
        callback({ cancel: true });
        return;
      }
      chrome.storage.local.get(["bc_odata_credentials"], (res) => {
        const creds = res && res.bc_odata_credentials;
        if (creds && creds.username && creds.password) {
          triedODataAuthReqs.add(details.requestId);
          setTimeout(() => triedODataAuthReqs.delete(details.requestId), 15000);
          callback({
            authCredentials: {
              username: creds.username,
              password: creds.password
            }
          });
        } else {
          callback({ cancel: true });
        }
      });
    },
    { urls: ["https://*/*"] },
    ["asyncBlocking"]
  );
}
