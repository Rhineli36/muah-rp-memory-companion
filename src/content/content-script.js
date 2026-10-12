(() => {
  "use strict";

  if (globalThis.__muahRpMemoryCompanionLoaded) return;
  globalThis.__muahRpMemoryCompanionLoaded = true;

  const ORIGIN = location.origin;
  const SLOT_ID_ATTRIBUTES = ["data-slot-id", "data-character-id", "data-chat-id", "data-companion-id"];
  const URL_ID_KEYS = ["slotId", "slot_id", "characterId", "character_id", "chatId", "chat_id", "companionId"];
  const MESSAGE_SELECTORS = [
    "[data-message-id]",
    "[data-message-author-role]",
    "[data-role='user']",
    "[data-role='assistant']",
    "[class*='message'][class*='user']",
    "[class*='message'][class*='assistant']",
    "[class*='message'][class*='bot']",
    "[class*='message'][class*='ai']"
  ];

  let timer = null;
  let lastPayloadFingerprint = "";
  let lastUrl = location.href;
  let rememberedSlotIndex = null;
  let rememberedSlotLabel = "";
  let pendingSlot = null;
  let captureArmed = false;
  let manualSelectionLocked = false;

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cleanMessageText(value) {
    return String(value || "")
      .replace(/\r\n?/gu, "\n")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  }

  const MESSAGE_CONTROL_TEXT = /^(?:复制|copy|生成语音|generate audio|编辑|edit|删除|delete|重新生成|regenerate|朗读|read aloud|更多|more)$/iu;

  function stripInjectedMemory(value) {
    return cleanMessageText(String(value || "")
      .replace(/\[\[MUAH_RP_MEMORY_CONTEXT_BEGIN\]\][\s\S]*?\[\[MUAH_RP_MEMORY_CONTEXT_END\]\]/giu, " ")
      .replace(/<MEMORY(?:_PART\b[^>]*)?>[\s\S]*?<\/MEMORY(?:_PART)?>/giu, " "));
  }

  function textWithParagraphs(root) {
    // innerText on a detached clone may flatten block layout. Convert visible
    // HTML structure to explicit newlines before reading textContent.
    root.querySelectorAll("br").forEach((item) => item.replaceWith(document.createTextNode("\n")));
    const blocks = [...root.querySelectorAll("p, li, blockquote, pre, div")]
      .filter((item) => !item.querySelector("p, li, blockquote, pre, div"));
    for (const block of blocks) {
      if (cleanText(block.textContent)) block.append(document.createTextNode("\n\n"));
    }
    return cleanMessageText(root.textContent || "");
  }

  function messageText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll([
      "button",
      "[role='button']",
      "[role='menu']",
      "[role='menuitem']",
      "menu",
      "nav",
      "svg",
      "audio",
      "[contenteditable='true']",
      "[class*='action']",
      "[class*='toolbar']",
      "[class*='controls']",
      "[class*='menu']"
    ].join(",")).forEach((item) => item.remove());
    [...clone.querySelectorAll("span, div, a")].forEach((item) => {
      if (MESSAGE_CONTROL_TEXT.test(cleanText(item.textContent))) item.remove();
    });
    return stripInjectedMemory(textWithParagraphs(clone)
      .replace(/(?:\s+(?:复制|copy|生成语音|generate audio|编辑|edit|删除|delete|重新生成|regenerate|朗读|read aloud|更多|more)){2,}\s*$/iu, "")
      .trim());
  }

  function makeNativeKey(kind, value) {
    return `${ORIGIN}|${kind}|${String(value).trim()}`;
  }

  function isVisible(node) {
    return node instanceof HTMLElement && node.offsetParent !== null;
  }

  function exactVisibleElements(pattern) {
    const nodes = [...document.querySelectorAll("button, a, [role='button'], div, span")]
      .filter((node) => isVisible(node) && pattern.test(cleanText(node.innerText || node.textContent)));
    return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
  }

  function markerCount(node, pattern) {
    return [...node.querySelectorAll("button, a, [role='button'], div, span")]
      .filter((item) => isVisible(item) && pattern.test(cleanText(item.innerText || item.textContent)))
      .filter((item, _index, all) => !all.some((other) => other !== item && item.contains(other)))
      .length;
  }

  function findSlotCard(marker, markerPattern) {
    let current = marker;
    let best = null;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const text = cleanText(current.innerText || current.textContent);
      if (text.length > 0 && text.length < 320 && markerCount(current, markerPattern) === 1) best = current;
      if (markerCount(current, /^(?:切换|switch|current)$/iu) > 1) break;
    }
    return best;
  }

  function slotLabelFromCard(card, fallback) {
    const lines = String(card?.innerText || "").split(/\r?\n/u).map(cleanText).filter(Boolean);
    const ignored = /^(?:切换|switch|current|ready|active|rename|重命名)$/iu;
    return (lines.find((line) => !ignored.test(line)) || fallback).slice(0, 120);
  }

  function readTenSlotGrid() {
    const switchMarkers = exactVisibleElements(/^(?:切换|switch)$/iu);
    const currentMarkers = exactVisibleElements(/^current$/iu);
    if (switchMarkers.length !== 9 || currentMarkers.length !== 1) return null;

    const entries = [
      ...switchMarkers.map((marker) => ({ marker, card: findSlotCard(marker, /^(?:切换|switch)$/iu), active: false })),
      ...currentMarkers.map((marker) => ({ marker, card: findSlotCard(marker, /^current$/iu), active: true }))
    ];
    entries.sort((left, right) => {
      if (left.marker === right.marker) return 0;
      return left.marker.compareDocumentPosition(right.marker) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const activeIndex = entries.findIndex((entry) => entry.active);
    if (activeIndex < 0) return null;
    return {
      entries,
      activeIndex,
      activeLabel: slotLabelFromCard(entries[activeIndex].card, `Muah 槽位 ${activeIndex + 1}`)
    };
  }

  function detectNumberedSlot() {
    const grid = readTenSlotGrid();
    if (pendingSlot) {
      const pageChanged = JSON.stringify([extractMessages().map((item) => [item.role, item.text]), extractSystemSummary()]) !== pendingSlot.oldTranscript;
      if (pageChanged && ((grid && grid.activeIndex === pendingSlot.index) || (!grid && Date.now() - pendingSlot.clickedAt >= 500))) {
        rememberedSlotIndex = pendingSlot.index;
        rememberedSlotLabel = pendingSlot.label;
        pendingSlot = null;
        manualSelectionLocked = false;
        captureArmed = true;
      } else {
        captureArmed = false;
      }
    }
    if (grid && !manualSelectionLocked && !pendingSlot) {
      rememberedSlotIndex = grid.activeIndex;
      rememberedSlotLabel = grid.activeLabel;
      pendingSlot = null;
      captureArmed = true;
    }
    if (!Number.isInteger(rememberedSlotIndex)) return null;
    return {
      index: rememberedSlotIndex,
      slotNumber: rememberedSlotIndex + 1,
      label: rememberedSlotLabel || `Muah 槽位 ${rememberedSlotIndex + 1}`,
      evidence: grid ? "10-slot dialog Current marker" : "confirmed slot selection in this tab"
    };
  }

  function detectIdentity() {
    const candidates = [];
    const url = new URL(location.href);
    const numberedSlot = detectNumberedSlot();

    if (numberedSlot) {
      candidates.push({
        kind: "slot-index",
        confidence: "medium",
        nativeKey: makeNativeKey("slot-index", numberedSlot.index),
        evidence: numberedSlot.evidence
      });
    }

    for (const key of URL_ID_KEYS) {
      const value = url.searchParams.get(key);
      if (value && /^[\w-]{2,128}$/u.test(value)) {
        candidates.push({ kind: "url-id", confidence: "high", nativeKey: makeNativeKey(`url:${key}`, value), evidence: `${key}=${value}` });
      }
    }

    const pathMatch = url.pathname.match(/\/(?:chat|character|companion|slot)s?\/([\w-]{2,128})(?:\/|$)/iu);
    if (pathMatch && !["room", "new", "create"].includes(pathMatch[1].toLowerCase())) {
      candidates.push({ kind: "url-id", confidence: "high", nativeKey: makeNativeKey("url:path", pathMatch[1]), evidence: url.pathname });
    }

    const activeSelectors = SLOT_ID_ATTRIBUTES.flatMap((attribute) => [
      `[${attribute}][aria-selected='true']`,
      `[${attribute}].active`,
      `[${attribute}][data-active='true']`
    ]);
    let activeSlotElement = null;
    for (const selector of activeSelectors) {
      const nodes = [...document.querySelectorAll(selector)].filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      if (nodes.length === 1) {
        activeSlotElement = nodes[0];
        const attribute = SLOT_ID_ATTRIBUTES.find((name) => nodes[0].hasAttribute(name));
        const value = attribute && nodes[0].getAttribute(attribute);
        if (value) {
          candidates.push({ kind: "dom-id", confidence: "high", nativeKey: makeNativeKey(`dom:${attribute}`, value), evidence: `${attribute}=${value}` });
        }
      }
    }

    if (!activeSlotElement) {
      const possible = [
        ...document.querySelectorAll("[role='tab'][aria-selected='true'], .character-slot.active, .slot.active, [data-slot-index][aria-selected='true']")
      ].filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      if (possible.length === 1) activeSlotElement = possible[0];
    }

    if (activeSlotElement && !numberedSlot) {
      const explicitIndex = activeSlotElement.getAttribute("data-slot-index");
      const siblings = [...(activeSlotElement.parentElement?.children || [])].filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      const index = explicitIndex ?? siblings.indexOf(activeSlotElement);
      if (Number.isInteger(Number(index)) && Number(index) >= 0 && siblings.length >= 2 && siblings.length <= 20) {
        candidates.push({
          kind: "slot-index",
          confidence: "medium",
          nativeKey: makeNativeKey("slot-index", Number(index)),
          evidence: `visible slot index ${Number(index) + 1}/${siblings.length}`
        });
      }
    }

    const displayName = cleanText(
      activeSlotElement?.getAttribute("aria-label") ||
      activeSlotElement?.querySelector("[class*='name']")?.textContent ||
      activeSlotElement?.textContent ||
      document.querySelector("[data-character-name], [class*='character-name'], [class*='chat-title']")?.textContent ||
      "未命名 Muah 槽位"
    ).slice(0, 120);

    const label = numberedSlot
      ? `槽位 ${numberedSlot.slotNumber} · ${numberedSlot.label}`
      : displayName;

    return {
      label,
      slotNumber: numberedSlot?.slotNumber || null,
      captureArmed,
      candidates,
      pageUrl: location.href,
      detectedAt: new Date().toISOString()
    };
  }

  function inferRole(node) {
    let current = node;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const values = [
        current.getAttribute?.("data-message-author-role"),
        current.getAttribute?.("data-role"),
        current.getAttribute?.("aria-label"),
        current.className
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      if (/\b(user|human|me|mine|sent)\b/u.test(values)) return "user";
      if (/\b(assistant|bot|ai|character|companion|received)\b/u.test(values)) return "assistant";
    }
    return null;
  }

  function systemSummaryContainers() {
    const labels = [...document.querySelectorAll("div, span, p, h1, h2, h3, h4, h5, h6")]
      .filter((node) => isVisible(node) && /^(?:system summary|系统摘要|系统总结)$/iu.test(cleanText(node.textContent)))
      .filter((node, _index, all) => !all.some((other) => other !== node && node.contains(other)));
    return labels.flatMap((label) => {
      let content = label.nextElementSibling;
      if (!content && label.parentElement?.children.length <= 3) content = label.parentElement.nextElementSibling;
      // Never climb to the entire chat container just because a short summary
      // does not meet a text-length heuristic.
      if (content && !content.querySelector(MESSAGE_SELECTORS.join(",")) && !content.querySelector("textarea, [contenteditable='true']")) return [label, content];
      return [label];
    });
  }

  function extractCorePrompt() {
    const labels = [...document.querySelectorAll("label, div, span, p")]
      .filter((node) => isVisible(node) && /^(?:核心提示词|core prompt)$/iu.test(cleanText(node.textContent)));
    for (const label of labels) {
      if (label instanceof HTMLLabelElement && label.htmlFor) {
        const associated = document.getElementById(label.htmlFor);
        if (associated instanceof HTMLTextAreaElement && isVisible(associated)) return associated.value.trim();
      }
      let scope = label.parentElement;
      for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
        const fields = [...scope.querySelectorAll("textarea, [contenteditable='true']")]
          .filter((node) => isVisible(node))
          .filter((node) => node.getBoundingClientRect().top >= label.getBoundingClientRect().top);
        if (fields.length) {
          const field = fields.sort((left, right) =>
            left.getBoundingClientRect().top - right.getBoundingClientRect().top
          )[0];
          return String(field.value ?? field.textContent ?? "").trim();
        }
      }
    }
    return "";
  }

  function extractSystemSummary() {
    const labels = [...document.querySelectorAll("div, span, p, h1, h2, h3, h4, h5, h6")]
      .filter((node) => isVisible(node) && /^(?:system summary|系统摘要|系统总结)$/iu.test(cleanText(node.textContent)))
      .filter((node, _index, all) => !all.some((other) => other !== node && node.contains(other)));
    if (labels.length !== 1) return null;
    const label = labels[0];
    let content = label.nextElementSibling;
    if (!content && label.parentElement?.children.length <= 3) content = label.parentElement.nextElementSibling;
    if (!content || content.contains(label) || content.querySelector("textarea, [contenteditable='true']") || content.querySelector(MESSAGE_SELECTORS.join(","))) return null;
    const clone = content.cloneNode(true);
    clone.querySelectorAll("button, [role='button'], script, style, svg").forEach((node) => node.remove());
    const text = textWithParagraphs(clone);
    return text && text.length <= 50000 ? text : null;
  }

  function checkPageIdentity(message) {
    const identity = detectIdentity();
    if (!captureArmed || pendingSlot || !Number.isInteger(identity.slotNumber) || identity.slotNumber !== message.slotNumber) {
      throw new Error("页面槽位尚未确认或正在切换，请确认编号后点击顶部“确认并抓取”");
    }
  }

  function extractMessages() {
    const summaryContainers = systemSummaryContainers();
    const all = [...document.querySelectorAll(MESSAGE_SELECTORS.join(","))]
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
      .filter((node) => !summaryContainers.some((container) => container.contains(node)));
    const rows = [];
    const seenNodes = new Set();

    for (const node of all) {
      const role = inferRole(node);
      if (!role) continue;
      const text = messageText(node);
      if (!text || text.length > 100000) continue;
      // Ignore wrapper matches when a nested element already represents the same message.
      if (rows.some((row) => (node.contains(row.node) || row.node.contains(node)) && row.text === text && row.role === role)) continue;
      const sourceNode = node.closest("[data-message-id], [data-id], [id]") || node;
      if (seenNodes.has(sourceNode)) continue;
      seenNodes.add(sourceNode);
      rows.push({
        node,
        role,
        text,
        sourceId: sourceNode.getAttribute("data-message-id") || sourceNode.getAttribute("data-id") || null,
        observedAt: new Date().toISOString()
      });
    }

    const roles = new Set(rows.map((item) => item.role));
    if (!roles.has("user") || !roles.has("assistant")) return [];
    return rows.map(({ node: _node, ...item }, pageOrder) => ({ ...item, pageOrder }));
  }

  async function scan(reason = "automatic", force = false) {
    const identity = detectIdentity();
    const messages = captureArmed ? extractMessages() : [];
    const corePrompt = captureArmed ? extractCorePrompt() : "";
    const summary = captureArmed && !pendingSlot ? extractSystemSummary() : null;
    const fingerprint = JSON.stringify({
      keys: identity.candidates.map((item) => item.nativeKey).sort(),
      messageTail: messages.slice(-3).map((item) => [item.role, item.sourceId, item.text]),
      corePrompt, summary
    });
    if (!force && fingerprint === lastPayloadFingerprint) return;
    lastPayloadFingerprint = fingerprint;
    try {
      await chrome.runtime.sendMessage({ type: "OBSERVATION", identity, messages, corePrompt, summary, reason });
    } catch (error) {
      console.debug("Muah RP Memory Companion scan skipped:", error);
    }
  }

  function scheduleScan(reason = "automatic", force = false) {
    clearTimeout(timer);
    timer = setTimeout(() => scan(reason, force), 700);
  }

  function insertIntoComposer(text) {
    const selectors = [
      "textarea[placeholder*='输入']",
      "textarea[placeholder*='message' i]",
      "[contenteditable='true'][data-placeholder*='输入']",
      "[contenteditable='true'][aria-label*='message' i]",
      "textarea",
      "[contenteditable='true']"
    ];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((node, index, all) => isVisible(node) && all.indexOf(node) === index);
    const composer = candidates.at(-1);
    if (!composer) throw new Error("没有找到 Muah 消息输入框");
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
    } else {
      composer.textContent = text;
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const observer = new MutationObserver(() => scheduleScan("mutation"));
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-selected", "data-active"]
  });

  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    originalPushState(...args);
    scheduleScan("navigation", true);
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    scheduleScan("navigation", true);
  };
  addEventListener("popstate", () => scheduleScan("navigation", true));
  document.addEventListener("click", (event) => {
    const grid = readTenSlotGrid();
    if (!grid) return;
    const target = event.target instanceof Element ? event.target : null;
    const targetIndex = grid.entries.findIndex((entry) => target && (
      entry.marker === target || entry.marker.contains(target) || target.contains(entry.marker)
    ));
    if (targetIndex < 0 || targetIndex === grid.activeIndex) return;
    const clickedText = cleanText(target?.closest("button, a, [role='button']")?.textContent || target?.textContent);
    if (!/^(?:切换|switch)$/iu.test(clickedText)) return;
    pendingSlot = {
      index: targetIndex,
      label: slotLabelFromCard(grid.entries[targetIndex].card, `Muah 槽位 ${targetIndex + 1}`),
      clickedAt: Date.now(),
      oldTranscript: JSON.stringify([extractMessages().map((item) => [item.role, item.text]), extractSystemSummary()])
    };
    captureArmed = false;
    manualSelectionLocked = false;
    scheduleScan("slot-switch-click", true);
  }, true);
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan("navigation", true);
    } else scheduleScan("heartbeat");
  }, 1500);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_CONTENT_SCRIPT") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "SCAN_NOW") {
      if (message.reason === "manual-save") {
        captureArmed = true;
        manualSelectionLocked = true;
      } else if (message.reason === "manual-recognize") {
        manualSelectionLocked = false;
      }
      scan(message.reason || "manual", true)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "SET_NUMBERED_SLOT") {
      const slotNumber = Number(message.slotNumber);
      if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 10) {
        sendResponse({ ok: false, error: "槽位编号必须是 1–10" });
        return false;
      }
      rememberedSlotIndex = slotNumber - 1;
      rememberedSlotLabel = `Muah 槽位 ${slotNumber}`;
      pendingSlot = null;
      captureArmed = false;
      manualSelectionLocked = true;
      scan("manual-slot-number", true)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "INSERT_MEMORY") {
      try {
        checkPageIdentity(message);
        const text = String(message.text || "").trim();
        if (!text) throw new Error("没有可填入的记忆内容");
        insertIntoComposer(text);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
      return false;
    }
    if (message?.type === "READ_CORE_PROMPT") {
      try { checkPageIdentity(message); }
      catch (error) { sendResponse({ ok: false, error: error.message }); return false; }
      const corePrompt = extractCorePrompt();
      sendResponse(corePrompt
        ? { ok: true, corePrompt }
        : { ok: false, error: "当前页面没有找到可见的“核心提示词”文本框；请先打开 Muah 设置页" });
      return false;
    }
    if (message?.type === "READ_SYSTEM_SUMMARY") {
      try {
        checkPageIdentity(message);
        const summary = extractSystemSummary();
        if (summary === null) throw new Error("未可靠识别 Muah 顶部摘要，请打开聊天顶部后重试，或手动粘贴保存");
        sendResponse({ ok: true, summary });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
      return false;
    }
    if (message?.type === "PAUSE_CAPTURE") {
      captureArmed = false;
      manualSelectionLocked = true;
      scan("manual-pause", true)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  (async () => {
    try {
      const hint = await chrome.runtime.sendMessage({ type: "GET_TAB_HINT" });
      const candidate = hint?.ok ? hint.result?.candidate : null;
      const match = candidate?.nativeKey?.match(/\|slot-index\|(\d+)$/u);
      if (match && candidate.nativeKey.includes(`${ORIGIN}|slot-index|`)) {
        rememberedSlotIndex = Number(match[1]);
        rememberedSlotLabel = hint.result?.slotNumber ? `Muah 槽位 ${hint.result.slotNumber}` : "";
        captureArmed = false;
        manualSelectionLocked = true;
      }
    } catch (_error) {
      // A fresh tab has no hint; opening the 10-slot dialog will establish one.
    }
    scheduleScan("initial", true);
  })();
})();
