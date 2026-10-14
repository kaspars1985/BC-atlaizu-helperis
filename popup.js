/**
 * BC Atlaižu Helperis - Popup Script
 */

document.addEventListener("DOMContentLoaded", () => {
  // Parādām aktuālo versiju no manifesta
  try {
    const manifest = chrome.runtime.getManifest();
    const versionEl = document.getElementById("header-version-text");
    if (versionEl && manifest) {
      versionEl.textContent = `AM Furnitūra · v${manifest.version}`;
    }
  } catch (e) {}

  loadCachedClients();

  // Poga: Atvērt atlaižu pārvaldnieku pasūtījumā
  const openModalBtn = document.getElementById("open-modal-in-page-btn");
  if (openModalBtn) {
    openModalBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab) return;

        // Vispirms mēģinām nosūtīt ziņojumu tieši
        chrome.tabs.sendMessage(activeTab.id, { action: "OPEN_DISCOUNT_MODAL" }, (res) => {
          if (chrome.runtime.lastError) {
            // Ja content script vēl nav ielādēts vai ir novecojis pēc reload, injicējam to tieši
            if (activeTab.url && activeTab.url.includes("amfbc.amf.lv")) {
              chrome.scripting.insertCSS({
                target: { tabId: activeTab.id },
                files: ["styles.css"]
              }).catch(() => {});

              chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ["content.js"]
              }, () => {
                if (chrome.runtime.lastError) {
                  alert("Lūdzu, nospiediet F5 Business Central lapā un mēģiniet vēlreiz!");
                } else {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(activeTab.id, { action: "OPEN_DISCOUNT_MODAL" }, () => {
                      window.close();
                    });
                  }, 250);
                }
              });
            } else {
              alert("Lūdzu, pārejiet uz Business Central pasūtījuma (Page 42) cilni un mēģiniet vēlreiz!");
            }
          } else {
            window.close();
          }
        });
      });
    });
  }

  // Poga: Atvērt Page 7004
  document.getElementById("open-page7004-btn").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && activeTab.url && activeTab.url.includes("amfbc.amf.lv")) {
        chrome.tabs.sendMessage(activeTab.id, { action: "GET_HEADER_INFO" }, (res) => {
          const custNo = res && res.relatedCustomerNo ? res.relatedCustomerNo.trim().toUpperCase() : "";
          if (custNo) {
            const filterParam = encodeURIComponent(`'Sales Code' IS '${custNo}'`);
            chrome.tabs.create({ url: `https://amfbc.amf.lv:8443/AMF/?company=AM%20Furnit%C5%ABra%20EUR&page=7004&filter=${filterParam}` });
          } else {
            chrome.tabs.create({ url: "https://amfbc.amf.lv:8443/AMF/?company=AM%20Furnit%C5%ABra%20EUR&page=7004" });
          }
        });
      } else {
        chrome.tabs.create({ url: "https://amfbc.amf.lv:8443/AMF/?company=AM%20Furnit%C5%ABra%20EUR&page=7004" });
      }
    });
  });

  // Poga: Iztīrīt kešu
  document.getElementById("clear-cache-btn").addEventListener("click", () => {
    if (confirm("Vai tiešām vēlaties notīrīt visu saglabāto klientu atlaižu kešatmiņu?")) {
      chrome.storage.local.set({ bc_client_discounts: {} }, () => {
        loadCachedClients();
      });
    }
  });

  // Versijas pārbaudes inicializācija (automātiskā un manuālā)
  initVersionChecker();
});

