/**
 * BC atlaižu pārvaldnieks - Business Central DOM analīze un rindu nolasīšana
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const { sleep, isDateString, parseNum, bcmLog } = BCM;

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

  function getBCDocument() {
    const docs = getAllBCDocuments();
    for (const d of docs) {
      try {
        if (
          d.querySelector(".ms-nav-listpartform") ||
          d.querySelector(".ms-nav-collapsible-part") ||
          d.querySelector('[role="grid"]') ||
          d.querySelector(".ms-nav-grid") ||
          d.querySelector("table.ms-nav-grid") ||
          d.querySelector('[role="dialog"]')
        ) {
          return d;
        }
      } catch (e) {}
    }
    for (const d of docs) {
      try {
        if (d.querySelector("table") || (d.body && d.body.innerText.length > 100)) {
          return d;
        }
      } catch (e) {}
    }
    return document;
  }

  function getNearbyLabelText(el) {
    let label = "";
    if (el.labels && el.labels.length) {
      label = Array.from(el.labels).map((l) => l.innerText).join(" ");
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

  function normHeaderCaption(el) {
    if (!el) return "";
    const raw = (el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "");
    return String(raw)
      .replace(/\u00AD/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

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

  function findSalesLinesListPart(bcDoc) {
    const docs = [];
    if (bcDoc) docs.push(bcDoc);
    try {
      const all = getAllBCDocuments();
      for (const d of all) if (d && d !== bcDoc) docs.push(d);
    } catch (e) {}

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

    const filtered = candidates.filter((c) => {
      if (isInsideFactBox(c)) return false;
      const headerText = normHeaderCaption(c);
      if (headerText.includes("faila paplašinājums")) return false;
      return true;
    });

    let best = null;
    let bestScore = 0;
    for (const c of filtered) {
      let score = 0;

      if (c.querySelector('[controlname="No."], [controlname="Line Discount %"], [controlname="Quantity"], [controlname="ShortcutDimCode6"]')) {
        score += 50;
      }

      try {
        const headerCells = Array.from(c.querySelectorAll('th, [role="columnheader"]'));
        const headerText = headerCells.map((h) => normHeaderCaption(h)).join(" ");
        const hasCode = /\bnr\.?\b|\bno\.?\b|artikuls/i.test(headerText);
        const hasOther = /apraksts|description|daudzums|quantity|rind.*atlaid|line\s*disc|vienības\s*cena/i.test(headerText);
        if (hasCode && hasOther) score += 35;
      } catch (e) {}

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
      } catch (e) {}

      if (c.querySelector('table.ms-nav-grid-data-table, [role="grid"]')) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best && bestScore > 0) return best;

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
      const titleMatch = ((d.title || "") + " " + (document.title || "")).match(/\b((?:PPAS|AV)[0-9]+)\b/i);
      if (titleMatch && !info.orderNo) info.orderNo = titleMatch[1].toUpperCase();

      if (!info.orderNo) {
        const headings = Array.from(d.querySelectorAll('.ms-nav-layout-head-caption, [role="heading"]'));
        for (const h of headings) {
          const txt = (h.innerText || h.textContent || "").trim();
          const m = txt.match(/\b((?:PPAS|AV)[0-9]+)\b/i) || txt.match(/[∙•]\s*([A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)/);
          if (m && m[1]) {
            info.orderNo = m[1].toUpperCase();
            break;
          }
        }
      }

      if (!info.orderNo) {
        const salesPart = findSalesLinesListPart(d);
        const noControls = Array.from(d.querySelectorAll('[controlname="No."], [controlname="No"]'));
        for (const nc of noControls) {
          if (salesPart && salesPart.contains(nc)) continue;
          if (isInsideFactBox(nc)) continue;
          const inp = nc.querySelector("input, .ms-nav-edit-control") || nc;
          const val = (inp.value || inp.innerText || "").trim();
          if (val && !/nr\.?$/i.test(val) && /\d/.test(val) && val.length >= 3 && val.length <= 25) {
            info.orderNo = val.toUpperCase();
            break;
          }
        }
      }

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

        if (
          (combinedDesc.includes("saistīt") && combinedDesc.includes("klient") && combinedDesc.includes("nr")) ||
          combinedDesc.includes("saistītā klienta nr") ||
          combinedDesc.includes("saistītā klienta kods")
        ) {
          if (!info.relatedCustomerNo) info.relatedCustomerNo = val;
        } else if (
          (combinedDesc.includes("saistīt") && combinedDesc.includes("klient") && (combinedDesc.includes("nosauk") || combinedDesc.includes("name"))) &&
          !val.toLowerCase().includes("meklēt") && !val.toLowerCase().includes("pieejam")
        ) {
          if (!info.relatedCustomerName) info.relatedCustomerName = val;
        } else if (
          (combinedDesc.includes("klienta nr") || combinedDesc.includes("sell-to customer no") || combinedDesc.includes("customer no")) &&
          !combinedDesc.includes("saistīt") && !combinedDesc.includes("preces")
        ) {
          if (!info.customerNo && !/klienta|customer|nr\.?$/i.test(val) && val.length <= 25 && !isInsideFactBox(el)) info.customerNo = val;
        } else if (
          (combinedDesc.includes("klienta nosauk") || combinedDesc.includes("sell-to customer name") || combinedDesc.includes("customer name")) &&
          !combinedDesc.includes("saistīt") && !combinedDesc.includes("preces") && !combinedDesc.includes("meklē")
        ) {
          if (!info.customerName && !/klienta|customer|nosaukums|name$/i.test(val) && !isInsideFactBox(el)) info.customerName = val;
        } else if (combinedDesc.includes("dokumenta datums") || combinedDesc.includes("document date")) {
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
      `;
      (doc.head || doc.body || doc.documentElement).appendChild(style);
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Neizdevās ievietot stilus dokumentā:", e);
    }
  }

  function findExactDiscountCell(rowElement, bcDoc) {
    if (!rowElement) return null;
    const rowCells = Array.from(rowElement.querySelectorAll('[role="gridcell"], td, th'));
    if (rowCells.length === 0) return null;
    const discRe = /rind.*atlaid|atlaid.*%|line\s*disc/i;

    const byName = rowElement.querySelector('td[controlname="Line Discount %"], td[controlname="Line Discount Pct"], td[controlname="LineDiscountPct"], [controlname="Line Discount %"]');
    if (byName) return byName;

    for (const cell of rowCells) {
      const title = (cell.getAttribute("title") || cell.getAttribute("aria-label") || "");
      if (discRe.test(title)) return cell;
      const inp = cell.querySelector("input");
      if (inp) {
        const inpTitle = (inp.getAttribute("title") || inp.getAttribute("aria-label") || inp.name || "");
        if (discRe.test(inpTitle)) return cell;
      }
    }

    try {
      const rowLp = rowElement.closest('.ms-nav-listpartform, .ms-nav-collapsible-part, .hosting-list, div[class*="listpartform"]');
      const listPart = (rowLp && !isInsideFactBox(rowLp) ? rowLp : null) ||
        findSalesLinesListPart(bcDoc) ||
        (rowElement.ownerDocument && findSalesLinesListPart(rowElement.ownerDocument)) ||
        findSalesLinesListPart(document);

      if (listPart) {
        const headers = Array.from(listPart.querySelectorAll('table.ms-nav-grid-header-table th, [role="columnheader"], th'))
          .filter((h) => !rowElement.contains(h));
        const discHeader = headers.find((h) => {
          const cName = (h.getAttribute("controlname") || "").toLowerCase();
          const caption = normHeaderCaption(h);
          return cName.includes("discount") || discRe.test(caption);
        });
        if (discHeader) {
          const colIdx = discHeader.getAttribute("aria-colindex") || discHeader.getAttribute("data-col-index");
          if (colIdx) {
            const m = rowCells.find((c) => (c.getAttribute("aria-colindex") || c.getAttribute("data-col-index")) === colIdx);
            if (m) return m;
          }
          const headerRow = discHeader.closest('tr, [role="row"]');
          if (headerRow) {
            const hCells = Array.from(headerRow.querySelectorAll('[role="columnheader"], th, td'));
            const hIdx = hCells.indexOf(discHeader);
            if (hIdx >= 0) {
              let offset = null;
              const knownNames = ["No.", "Description", "Quantity", "Type", "Line Discount %", "Line Discount Pct", "LineDiscountPct"];
              for (const name of knownNames) {
                const hCell = hCells.find((h) => (h.getAttribute("controlname") || "") === name || h.querySelector(`[controlname="${name}"]`));
                if (!hCell) continue;
                const hCellIdx = hCells.indexOf(hCell);
                const rCell = rowElement.querySelector(`[controlname="${name}"]`);
                if (!rCell) continue;
                const rTd = rCell.closest("td, th, [role=gridcell]") || rCell;
                const rCellIdx = rowCells.indexOf(rTd);
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

    return null;
  }

  function getDiscountCellForRow(row, line, bcDoc) {
    if (!row) return null;

    const byName = row.querySelector('td[controlname="Line Discount %"], td[controlname="Line Discount Pct"], td[controlname="LineDiscountPct"], [controlname="Line Discount %"]');
    if (byName) return byName;

    if (line && line.discountAriaColIndex) {
      const c = row.querySelector(`[aria-colindex="${line.discountAriaColIndex}"], [data-col-index="${line.discountAriaColIndex}"]`);
      if (c) return c;
    }

    const cExact = findExactDiscountCell(row, bcDoc);
    if (cExact) return cExact;

    if (line && line.discountColIndex >= 0) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
      if (line.discountColIndex < cells.length) return cells[line.discountColIndex];
    }

    return null;
  }

  function extractSalesLines() {
    const lines = [];
    const bcDoc = getBCDocument();
    const listPart = findSalesLinesListPart(bcDoc);

    if (!listPart) {
      return lines;
    }

    const allRows = Array.from(listPart.querySelectorAll('[role="row"], tr'));
    if (allRows.length === 0) {
      return lines;
    }

    let headerRow = null;
    let headerCellsCount = 0;
    const colIndices = {
      type: -1, code: -1, desc: -1, qty: -1, orderedQty: -1,
      discount: -1, price: -1, amount: -1, group: -1, uom: -1
    };
    const colAriaIndices = {
      type: null, code: null, desc: null, qty: null, orderedQty: null,
      discount: null, price: null, amount: null, group: null, uom: null
    };

    for (const r of allRows) {
      const headerCells = Array.from(r.querySelectorAll('[role="columnheader"], th, td, [role="gridcell"]'));
      const texts = headerCells.map((c) => {
        const cName = (c.getAttribute("controlname") || "").toLowerCase().trim();
        const t = normHeaderCaption(c);
        return `${cName} ${t}`;
      });

      const hasType = texts.some((t) => /type|\btips\b/i.test(t));
      const hasCode = texts.some((t) => /\bnr\.?\b|\bnr\.?\b|\bno\.?\b|itemno|artikuls|preces\s*nr/i.test(t));

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
            colIndices.qty = idx;
            if (colIdx) colAriaIndices.qty = colIdx;
          } else if (/pasūtītais\s*daudzums/i.test(caption)) {
            colIndices.orderedQty = idx;
            if (colIdx) colAriaIndices.orderedQty = colIdx;
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

    const dataRows = allRows.filter((r) => {
      if (r === headerRow) return false;
      if (r.closest("thead, table.ms-nav-grid-header-table")) return false;
      const hasHeaderCell = r.querySelector('th, [role="columnheader"]');
      if (hasHeaderCell && !r.querySelector('td[role="gridcell"]')) return false;
      return true;
    });
    let validRowCounter = 0;

    dataRows.forEach((row, rowIdx) => {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], td, th'));
      if (cells.length < 4) return;

      let rowOffset = null;
      const knownNames = ["No.", "Description", "Quantity", "Type", "Line Discount %", "Line Discount Pct", "LineDiscountPct"];
      if (headerRow) {
        const hCells = Array.from(headerRow.querySelectorAll('[role="columnheader"], th, td, [role="gridcell"]'));
        for (const name of knownNames) {
          const hCell = hCells.find((h) => (h.getAttribute("controlname") || "") === name || h.querySelector(`[controlname="${name}"]`));
          if (!hCell) continue;
          const hCellIdx = hCells.indexOf(hCell);
          const rCell = row.querySelector(`[controlname="${name}"]`);
          if (!rCell) continue;
          const rTd = rCell.closest("td, th, [role=gridcell]") || rCell;
          const rCellIdx = cells.indexOf(rTd);
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
      if (typeVal && /^(virsraksts|komentārs|virsr\.?|konts|g\/l\s*account|resurss|resource|pamatlīdzeklis|fixed\s*asset|preces\s*papildu|charge)/i.test(typeVal)) return;
      if (typeCell && (typeCell.getAttribute("controlname") || "") === "Type" && typeVal && !/prece|item/i.test(typeVal)) return;

      let codeVal = "";
      const noTd = row.querySelector('td[controlname="No."], td[controlname="No"], td[controlname="ItemNo"], td[controlname="Item No."], [controlname="No."]');
      if (noTd) {
        const val = getVal(noTd);
        if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
          codeVal = val;
        }
      }

      if (!codeVal && colAriaIndices.code) {
        const ariaCell = row.querySelector(`[aria-colindex="${colAriaIndices.code}"], [data-col-index="${colAriaIndices.code}"]`);
        if (ariaCell) {
          const val = getVal(ariaCell);
          if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
            codeVal = val;
          }
        }
      }

      if (!codeVal && colIndices.code >= 0) {
        const realIdx = colIndices.code + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) {
          const val = getCellVal(realIdx);
          if (val && !isDateString(val) && !/^(on|off|tips|nr\.?|prece|item|nosaukums|name|faila|paplašinājums|kopā|total)$/i.test(val)) {
            codeVal = val;
          }
        }
      }

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

      if (!codeVal || isDateString(codeVal)) return;

      let descVal = "";
      const descCell = row.querySelector('td[controlname="Description"], [controlname="Description"]') || getCellByCol(colAriaIndices.desc, colIndices.desc);
      if (descCell) descVal = getVal(descCell);
      if (!descVal || descVal.length < 3) {
        const codeColIdx = colIndices.code >= 0 ? colIndices.code + rowOffset : -1;
        for (let i = 0; i < cells.length; i++) {
          if (codeColIdx >= 0 && i <= codeColIdx) continue;
          const txt = getCellVal(i);
          if (/^[A-Z0-9_.\-]+$/.test(txt)) continue;
          if (txt.length > 8 && txt !== codeVal && !txt.includes("http") && !/^\d+[\.,]\d+$/.test(txt) && !isDateString(txt)) {
            descVal = txt;
            break;
          }
        }
      }

      let rawQty = "";
      const qtyCell = row.querySelector('td[controlname="Quantity"], [controlname="Quantity"]') || getCellByCol(colAriaIndices.qty, colIndices.qty);
      if (qtyCell) {
        rawQty = getVal(qtyCell);
      } else if (colIndices.qty >= 0) {
        const realIdx = colIndices.qty + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) rawQty = getCellVal(realIdx);
      }
      if (!rawQty) {
        const orderedQtyCell = getCellByCol(colAriaIndices.orderedQty, colIndices.orderedQty);
        if (orderedQtyCell) rawQty = getVal(orderedQtyCell);
      }
      const qty = parseNum(rawQty || "1") || 1;

      let discountCell = null;
      if (colAriaIndices.discount) {
        discountCell = row.querySelector(`[aria-colindex="${colAriaIndices.discount}"], [data-col-index="${colAriaIndices.discount}"]`);
      }
      if (!discountCell) discountCell = findExactDiscountCell(row, bcDoc);
      if (!discountCell && colIndices.discount >= 0) {
        const realIdx = colIndices.discount + rowOffset;
        if (realIdx >= 0 && realIdx < cells.length) discountCell = cells[realIdx];
      }

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
          currentDiscount = parseNum(getCellVal(realIdx)) || 0;
        }
      }

      let groupCode = "";
      const groupTd = row.querySelector('td[controlname="ShortcutDimCode6"], td[controlname="Item Disc. Group"], td[controlname="Item Disc Group"]');
      if (groupTd) {
        const inp = groupTd.querySelector("input");
        groupCode = (inp ? inp.value : groupTd.textContent).trim();
      }
      if (!groupCode) {
        const gCell = getCellByCol(colAriaIndices.group, colIndices.group);
        if (gCell) groupCode = getVal(gCell);
      }

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

      const rowCellTexts = cells.map((c) => {
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
        discountCell,
        discountAriaColIndex: colAriaIndices.discount,
        discountColIndex: colIndices.discount >= 0 ? colIndices.discount + rowOffset : -1,
        itemCode: codeVal,
        description: descVal,
        groupCode,
        itemDiscGroup: groupCode,
        itemCategoryCode: "",
        uom: lineUom,
        qty,
        rowCellTexts,
        currentDiscount,
        newDiscount: currentDiscount,
        matchedReason: "Gaida aprēķinu",
        status: "idle"
      });
    });

    const codeCounts = {};
    lines.forEach((l) => {
      const k = l.itemCode.toUpperCase();
      l.ordinal = codeCounts[k] || 0;
      codeCounts[k] = l.ordinal + 1;
    });

    lines.listPart = listPart;
    lines.hasDiscountColumn = (colIndices.discount !== -1 || !!colAriaIndices.discount || lines.some((l) => !!l.discountCell));
    lines.hasGroupColumn = (colIndices.group !== -1 || !!colAriaIndices.group || lines.some((l) => !!l.groupCode));

    return lines;
  }

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

    if (isH(el)) return el;

    try {
      const inner = el.querySelectorAll(".ms-nav-scrollable, .scroll-source, [role=grid]");
      for (const c of inner) {
        if (isH(c)) return c;
      }
    } catch (e) {}

    let s = el.parentElement;
    while (s && s !== body && s !== doc.documentElement) {
      if (isH(s)) return s;
      s = s.parentElement;
    }
    return null;
  }

  async function extractAllSalesLines(onProgress, knownGroupCodes) {
    const first = extractSalesLines(knownGroupCodes);
    const anchor = (first[0] && first[0].gridElement) || first.listPart || findSalesLinesListPart(getBCDocument());
    const vScroller = anchor ? (findScroller(anchor) || findScroller(anchor.querySelector('[role="row"], tr') || anchor)) : null;
    const hScroller = anchor ? (findHorizontalScroller(anchor) || findHorizontalScroller(anchor.querySelector('[role="row"], tr') || anchor)) : null;
    if (!vScroller && !hScroller) return first;

    const needGroup = !!(knownGroupCodes && ((knownGroupCodes instanceof Set && knownGroupCodes.size > 0) || (Array.isArray(knownGroupCodes) && knownGroupCodes.length > 0)));
    const needsVert = !!(vScroller && vScroller.scrollHeight > vScroller.clientHeight + 40);
    const needsHoriz = !!(hScroller && hScroller.scrollWidth > hScroller.clientWidth + 15 && (!first.hasDiscountColumn || (needGroup && !first.hasGroupColumn)));
    if (!needsVert && !needsHoriz) return first;

    BCM.state.bcmBusy = true;
    const origTop = vScroller ? vScroller.scrollTop : 0;
    const origLeft = hScroller ? hScroller.scrollLeft : 0;
    const merged = new Map();
    let hasDiscountColumn = false;
    let hasGroupColumn = false;
    let discoveredHorizLeft = null;

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
        if (l.discountCell) existing.discountScrollLeft = currentScrollLeft;

        if (Array.isArray(l.rowCellTexts)) {
          if (!Array.isArray(existing.rowCellTexts)) existing.rowCellTexts = [];
          const seen = new Set(existing.rowCellTexts.filter((t) => t));
          for (const t of l.rowCellTexts) {
            if (t && !seen.has(t)) {
              existing.rowCellTexts.push(t);
              seen.add(t);
            }
          }
        }
      }
    };

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

    const scanHorizontalAtCurrentVertical = async () => {
      if (!hScroller) return;
      if (!needsHoriz || (first.hasDiscountColumn && (!needGroup || first.hasGroupColumn))) return;

      const columnsFound = () => hasDiscountColumn && (!needGroup || hasGroupColumn);
      const savedLeft = hScroller.scrollLeft;
      try {
        if (columnsFound() && discoveredHorizLeft !== null) {
          hScroller.scrollLeft = discoveredHorizLeft;
          await sleep(65);
          addSnapshot(extractSalesLines(knownGroupCodes), hScroller.scrollLeft);
          enrichByAriaRowAtHorizontalStep(hScroller.scrollLeft);
          if (typeof onProgress === "function") onProgress(merged.size);
          return;
        }

        const maxLeft = hScroller.scrollWidth - hScroller.clientWidth;
        const stepSize = Math.max(200, Math.floor(hScroller.clientWidth * 0.65));
        for (let left = 0; left <= maxLeft; left += stepSize) {
          hScroller.scrollLeft = left;
          await sleep(65);
          addSnapshot(extractSalesLines(knownGroupCodes), hScroller.scrollLeft);
          enrichByAriaRowAtHorizontalStep(hScroller.scrollLeft);
          if (columnsFound() && discoveredHorizLeft === null) {
            discoveredHorizLeft = hScroller.scrollLeft;
            const bcDoc = getBCDocument();
            if (bcDoc) bcDoc.__bcmDiscountScrollLeft = discoveredHorizLeft;
          }
          if (typeof onProgress === "function") onProgress(merged.size);
          if (columnsFound() && discoveredHorizLeft !== null) break;
        }
        if (!columnsFound() && hScroller.scrollLeft < maxLeft) {
          hScroller.scrollLeft = maxLeft;
          await sleep(65);
          addSnapshot(extractSalesLines(knownGroupCodes), hScroller.scrollLeft);
          enrichByAriaRowAtHorizontalStep(hScroller.scrollLeft);
          if (columnsFound() && discoveredHorizLeft === null) {
            discoveredHorizLeft = hScroller.scrollLeft;
            const bcDoc = getBCDocument();
            if (bcDoc) bcDoc.__bcmDiscountScrollLeft = discoveredHorizLeft;
          }
          if (typeof onProgress === "function") onProgress(merged.size);
        }
      } finally {
        try { hScroller.scrollLeft = savedLeft; } catch (e) {}
      }
    };

    try {
      addSnapshot(first, origLeft);

      if (vScroller && needsVert) {
        vScroller.scrollTop = 0;
        await sleep(65);
        addSnapshot(extractSalesLines(knownGroupCodes), hScroller ? hScroller.scrollLeft : 0);
        await scanHorizontalAtCurrentVertical();

        for (let step = 0; step < 25; step++) {
          const prevTop = vScroller.scrollTop;
          const scrollDelta = Math.max(80, Math.floor(vScroller.clientHeight * 0.7));
          vScroller.scrollTop += scrollDelta;
          await sleep(65);

          addSnapshot(extractSalesLines(knownGroupCodes), hScroller ? hScroller.scrollLeft : 0);
          await scanHorizontalAtCurrentVertical();

          if (typeof onProgress === "function") onProgress(merged.size);

          if (vScroller.scrollTop === prevTop || vScroller.scrollTop + vScroller.clientHeight >= vScroller.scrollHeight - 2) {
            const beforeHeight = vScroller.scrollHeight;
            await sleep(80);
            if (vScroller.scrollHeight === beforeHeight) break;
          }
        }
      } else {
        await scanHorizontalAtCurrentVertical();
      }
    } catch (e) {
      console.warn("[BC Atlaižu Helperis] Kļūda extractAllSalesLines:", e);
    } finally {
      try { if (vScroller) vScroller.scrollTop = origTop; } catch (e) {}
      try { if (hScroller) hScroller.scrollLeft = origLeft; } catch (e) {}
      BCM.state.bcmBusy = false;
    }

    let all = Array.from(merged.values());
    if (all.some((l) => l.ariaRowIndex)) {
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

  Object.assign(BCM, {
    getAllBCDocuments,
    getBCDocument,
    extractHeaderCustomerInfo,
    ensureHighlightStyles,
    findSalesLinesListPart,
    findExactDiscountCell,
    getDiscountCellForRow,
    extractSalesLines,
    extractAllSalesLines
  });
})();
