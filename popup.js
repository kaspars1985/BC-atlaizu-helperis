/**
 * BC Menedžera Palīgs - Popup Script
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
});

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