function initVersionChecker() {
  const currentVersion = chrome.runtime.getManifest().version;
  const currentLabel = document.getElementById("version-current-label");
  const lastCheckedLabel = document.getElementById("version-last-checked-label");
  const checkBtn = document.getElementById("check-updates-btn");
  const statusEl = document.getElementById("version-check-status");
  const banner = document.getElementById("update-banner");
  const bannerTag = document.getElementById("update-version-tag");
  const bannerBtn = document.getElementById("update-download-btn");

  if (currentLabel) {
    currentLabel.textContent = `Versija: v${currentVersion}`;
  }

  const renderInfo = (info) => {
    if (!info) return;
    if (lastCheckedLabel && info.lastChecked) {
      lastCheckedLabel.textContent = `Pēdējā pārbaude: ${formatCheckTime(info.lastChecked)}`;
    }

    if (info.hasUpdate) {
      if (banner && bannerTag && bannerBtn) {
        bannerTag.textContent = `v${info.latestVersion}`;
        bannerBtn.href = info.releaseUrl || "https://github.com/kaspars1985/BC-atlaizu-helperis/releases";
        banner.style.display = "block";
      }
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.innerHTML = `
          <div style="color: #c2410c; font-weight: 600; margin-bottom: 4px;">🚀 Pieejama jaunāka versija: v${info.latestVersion}!</div>
          <div style="display: flex; gap: 8px;">
            <a href="${info.releaseUrl}" target="_blank" style="color: #ff5501; text-decoration: underline; font-weight: 500;">Skatīt laaidienu</a> · 
            <a href="${info.downloadUrl}" target="_blank" style="color: #ff5501; text-decoration: underline; font-weight: 500;">Lejupielādēt .zip</a>
          </div>
        `;
      }
    } else {
      if (banner) banner.style.display = "none";
      if (statusEl && statusEl.dataset.manualCheck === "true") {
        statusEl.style.display = "block";
        statusEl.innerHTML = `<span style="color: #15803d; font-weight: 600;">✓ Jums ir jaunākā versija (v${currentVersion})!</span>`;
      }
    }
  };

  // 1. Vispirms ielādējam esošo statusu no keša
  chrome.storage.local.get(["bcm_update_info"], (data) => {
    if (data.bcm_update_info) {
      renderInfo(data.bcm_update_info);
    }
  });

  // 2. Fonā veicam kluso automātisko pārbaudi (ja pagājušas 4h)
  chrome.runtime.sendMessage({ action: "CHECK_FOR_UPDATES", force: false }, (res) => {
    if (res && res.updateInfo) {
      renderInfo(res.updateInfo);
    }
  });

  // 3. Manuālā pārbaude pēc pogas nospiešanas
  if (checkBtn) {
    checkBtn.addEventListener("click", () => {
      const origText = checkBtn.innerHTML;
      checkBtn.disabled = true;
      checkBtn.innerHTML = "⏳ Pārbauda...";
      if (statusEl) {
        statusEl.dataset.manualCheck = "true";
        statusEl.style.display = "block";
        statusEl.innerHTML = "<span style='color: #64748b;'>Meklē jaunāko versiju GitHub...</span>";
      }

      chrome.runtime.sendMessage({ action: "CHECK_FOR_UPDATES", force: true }, (res) => {
        checkBtn.disabled = false;
        checkBtn.innerHTML = origText;
        if (res && res.updateInfo) {
          renderInfo(res.updateInfo);
        } else {
          if (statusEl) {
            statusEl.innerHTML = "<span style='color: #dc2626;'>Neizdevās sazināties ar GitHub. Pārbaudiet interneta pieslēgumu.</span>";
          }
        }
      });
    });
  }
}

function formatCheckTime(ts) {
  if (!ts) return "—";
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return "Tikko";
  if (diffSec < 3600) return `Pirms ${Math.floor(diffSec / 60)} min.`;
  const d = new Date(ts);
  return `${d.toLocaleDateString("lv-LV")} ${d.toLocaleTimeString("lv-LV", { hour: "2-digit", minute: "2-digit" })}`;
}

function loadCachedClients() {
  const listEl = document.getElementById("client-list");
  if (!listEl) return;

  chrome.storage.local.get(["bc_client_discounts"], (data) => {
    const clients = data.bc_client_discounts || {};
    const keys = Object.keys(clients);

    if (keys.length === 0) {
      listEl.innerHTML = '<li class="empty-text">Kešatmiņā vēl nav saglabātu klientu atlaižu. Tās tiks automātiski ielasītas no Page 7004.</li>';
      return;
    }

    listEl.innerHTML = keys.map(k => {
      const count = Array.isArray(clients[k]) ? clients[k].length : 0;
      return `
        <li class="client-item">
          <span class="client-code">${escapeHtml(k)}</span>
          <span class="client-count">${count} noteikumi</span>
        </li>
      `;
    }).join("");
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
