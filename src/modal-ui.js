/**
 * BC atlaižu pārvaldnieks - Priekšskatījuma modālais logs
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const {
    APP_VERSION,
    isExtensionContextValid,
    getTargetDoc,
    escapeHtml,
    showToast,
    bcmLog,
    getBCDocument,
    extractHeaderCustomerInfo,
    extractSalesLines,
    extractAllSalesLines,
    getClientRulesData,
    matchDiscountsForLines,
    promptODataCredentials,
    executeApplyDiscounts,
    copyDiscountsToClipboard
  } = BCM;

  function closeModal() {
    if (BCM.state.activeModal) {
      BCM.state.activeModal.remove();
      BCM.state.activeModal = null;
    }
  }

  function isLineActionable(l) {
    return l.newDiscount > 0 || (l.newDiscount === 0 && l.currentDiscount > 0);
  }

  async function openDiscountManagerModal(forcedCustomerNo) {
    if (!isExtensionContextValid()) {
      showToast("Paplašinājums tika atjaunināts! Lūdzu, pārlādējiet šo lapu (F5).", "warning");
      return;
    }
    try {
      const targetDoc = getTargetDoc();
      const existingOverlays = Array.from(document.querySelectorAll(".bcm-modal-overlay")).concat(
        targetDoc !== document ? Array.from(targetDoc.querySelectorAll(".bcm-modal-overlay")) : []
      );
      existingOverlays.forEach((o) => o.remove());
      BCM.state.activeModal = null;

      const headerInfo = extractHeaderCustomerInfo();
      if (forcedCustomerNo) {
        headerInfo.relatedCustomerNo = forcedCustomerNo.trim().toUpperCase();
      }

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

      const bcDocForEnv = getBCDocument();
      const hrefSource = (bcDocForEnv && bcDocForEnv.location && bcDocForEnv.location.href) || window.location.href || "";
      let company = "";
      try {
        company = new URL(hrefSource).searchParams.get("company") || "";
      } catch (_) {
        company = "";
      }

      const syncCustomerDiscountsDirect = async (custNo) => {
        const send = () => chrome.runtime.sendMessage({
          action: "FETCH_CUSTOMER_DISCOUNTS_WS",
          customerNo: custNo,
          company
        }).catch((e) => ({ success: false, error: String(e) }));

        let resp = await send();
        if (resp && (resp.authRequired || resp.status === 401 || resp.status === 403)) {
          const creds = await promptODataCredentials();
          if (creds) {
            resp = await send();
          }
        }
        return resp;
      };

      // 1. Nolasām kešotos klienta noteikumus un DOM rindas uzreiz, lai modālis atvērtos momentāni
      let { rules: clientRules, isSynced } = await getClientRulesData(headerInfo.relatedCustomerNo);
      let knownGroupCodes = new Set((clientRules || []).filter((r) => /grup|disc|atlai/i.test(r.type || "") && r.code).map((r) => String(r.code).trim().toUpperCase()));
      const rawLines = extractSalesLines(knownGroupCodes);
      let lines = await matchDiscountsForLines(rawLines.slice(), headerInfo.relatedCustomerNo);
      lines.odataLoaded = false;
      lines.hasDiscountColumn = rawLines.hasDiscountColumn;
      lines.hasGroupColumn = rawLines.hasGroupColumn;

      let updateInfo = null;
      let pendingUpdate = null;
      try {
        const stored = await chrome.storage.local.get(["bcm_update_info", "bcm_pending_update"]);
        updateInfo = stored.bcm_update_info;
        pendingUpdate = stored.bcm_pending_update || null;
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
          <tr data-line-id="${escapeHtml(l.id)}">
            <td class="bcm-row-num">${l.rowIndex}</td>
            <td class="bcm-item-code">${escapeHtml(l.itemCode)}</td>
            <td class="bcm-item-desc" title="${escapeHtml(l.description)}">${escapeHtml(l.description)}</td>
            <td style="text-align: center; font-weight: 600;">${l.qty}</td>
            <td style="text-align: center; color: var(--bcm-text-muted);">${l.currentDiscount > 0 ? l.currentDiscount + "%" : "0%"}</td>
            <td style="text-align: center;">
              <input
                type="number"
                step="0.5"
                min="0"
                max="100"
                class="bcm-discount-input ${l.status === "new" ? "highlight-new" : l.status === "overwritten" ? "highlight-warn" : ""}"
                value="${l.newDiscount}"
                data-idx="${idx}"
              />
            </td>
            <td>
              <span style="font-size: 12px; color: #4b5563;">${escapeHtml(l.matchedReason)}</span>
            </td>
            <td>
              ${l.status === "new" ? '<span class="bcm-badge item-match">✓ Jauna atlaide</span>' :
                l.status === "overwritten" ? '<span class="bcm-badge warn-overwrite">⚠️ Pārrakstīs</span>' :
                '<span class="bcm-badge no-match">— Standarta</span>'}
            </td>
          </tr>
        `).join("");
      };

      const needsBgSync = Boolean(headerInfo.orderNo || (headerInfo.relatedCustomerNo && !isSynced));
      const totalLines = lines.length;
      const withDiscount = lines.filter(isLineActionable).length;
      const overwritten = lines.filter((l) => l.status === "overwritten").length;
      const noDiscount = lines.filter((l) => l.status === "nodisc").length;

      const modal = targetDoc.createElement("div");
      modal.className = "bcm-modal-overlay";
      modal.innerHTML = `
        <div class="bcm-modal-card">
          <div class="bcm-modal-header">
            <div class="bcm-modal-title-box">
              <div class="bcm-logo-icon">⚡</div>
              <div>
                <h3 class="bcm-modal-title" style="display: flex; align-items: center; gap: 8px;">
                  <span>BC atlaižu pārvaldnieks <small style="font-weight:600;opacity:0.75;">v${APP_VERSION}</small></span>
                  ${updateInfo && updateInfo.hasUpdate ? `<a href="${escapeHtml(updateInfo.releaseUrl)}" target="_blank" style="text-decoration: none; font-size: 11px; background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; padding: 2px 7px; border-radius: 12px; font-weight: 600;">🚀 Pieejama v${escapeHtml(updateInfo.latestVersion)}</a>` : ""}
                </h3>
                <div class="bcm-modal-subtitle">Pasūtījums: ${escapeHtml(headerInfo.orderNo || "Pārdošanas pasūtījums")}${headerInfo.customerName ? " · " + escapeHtml(headerInfo.customerName) : ""}</div>
              </div>
            </div>
            <button class="bcm-close-btn" id="bcm-modal-close" title="Aizvērt logu">✕</button>
          </div>

          <div id="bcm-applied-update-banner" style="${pendingUpdate ? "display: flex;" : "display: none;"} align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 20px 10px 20px; padding: 10px 14px; background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #065f46;">
              <span style="font-size: 18px;">♻️</span>
              <span id="bcm-applied-update-text">
                <strong>Jaunā versija v${escapeHtml((pendingUpdate && pendingUpdate.diskVersion) || "")} jau ielādēta diskā.</strong> (Darbojas v${APP_VERSION})
              </span>
            </div>
            <button class="bcm-btn bcm-btn-primary" id="bcm-apply-update-btn" style="padding: 4px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; background: #059669; width: auto; margin: 0;" title="Pārlādēt Business Central lapu un paplašinājumu (pasūtījums paliek serverī, dati netiek pazaudēti)">
              ↻ Pārlādēt tagad
            </button>
          </div>

          <div id="bcm-update-banner-box" style="${updateInfo && updateInfo.hasUpdate && !pendingUpdate ? "display: block;" : "display: none;"} margin: 0 20px 10px 20px; padding: 10px 14px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #9a3412;">
                <span style="font-size: 18px;">🚀</span>
                <span id="bcm-update-banner-text"><strong>Pieejams atjauninājums: v${escapeHtml((updateInfo && updateInfo.latestVersion) || "")}!</strong> (Jums pašlaik ir v${APP_VERSION})</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <a id="bcm-update-download-btn" href="${escapeHtml((updateInfo && (updateInfo.downloadUrl || updateInfo.releaseUrl)) || "")}" target="_blank" class="bcm-btn bcm-btn-primary" style="padding: 4px 12px; font-size: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; background: #ea580c; width: auto; margin: 0;">
                  📥 Lejupielādēt .zip
                </a>
                <a id="bcm-update-changelog-btn" href="${escapeHtml((updateInfo && updateInfo.releaseUrl) || "")}" target="_blank" style="font-size: 12px; color: #c2410c; text-decoration: underline;">
                  Skatīt izmaiņas
                </a>
              </div>
            </div>
          </div>

          <div class="bcm-client-banner">
            <div class="bcm-client-meta">
              <div class="bcm-meta-pill" style="display: flex; align-items: center; gap: 6px;">
                <span class="bcm-meta-label">Saistītais klients:</span>
                <input
                  type="text"
                  id="bcm-client-no-input"
                  value="${escapeHtml(headerInfo.relatedCustomerNo || "")}"
                  placeholder="Klienta kods"
                  style="padding: 2px 7px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: 700; width: 100px; font-size: 12px; text-transform: uppercase;"
                  title="Ievadiet vai mainiet saistītā klienta kodu"
                />
                <button class="bcm-btn bcm-btn-secondary" id="bcm-apply-client-btn" style="padding: 2px 8px; font-size: 11px; margin: 0; width: auto;" title="Pārrēķināt atlaides ar šo klientu">Pielietot</button>
                ${headerInfo.relatedCustomerName ? `<span class="bcm-meta-val">(${escapeHtml(headerInfo.relatedCustomerName)})</span>` : ""}
              </div>
              ${headerInfo.customerNo ? `
                <div class="bcm-meta-pill">
                  <span class="bcm-meta-label">Rēķina klients:</span>
                  <span class="bcm-meta-val">${escapeHtml(headerInfo.customerNo)}</span>
                </div>
              ` : ""}
              <div class="bcm-meta-pill">
                <span class="bcm-meta-label">Kešotie noteikumi:</span>
                <span class="bcm-meta-val ${isSynced ? "" : "highlight"}" id="bcm-cached-rules-pill">
                  ${isSynced ? (clientRules.length > 0 ? `${clientRules.length} atlaides` : "0 (Standarta cenas)") : (needsBgSync ? "⏳ Ielasa..." : "Nav kešā")}
                </span>
              </div>
            </div>

            <div>
              <button class="bcm-btn ${isSynced ? "bcm-btn-secondary" : "bcm-btn-primary"}" id="bcm-refresh-discounts-btn" style="padding: 6px 14px; font-size: 12.5px; margin: 0; width: auto;" title="Atvērt Page 7004, nofiltrēt un ielasīt klienta atlaides">
                🔄 ${isSynced ? "Atjaunot klienta atlaides" : "Ielasīt klienta atlaides"}
              </button>
            </div>
          </div>

          <div class="bcm-summary-bar">
            <span class="bcm-chip total">Kopā rindas: ${totalLines}</span>
            <span class="bcm-chip matched">Ar atlaidi: ${withDiscount}</span>
            ${overwritten > 0 ? `<span class="bcm-chip overwritten">⚠️ Mainītas esošās: ${overwritten}</span>` : ""}
            <span class="bcm-chip nodisc">Bez atlaides: ${noDiscount}</span>
            ${needsBgSync ? `<span class="bcm-chip" id="bcm-odata-sync-chip" style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;">⏳ Sinhronizē ar BC...</span>` : ""}
            <button class="bcm-btn bcm-btn-secondary" id="bcm-scan-all-lines-btn" style="padding: 2px 9px; font-size: 11px; margin-left: auto; width: auto; display: inline-flex; align-items: center; gap: 4px;" title="Ritina pasūtījuma rindu tabulu, lai nolasītu un pievienotu visas rindas">
              <span>🔍</span> Ielasīt visas rindas (ritināt)
            </button>
          </div>

          <div id="bcm-missing-col-banner" style="display: none; margin: 0 20px 10px 20px; padding: 10px 14px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; color: #92400e; font-size: 12.5px; line-height: 1.45;"></div>

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

          <div class="bcm-progress-box" id="bcm-progress-box">
            <div class="bcm-progress-label">
              <span id="bcm-progress-text">Ieraksta atlaides pasūtījumā...</span>
              <span id="bcm-progress-percent">0%</span>
            </div>
            <div class="bcm-progress-track">
              <div class="bcm-progress-bar" id="bcm-progress-bar"></div>
            </div>
          </div>

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
      BCM.state.activeModal = modal;

      try {
        chrome.runtime.sendMessage({ action: "CHECK_FOR_UPDATES" }, (res) => {
          if (chrome.runtime.lastError) return;
          const info = res && res.updateInfo;
          if (info && info.hasUpdate && BCM.state.activeModal) {
            const box = BCM.state.activeModal.querySelector("#bcm-update-banner-box");
            const txt = BCM.state.activeModal.querySelector("#bcm-update-banner-text");
            const dl = BCM.state.activeModal.querySelector("#bcm-update-download-btn");
            const cl = BCM.state.activeModal.querySelector("#bcm-update-changelog-btn");
            if (box) box.style.display = "block";
            if (txt) txt.innerHTML = `<strong>Pieejams atjauninājums: v${escapeHtml(info.latestVersion)}!</strong> (Jums pašlaik ir v${APP_VERSION})`;
            if (dl) dl.href = info.downloadUrl || info.releaseUrl;
            if (cl) cl.href = info.releaseUrl;
          }
        });
      } catch (e) {}

      const updateColumnWarnings = (curLines, scanCompleted) => {
        const banner = modal.querySelector("#bcm-missing-col-banner");
        if (!banner) return;
        const hasGroupRules = (clientRules || []).some((r) => /grup|disc|atlai/i.test(r.type || ""));
        const hasDiscCol = !!(curLines.hasDiscountColumn || curLines.some((l) => !!l.discountCell));
        const hasGrpCol = !!(curLines.hasGroupColumn || curLines.some((l) => !!l.groupCode));

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

      const showAppliedUpdateBanner = (pending) => {
        if (!pending || !BCM.state.activeModal) return;
        const box = BCM.state.activeModal.querySelector("#bcm-applied-update-banner");
        const txt = BCM.state.activeModal.querySelector("#bcm-applied-update-text");
        const zipBox = BCM.state.activeModal.querySelector("#bcm-update-banner-box");
        if (box) box.style.display = "flex";
        if (zipBox) zipBox.style.display = "none";
        if (txt) txt.innerHTML = `<strong>Jaunā versija v${escapeHtml(pending.diskVersion)} jau ielādēta diskā.</strong> (Darbojas v${APP_VERSION})`;
      };

      const applyUpdateBtn = modal.querySelector("#bcm-apply-update-btn");
      if (applyUpdateBtn) {
        applyUpdateBtn.addEventListener("click", () => {
          const ok = typeof window.confirm === "function"
            ? window.confirm("Pārlādīt Business Central lapu un paplašinājumu uz jauno versiju?\n\nPasūtījums paliek serverī — nekādi ievadītie dati netiks pazaudēti.")
            : true;
          if (!ok) return;
          applyUpdateBtn.disabled = true;
          applyUpdateBtn.textContent = "Pārlādē...";
          showToast("Paplašinājums tiek atjaunināts — lapa drīz pārlādēsies.", "info");
          try {
            chrome.runtime.sendMessage({ action: "APPLY_PENDING_UPDATE" }, () => {
              void chrome.runtime.lastError;
            });
          } catch (e) {}
        });
      }

      try {
        chrome.runtime.sendMessage({ action: "CHECK_APPLIED_UPDATE" }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.pending) showAppliedUpdateBanner(res.pending);
        });
      } catch (e) {}

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

      const attachReloadListener = () => {
        const reloadLinesBtn = modal.querySelector("#bcm-reload-lines-btn");
        if (reloadLinesBtn) {
          reloadLinesBtn.addEventListener("click", () => {
            openDiscountManagerModal(headerInfo.relatedCustomerNo);
          });
        }
      };
      attachReloadListener();

      const updateModalSummaryAndButton = (showSyncingChip = false) => {
        const actionableCount = lines.filter(isLineActionable).length;
        const applyBtn = modal.querySelector("#bcm-apply-btn");
        if (applyBtn) {
          applyBtn.textContent = `⚡ Automātiski ierakstīt (${actionableCount})`;
          applyBtn.disabled = actionableCount === 0;
        }
        const summaryBar = modal.querySelector(".bcm-summary-bar");
        if (summaryBar) {
          const overwCount = lines.filter((l) => l.status === "overwritten").length;
          const noDiscCount = lines.filter((l) => l.newDiscount === 0).length;
          summaryBar.innerHTML = `
            <span class="bcm-chip total">Kopā rindas: ${lines.length}</span>
            <span class="bcm-chip matched">Ar atlaidi: ${lines.filter((l) => l.newDiscount > 0).length}</span>
            ${overwCount > 0 ? `<span class="bcm-chip overwritten">⚠️ Mainītas esošās: ${overwCount}</span>` : ""}
            <span class="bcm-chip nodisc">Bez atlaides: ${noDiscCount}</span>
            ${showSyncingChip ? `<span class="bcm-chip" id="bcm-odata-sync-chip" style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;">⏳ Sinhronizē ar BC...</span>` : ""}
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
        modal.querySelectorAll(".bcm-discount-input").forEach((input) => {
          input.addEventListener("focus", (e) => {
            const raw = e.target.value.trim();
            if (raw === "0" || parseFloat(raw) === 0) {
              e.target.value = "";
            } else {
              e.target.select();
            }
          });
          input.addEventListener("blur", (e) => {
            if (e.target.value.trim() === "") {
              const idx = parseInt(e.target.dataset.idx, 10);
              const cur = (lines[idx] && lines[idx].newDiscount) ? lines[idx].newDiscount : 0;
              e.target.value = String(cur);
            }
          });
          input.addEventListener("input", (e) => {
            const idx = parseInt(e.target.dataset.idx, 10);
            let val = parseFloat(e.target.value);
            if (isNaN(val) || val < 0) val = 0;
            if (val > 100) {
              val = 100;
              e.target.value = "100";
            }
            lines[idx].newDiscount = val;
            const rowEl = modal.querySelector(`tr[data-line-id="${lines[idx].id}"]`);
            if (val > 0) {
              lines[idx].status = (lines[idx].currentDiscount > 0 && lines[idx].currentDiscount !== val) ? "overwritten" : "new";
              lines[idx].matchedReason = "Ievadīts manuāli";
            } else {
              lines[idx].status = lines[idx].currentDiscount > 0 ? "overwritten" : "nodisc";
              lines[idx].matchedReason = lines[idx].currentDiscount > 0 ? "Atlaide noņemta (0%)" : "Bez atlaides (0%)";
            }
            if (rowEl) {
              const badgeCell = rowEl.cells[7];
              if (badgeCell) {
                badgeCell.innerHTML = lines[idx].status === "new" ? '<span class="bcm-badge item-match">✓ Jauna atlaide</span>' :
                  lines[idx].status === "overwritten" ? '<span class="bcm-badge warn-overwrite">⚠️ Pārrakstīs</span>' :
                  '<span class="bcm-badge no-match">— Standarta</span>';
              }
              const reasonCell = rowEl.cells[6];
              if (reasonCell) {
                reasonCell.innerHTML = `<span style="font-size: 12px; color: #4b5563;">${escapeHtml(lines[idx].matchedReason)}</span>`;
              }
            }
            updateModalSummaryAndButton(false);
          });
        });
      };
      bindDiscountInputs();

      const bindScanAllBtn = () => {
        const scanAllBtn = modal.querySelector("#bcm-scan-all-lines-btn");
        if (!scanAllBtn) return;
        scanAllBtn.addEventListener("click", async () => {
          if (!lines.odataLoaded) {
            scanAllBtn.disabled = true;
            try {
              const allExtracted = await extractAllSalesLines(null, knownGroupCodes);
              const matchedAll = await matchDiscountsForLines(allExtracted, headerInfo.relatedCustomerNo);
              lines.length = 0;
              matchedAll.forEach((l) => lines.push(l));
              lines.hasDiscountColumn = allExtracted.hasDiscountColumn;
              lines.hasGroupColumn = allExtracted.hasGroupColumn;
              const tbody = modal.querySelector("#bcm-table-body");
              if (tbody) tbody.innerHTML = renderTableRows(lines);
              bindDiscountInputs();
              attachReloadListener();
              updateModalSummaryAndButton(false);
              updateColumnWarnings(lines, true);
            } catch (e) {
              console.warn("[BC Atlaižu Helperis] Scan-all kļūda:", e);
            } finally {
              scanAllBtn.disabled = false;
            }
            return;
          }
          openDiscountManagerModal(headerInfo.relatedCustomerNo);
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
        const refreshBtn = modal.querySelector("#bcm-refresh-discounts-btn");
        const origHtml = refreshBtn ? refreshBtn.innerHTML : "";
        if (refreshBtn) {
          refreshBtn.disabled = true;
          refreshBtn.style.opacity = "0.7";
          refreshBtn.innerHTML = "⏳ Ielasa atlaides...";
        }

        const wsRes = await syncCustomerDiscountsDirect(targetCust);
        if (wsRes && wsRes.success) {
          if (wsRes.count > 0) {
            showToast(`✓ Klienta ${targetCust} atlaides (${wsRes.count} noteikumi) ielasītas!`, "success");
          } else {
            showToast(`ℹ️ Klientam ${targetCust} Business Central nav konfigurētu atlaižu (0 noteikumi).`, "info");
          }
          openDiscountManagerModal(targetCust);
          return;
        }

        if (wsRes && (wsRes.authRequired || wsRes.status === 401 || wsRes.status === 403)) {
          if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.style.opacity = "1";
            refreshBtn.innerHTML = origHtml;
          }
          return;
        }

        showToast(`⚡ Fona sinhronizācija: nolasa klienta ${targetCust} atlaides no BC...`, "info");
        chrome.runtime.sendMessage({
          action: "START_CUSTOMER_SYNC",
          customerNo: targetCust,
          company
        });
      });

      modal.querySelector("#bcm-apply-btn").addEventListener("click", async () => {
        await executeApplyDiscounts(lines);
      });

      // Fona sinhronizācija (klienta atlaides + OData rindas) bez modāļa atvēršanas aiztures
      if (needsBgSync) {
        (async () => {
          try {
            const tasks = [];
            if (headerInfo.relatedCustomerNo && !isSynced) {
              tasks.push((async () => {
                const autoWs = await syncCustomerDiscountsDirect(headerInfo.relatedCustomerNo);
                if (autoWs && autoWs.success) {
                  ({ rules: clientRules, isSynced } = await getClientRulesData(headerInfo.relatedCustomerNo));
                  knownGroupCodes = new Set((clientRules || []).filter((r) => /grup|disc|atlai/i.test(r.type || "") && r.code).map((r) => String(r.code).trim().toUpperCase()));
                }
              })());
            }

            let odataRes = null;
            if (headerInfo.orderNo) {
              tasks.push((async () => {
                odataRes = await chrome.runtime.sendMessage({
                  action: "ODATA_GET_ORDER_LINES",
                  orderNo: headerInfo.orderNo,
                  company
                }).catch(() => null);

                if (odataRes && (odataRes.authRequired || odataRes.status === 401 || odataRes.status === 403)) {
                  const creds = await promptODataCredentials();
                  if (creds) {
                    odataRes = await chrome.runtime.sendMessage({
                      action: "ODATA_GET_ORDER_LINES",
                      orderNo: headerInfo.orderNo,
                      company
                    }).catch(() => null);
                  }
                }
              })());
            }

            await Promise.all(tasks);
            if (BCM.state.activeModal !== modal) return;

            if (odataRes && odataRes.success && Array.isArray(odataRes.lines) && odataRes.lines.length > 0) {
              const odataItems = odataRes.lines.filter((r) => r.type === "Item" && r.number);
              if (odataItems.length > 0) {
                const odataCodeCounts = {};
                const odataEnriched = [];

                for (const oRow of odataItems) {
                  const code = String(oRow.number || "").trim().toUpperCase();
                  const ord = odataCodeCounts[code] || 0;
                  odataCodeCounts[code] = ord + 1;

                  const domLine = rawLines.find((l) => String(l.itemCode || "").trim().toUpperCase() === code && (l.ordinal || 0) === ord);

                  if (domLine) {
                    domLine.lineNumber = oRow.lineNumber;
                    domLine.documentType = oRow.documentType;
                    domLine.documentNumber = oRow.documentNumber;
                    domLine.description = oRow.description || domLine.description || "";
                    domLine.qty = Number(oRow.quantity) || domLine.qty || 1;
                    if (typeof oRow.itemDiscGroup === "string") {
                      domLine.itemDiscGroup = oRow.itemDiscGroup;
                      domLine.groupCode = oRow.itemDiscGroup;
                    } else {
                      domLine.itemDiscGroup = oRow.itemDiscGroup || domLine.itemDiscGroup || "";
                      domLine.groupCode = domLine.itemDiscGroup || domLine.groupCode || "";
                    }
                    domLine.itemCategoryCode = oRow.itemCategoryCode || domLine.itemCategoryCode || "";
                    domLine.uom = domLine.uom || oRow.unitOfMeasureCode || oRow.unitOfMeasure || "";
                    domLine.currentDiscount = Number(oRow.lineDiscountPercent) || domLine.currentDiscount || 0;
                    odataEnriched.push(domLine);
                  } else {
                    odataEnriched.push({
                      id: `line_odata_${oRow.lineNumber}_${code}`,
                      rowIndex: odataEnriched.length + 1,
                      itemCode: oRow.number,
                      description: oRow.description || "",
                      qty: Number(oRow.quantity) || 1,
                      uom: oRow.unitOfMeasureCode || oRow.unitOfMeasure || "",
                      groupCode: oRow.itemDiscGroup || "",
                      itemDiscGroup: oRow.itemDiscGroup || "",
                      itemCategoryCode: oRow.itemCategoryCode || "",
                      currentDiscount: Number(oRow.lineDiscountPercent) || 0,
                      newDiscount: Number(oRow.lineDiscountPercent) || 0,
                      lineNumber: oRow.lineNumber,
                      documentType: oRow.documentType,
                      documentNumber: oRow.documentNumber,
                      ordinal: ord,
                      matchedReason: "Gaida aprēķinu",
                      status: "idle"
                    });
                  }
                }

                rawLines.length = 0;
                odataEnriched.forEach((l, idx) => {
                  l.rowIndex = idx + 1;
                  rawLines.push(l);
                });
                rawLines.hasDiscountColumn = true;
                rawLines.hasGroupColumn = true;
                rawLines.odataLoaded = true;
              }
            }

            const updated = await matchDiscountsForLines(rawLines.slice(), headerInfo.relatedCustomerNo);
            lines.length = 0;
            updated.forEach((l) => lines.push(l));
            lines.odataLoaded = rawLines.odataLoaded;
            lines.hasDiscountColumn = rawLines.hasDiscountColumn;
            lines.hasGroupColumn = rawLines.hasGroupColumn;

            const pill = modal.querySelector("#bcm-cached-rules-pill");
            if (pill) {
              pill.className = `bcm-meta-val ${isSynced ? "" : "highlight"}`;
              pill.textContent = isSynced ? (clientRules.length > 0 ? `${clientRules.length} atlaides` : "0 (Standarta cenas)") : "Nav kešā";
            }

            const tbody = modal.querySelector("#bcm-table-body");
            if (tbody) tbody.innerHTML = renderTableRows(lines);
            bindDiscountInputs();
            attachReloadListener();
            updateModalSummaryAndButton(false);
            if (!lines.odataLoaded) updateColumnWarnings(lines, true);
          } catch (e) {
            console.warn("[BC Atlaižu Helperis] Fona OData ielādes kļūda:", e);
            updateModalSummaryAndButton(false);
          }
        })();
      } else {
        updateColumnWarnings(lines, true);
      }

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

  Object.assign(BCM, {
    openDiscountManagerModal,
    closeModal
  });
})();
