/**
 * BC atlaižu pārvaldnieks - Atlaižu saskaņošanas dzinējs
 */
(function () {
  const BCM = window.__BCM;
  if (!BCM) return;

  const { isExtensionContextValid, isRuleDateActive } = BCM;

  async function getClientRulesData(customerNo) {
    if (!customerNo) return { rules: [], isSynced: false, isExpired: false };
    if (!isExtensionContextValid()) return { rules: [], isSynced: false, isExpired: false };
    const normCust = customerNo.trim().toUpperCase();
    try {
      const storageData = await chrome.storage.local.get([
        "bc_client_discounts",
        "bc_client_discounts_meta",
        "bc_manager_settings"
      ]);
      const allDiscounts = storageData.bc_client_discounts || {};
      const meta = storageData.bc_client_discounts_meta || {};
      const settings = storageData.bc_manager_settings || {};
      const expiryHours = Number(settings.cacheExpiryHours) > 0 ? Number(settings.cacheExpiryHours) : 24;

      const hasEntry = (normCust in allDiscounts) || (normCust in meta);
      const rules = Array.isArray(allDiscounts[normCust]) ? allDiscounts[normCust] : [];
      const custMeta = meta[normCust];
      const syncedAt = custMeta && custMeta.syncedAt ? Number(custMeta.syncedAt) : 0;
      const isExpired = hasEntry && (!syncedAt || (Date.now() - syncedAt > expiryHours * 3600 * 1000));

      return { rules, isSynced: hasEntry && !isExpired, isExpired };
    } catch (e) {
      return { rules: [], isSynced: false, isExpired: false };
    }
  }

  async function getClientRules(customerNo) {
    const data = await getClientRulesData(customerNo);
    return data.rules;
  }

  async function matchDiscountsForLines(lines, relatedCustomerNo) {
    if (!relatedCustomerNo) {
      lines.forEach((l) => {
        l.newDiscount = l.currentDiscount;
        l.matchedReason = "Nav norādīts saistītais klients";
        l.status = "nodisc";
      });
      return lines;
    }

    const { rules: clientRules, isSynced } = await getClientRulesData(relatedCustomerNo);

    if (!clientRules || clientRules.length === 0) {
      lines.forEach((l) => {
        l.newDiscount = l.currentDiscount;
        if (isSynced) {
          l.matchedReason = `Klientam ${relatedCustomerNo} nav individuālu atlaižu Business Central`;
        } else {
          l.matchedReason = `Klientam ${relatedCustomerNo} atlaides vēl nav kešā (nospiediet 'Ielasīt no Page 7004')`;
        }
        l.status = "nodisc";
      });
      return lines;
    }

    const activeRules = clientRules.filter(isRuleDateActive);

    lines.forEach((line) => {
      const codeUpper = (line.itemCode || "").toUpperCase().trim();
      const groupCodeUpper = (line.groupCode || "").toUpperCase().trim();
      const itemDiscGroupUpper = (line.itemDiscGroup || "").toUpperCase().trim();
      const groupPrefix = groupCodeUpper.includes("_") ? groupCodeUpper.split("_")[0] : "";
      const discGroupPrefix = itemDiscGroupUpper.includes("_") ? itemDiscGroupUpper.split("_")[0] : "";
      const lineUomUpper = (line.uom || "").toUpperCase().trim();
      const qty = line.qty;

      const candidates = [];

      for (const rule of activeRules) {
        if (rule.minQty && qty < rule.minQty) continue;
        if (rule.uom && lineUomUpper && rule.uom.toUpperCase().trim() !== lineUomUpper) {
          continue;
        }

        const ruleCodeUpper = (rule.code || "").toUpperCase().trim();
        const ruleType = rule.type || "";

        if (/prece|item/i.test(ruleType) && ruleCodeUpper === codeUpper) {
          candidates.push({
            rule,
            priority: 3,
            reason: `Preces tiešā atlaide (${rule.discountPercent}%)`
          });
          continue;
        }

        if (/grup|disc|atlai/i.test(ruleType) && ruleCodeUpper) {
          if ((groupCodeUpper && ruleCodeUpper === groupCodeUpper) || (itemDiscGroupUpper && ruleCodeUpper === itemDiscGroupUpper)) {
            candidates.push({
              rule,
              priority: 2.2,
              reason: `Grupas ${rule.code} atlaide (${rule.discountPercent}%)`
            });
            continue;
          } else if ((groupPrefix && ruleCodeUpper === groupPrefix) || (discGroupPrefix && ruleCodeUpper === discGroupPrefix)) {
            candidates.push({
              rule,
              priority: 2.1,
              reason: `Grupas ${rule.code} atlaide (${rule.discountPercent}%)`
            });
            continue;
          }
        }

        if (/visas\s*preces|all\s*items/i.test(ruleType)) {
          candidates.push({
            rule,
            priority: 1,
            reason: `Klienta vispārējā atlaide (${rule.discountPercent}%)`
          });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          if (b.rule.discountPercent !== a.rule.discountPercent) {
            return b.rule.discountPercent - a.rule.discountPercent;
          }
          return b.priority - a.priority;
        });

        const best = candidates[0];
        line.newDiscount = best.rule.discountPercent;
        line.matchedReason = best.reason;

        if (line.currentDiscount > 0 && line.currentDiscount !== line.newDiscount) {
          line.status = "overwritten";
        } else {
          line.status = "new";
        }
      } else {
        line.newDiscount = line.currentDiscount;
        line.matchedReason = "Nav definēta atlaide šai precei";
        line.status = "nodisc";
      }
    });

    return lines;
  }

  Object.assign(BCM, {
    getClientRulesData,
    getClientRules,
    matchDiscountsForLines
  });
})();
