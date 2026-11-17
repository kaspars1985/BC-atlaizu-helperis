/**
 * BC atlaižu pārvaldnieks - Atlaižu ierakstīšana caur OData un vizuālā iezīmēšana
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const {
    formatBcNumber,
    getTargetDoc,
    escapeHtml,
    showToast,
    getBCDocument,
    extractHeaderCustomerInfo,
    ensureHighlightStyles,
    getDiscountCellForRow
  } = BCM;

  function clearCellHighlight(cell) {
    if (!cell) return;
    try {
      cell.classList.remove("bcm-highlight-cell");
      cell.style.removeProperty("outline");
      cell.style.removeProperty("outline-offset");
      cell.style.removeProperty("background-color");
      cell.style.removeProperty("box-shadow");
      cell.style.removeProperty("z-index");
      Array.from(cell.querySelectorAll("*")).forEach((ch) => {
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
    docs.forEach((d) => {
      try {
        Array.from(d.querySelectorAll(".bcm-highlight-cell")).forEach(clearCellHighlight);
        Array.from(d.querySelectorAll(".bcm-paste-badge")).forEach((b) => b.remove());
      } catch (e) {}
    });
  }

  function rowMatchesItem(row, targetItemCode) {
    if (!row || !targetItemCode) return false;
    const target = targetItemCode.trim().toUpperCase();

    const noCell = row.querySelector('td[controlname="No."], td[controlname="No"], td[controlname="ItemNo"], td[controlname="Item No."], [controlname="No."]');
    if (noCell) {
      const inp = noCell.querySelector("input");
      const val = (inp ? inp.value : (noCell.innerText || noCell.textContent || "")).trim().toUpperCase();
      if (val === target) return true;
    }

    const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
    for (const c of cells) {
      const inp = c.querySelector("input");
      const val = (inp ? inp.value : (c.innerText || c.textContent || "")).trim().toUpperCase();
      if (val === target) return true;
    }

    return false;
  }

  function findRowNow(line, bcDoc) {
    if (!line || !line.itemCode) return null;
    const targetCode = line.itemCode.trim();

    if (line.ariaRowIndex) {
      const g = (line.gridElement && line.gridElement.isConnected) ? line.gridElement : bcDoc;
      const r = g.querySelector(`[aria-rowindex="${line.ariaRowIndex}"]`);
      if (r && rowMatchesItem(r, targetCode)) return r;
    }

    if (line.rowElement && line.rowElement.isConnected) {
      if (rowMatchesItem(line.rowElement, targetCode)) {
        return line.rowElement;
      }
    }

    const grid = (line.rowElement && line.rowElement.isConnected && line.rowElement.closest('table, [role="grid"]')) || line.gridElement;
    const scope = (grid && grid.isConnected) ? grid : bcDoc;
    const rows = Array.from(scope.querySelectorAll('[role="row"], tr'));
    let seen = 0;
    for (const r of rows) {
      if (!rowMatchesItem(r, targetCode)) continue;
      if (seen === (line.ordinal || 0)) return r;
      seen++;
    }

    for (const r of rows) {
      if (rowMatchesItem(r, targetCode)) return r;
    }

    return null;
  }

  function highlightCell(cell) {
    cell.classList.add("bcm-highlight-cell");
    cell.style.setProperty("outline", "4px solid #ff5501", "important");
    cell.style.setProperty("outline-offset", "-2px", "important");
    cell.style.setProperty("background-color", "rgba(255, 85, 1, 0.45)", "important");
    cell.style.setProperty("box-shadow", "0 0 24px rgba(255, 85, 1, 0.95)", "important");
    cell.style.setProperty("z-index", "9999", "important");
    Array.from(cell.querySelectorAll("*")).forEach((ch) => ch.style.setProperty("background-color", "transparent", "important"));
  }

  function sendKey(el, key, keyCode) {
    const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function promptODataCredentials() {
    let savedUser = "";
    try {
      const st = await chrome.storage.local.get(["bc_odata_credentials"]);
      if (st.bc_odata_credentials && st.bc_odata_credentials.username) {
        savedUser = st.bc_odata_credentials.username;
      }
    } catch (e) {}
    return new Promise((resolve) => {
      const targetDoc = getTargetDoc();
      const existing = targetDoc.getElementById("bcm-auth-modal");
      if (existing) existing.remove();

      const wrap = targetDoc.createElement("div");
      wrap.id = "bcm-auth-modal";
      wrap.className = "bcm-modal-overlay";
      wrap.innerHTML = `
        <div class="bcm-modal-card" style="max-width: 420px; padding: 0;">
          <div class="bcm-modal-header">
            <div class="bcm-modal-title-box">
              <div class="bcm-logo-icon">🔑</div>
              <div>
                <h3 class="bcm-modal-title">BC OData pieslēgšanās</h3>
                <div class="bcm-modal-subtitle">Vienreizēja autorizācija momentālai atlaižu ierakstīšanai</div>
              </div>
            </div>
          </div>
          <div style="padding: 18px 22px; display: flex; flex-direction: column; gap: 12px;">
            <div>
              <label style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">BC lietotājvārds:</label>
              <input id="bcm-auth-user" type="text" value="${escapeHtml(savedUser)}" placeholder="DOMĒNS\\lietotājs" style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; box-sizing:border-box;" />
            </div>
            <div>
              <label style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">BC parole:</label>
              <input id="bcm-auth-pass" type="password" placeholder="Ievadiet savu BC paroli..." style="width:100%; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px; box-sizing:border-box;" />
            </div>
          </div>
          <div class="bcm-modal-footer" style="justify-content: flex-end; gap: 8px;">
            <button class="bcm-btn bcm-btn-secondary" id="bcm-auth-cancel">Atcelt</button>
            <button class="bcm-btn bcm-btn-primary" id="bcm-auth-save">Saglabāt un ierakstīt</button>
          </div>
        </div>
      `;
      (targetDoc.body || document.body).appendChild(wrap);
      const passInput = wrap.querySelector("#bcm-auth-pass");
      if (passInput) passInput.focus();

      const finish = (val) => {
        wrap.remove();
        resolve(val);
      };
      wrap.querySelector("#bcm-auth-cancel").addEventListener("click", () => finish(null));
      const submit = async () => {
        const u = wrap.querySelector("#bcm-auth-user").value.trim();
        const p = wrap.querySelector("#bcm-auth-pass").value;
        if (!u || !p) return;
        await chrome.runtime.sendMessage({ action: "SAVE_ODATA_CREDENTIALS", username: u, password: p });
        finish({ username: u, password: p });
      };
      wrap.querySelector("#bcm-auth-save").addEventListener("click", submit);
      wrap.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") finish(null);
      });
    });
  }

  async function executeApplyDiscounts(lines) {
    // Iekļaujam arī rindas, kurām esošā atlaide tika apzināti nodzēsta uz 0%
    const linesToUpdate = lines.filter((l) => l.newDiscount > 0 || (l.newDiscount === 0 && l.currentDiscount > 0));
    const total = linesToUpdate.length;

    if (total === 0) {
      showToast("Nav nevienas rindas ar maināmu atlaidi!", "warning");
      return;
    }

    try {
      const bcDocClip = getBCDocument();
      const discountsText = lines.map((l) => formatBcNumber(l.newDiscount, bcDocClip)).join("\r\n");
      await navigator.clipboard.writeText(discountsText);
    } catch (e) {}

    if (typeof BCM.closeModal === "function") BCM.closeModal();
    BCM.state.bcmBusy = true;

    try {
      const bcDoc = getBCDocument();
      const touchedCells = [];

      try {
        if (bcDoc && bcDoc.activeElement && bcDoc.activeElement !== bcDoc.body) {
          bcDoc.activeElement.blur();
        }
      } catch (e) {}

      const headerInfo = extractHeaderCustomerInfo();
      const orderNo = (lines[0] && lines[0].documentNumber) || headerInfo.orderNo;

      if (!orderNo) {
        showToast("⚠️ Neizdevās noteikt pasūtījuma numuru OData pieprasījumam!", "error");
        return;
      }

      showToast(`⚡ Ieraksta atlaides serverī (${total} rindās)...`, "info");

      const mapUpdates = () => linesToUpdate.map((l) => ({
        id: l.id,
        itemCode: l.itemCode,
        ordinal: l.ordinal || 0,
        newDiscount: l.newDiscount,
        lineNumber: l.lineNumber,
        documentType: l.documentType,
        documentNumber: l.documentNumber
      }));

      let odataRes = await chrome.runtime.sendMessage({
        action: "ODATA_APPLY_DISCOUNTS",
        orderNo,
        updates: mapUpdates()
      });

      if (odataRes && (odataRes.authRequired || odataRes.status === 401 || odataRes.status === 403)) {
        const creds = await promptODataCredentials();
        if (creds) {
          showToast("⚡ Atkārto ierakstīšanu ar jauno autorizāciju...", "info");
          odataRes = await chrome.runtime.sendMessage({
            action: "ODATA_APPLY_DISCOUNTS",
            orderNo,
            updates: mapUpdates()
          });
        }
      }

      if (!odataRes || !odataRes.success) {
        showToast(`⚠️ OData kļūda: ${(odataRes && odataRes.error) || "Neizdevās savienoties ar serveri"}`, "error");
        return;
      }

      const failedSet = new Set(odataRes.failedIds || []);
      const succeededLines = linesToUpdate.filter((l) => !failedSet.has(l.id));

      for (const l of succeededLines) {
        const r = findRowNow(l, bcDoc);
        const c = r && getDiscountCellForRow(r, l, bcDoc);
        if (c) {
          ensureHighlightStyles(c.ownerDocument || bcDoc);
          highlightCell(c);
          touchedCells.push(c);
          const txtVal = formatBcNumber(l.newDiscount, bcDoc);
          if (!c.querySelector("input")) {
            const targetEl = c.querySelector(".stringcontrol-read, span") || c;
            if (targetEl) targetEl.textContent = txtVal;
          }
        }
      }

      try {
        sendKey(bcDoc.activeElement || bcDoc.body, "F5", 116);
      } catch (e) {}

      setTimeout(() => touchedCells.forEach(clearCellHighlight), 1000);
      const onAnyClick = () => {
        touchedCells.forEach(clearCellHighlight);
        clearAllHighlights();
        window.removeEventListener("click", onAnyClick, true);
      };
      window.addEventListener("click", onAnyClick, true);

      if (!odataRes.failedIds || odataRes.failedIds.length === 0) {
        showToast(`✅ Ierakstītas atlaides ${odataRes.updatedCount} no ${total} rindām!`, "success");
      } else {
        const failedLines = linesToUpdate.filter((l) => failedSet.has(l.id));
        const list = failedLines.map((l) => `${l.rowIndex} (${l.itemCode})`).join(", ");
        showToast(`⚠️ Ierakstītas ${odataRes.updatedCount}/${total}. Serveris nepieņēma rindas: ${list} (pārbaudiet, vai rindā nav kļūdas).`, "warning");
      }
    } catch (err) {
      console.error("[BC atlaižu pārvaldnieks] OData apply kļūda:", err);
      showToast(`⚠️ Kļūda ierakstot atlaides: ${err.message || err}`, "error");
    } finally {
      BCM.state.bcmBusy = false;
    }
  }

  function copyDiscountsToClipboard(lines) {
    const bcDocClip = getBCDocument();
    const discountsText = lines.map((l) => formatBcNumber(l.newDiscount !== undefined ? l.newDiscount : (l.currentDiscount || 0), bcDocClip)).join("\r\n");
    navigator.clipboard.writeText(discountsText).then(() => {
      showToast(`📋 Atlaižu kolonna (${lines.length} rindām) nokopēta buferī!`, "success");
    }).catch((err) => {
      console.error("Kļūda kopējot buferī:", err);
      showToast("Neizdevās nokopēt buferī.", "error");
    });
  }

  Object.assign(BCM, {
    promptODataCredentials,
    executeApplyDiscounts,
    copyDiscountsToClipboard
  });
})();
