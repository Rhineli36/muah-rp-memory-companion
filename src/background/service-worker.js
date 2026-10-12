import {
  clearArchiveData,
  createArchive,
  createMemoryCheckpoint,
  createSnapshot,
  exportArchive,
  getArchive,
  getGlobalSettings,
  getMemoryDocument,
  getSlotProfile,
  importArchive,
  listArchives,
  listMemoryCheckpoints,
  listMessages,
  saveMessages,
  setMemoryDocument,
  setSlotCorePrompt,
  setGlobalSettings
} from "../core/storage.js";
import { getComparisonSource, saveComparisonSource, getDerivedOutputs, saveDerivedOutput, appendComparisonHistory, listComparisonHistory } from "../core/storage.js";
import { initializeNumberedSlots, manuallyBind, resolveSlot } from "../core/slot-manager.js";
import { ApiClient } from "../api/api-client.js";
import { MemoryEngine } from "../memory/memory-engine.js";
import { OutputEngine, sourceRevision } from "../memory/output-engine.js";

chrome.runtime.onInstalled.addListener(() => {
  // Action clicks are handled below so PWA/app windows can use a standalone companion window.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

const PANEL_URL = chrome.runtime.getURL("src/side-panel/side-panel.html");
const COMPANION_TARGET_KEY = "companion-target-tab-id";
const TARGET_MODE_KEY = "companion-target-mode";
const isMuahUrl = (value) => /^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(String(value || ""));

async function getTargetMode() {
  const stored = await chrome.storage.local.get(TARGET_MODE_KEY);
  return stored[TARGET_MODE_KEY] === "pwa" ? "pwa" : "web";
}

async function describeTarget(tab) {
  const ownerWindow = await chrome.windows.get(tab.windowId);
  return { tab, windowType: ownerWindow.type, mode: ownerWindow.type === "normal" ? "web" : "pwa" };
}

async function findTargetForMode(mode) {
  const candidates = await chrome.tabs.query({ url: ["https://muah.ai/*", "https://*.muah.ai/*"] });
  const described = await Promise.all(candidates.map((tab) => describeTarget(tab).catch(() => null)));
  return described.filter(Boolean)
    .filter((item) => item.mode === mode)
    .sort((left, right) =>
      Number(Boolean(right.tab.active)) - Number(Boolean(left.tab.active)) ||
      Number(right.tab.lastAccessed || 0) - Number(left.tab.lastAccessed || 0)
    )[0] || null;
}

async function pinCompanionTarget(tab) {
  if (!Number.isInteger(tab?.id) || !isMuahUrl(tab.url)) return false;
  await chrome.storage.session.set({ [COMPANION_TARGET_KEY]: tab.id });
  chrome.runtime.sendMessage({ type: "TARGET_CHANGED", tabId: tab.id }).catch(() => {});
  return true;
}

async function getCompanionTarget() {
  const mode = await getTargetMode();
  const stored = await chrome.storage.session.get(COMPANION_TARGET_KEY);
  const tabId = stored[COMPANION_TARGET_KEY];
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isMuahUrl(tab.url)) {
        const described = await describeTarget(tab);
        if (described.mode === mode) return described;
      }
    } catch (_error) {
      await chrome.storage.session.remove(COMPANION_TARGET_KEY);
    }
  }
  const fallback = await findTargetForMode(mode);
  if (fallback) await pinCompanionTarget(fallback.tab);
  return fallback;
}

async function openStandaloneCompanion() {
  const existingTabs = await chrome.tabs.query({ url: PANEL_URL });
  const existing = existingTabs.find((tab) => Number.isInteger(tab.windowId));
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (Number.isInteger(existing.id)) await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.windows.create({
    url: PANEL_URL,
    type: "popup",
    width: 470,
    height: 900,
    focused: true
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const mode = await getTargetMode();
    const ownerWindow = Number.isInteger(tab?.windowId) ? await chrome.windows.get(tab.windowId) : null;
    const clickedMode = ownerWindow?.type === "normal" ? "web" : "pwa";
    if (clickedMode === mode) await pinCompanionTarget(tab);
    else {
      const preferred = await findTargetForMode(mode);
      if (preferred) await pinCompanionTarget(preferred.tab);
    }
    if (mode === "web" && ownerWindow?.type === "normal") {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    await openStandaloneCompanion();
  } catch (error) {
    console.warn("Side Panel unavailable; opening standalone companion window:", error);
    await openStandaloneCompanion();
  }
});

const tabStateKey = (tabId) => `tab-state:${tabId}`;
let observationQueue = Promise.resolve();
const memoryJobs = new Map();
const memoryProgress = new Map();

async function publishProgress(archiveUuid, value) {
  const progress = { archiveUuid, ...value };
  memoryProgress.set(archiveUuid, progress);
  await chrome.storage.session.set({ [`memory-progress:${archiveUuid}`]: progress });
  chrome.runtime.sendMessage({ type: "MEMORY_PROGRESS", ...progress }).catch(() => {});
}

async function assertTabArchive(message, requireArmed = false) {
  const target = await getCompanionTarget();
  const state = await getTabState(message.tabId);
  if (target?.tab?.id !== message.tabId || !state?.resolution?.canReadWrite || state.resolution.archive?.uuid !== message.archiveUuid || state.identitySignature !== message.expectedSignature) {
    throw new Error("The slot or capture source changed. Repeat the action in the current slot.");
  }
  if (requireArmed && state.resolution.identity?.captureArmed !== true) throw new Error("Confirm that the Muah page matches the selected slot, then click Confirm and capture");
  return state;
}

async function generateDerived(message) {
  await assertTabArchive(message);
  const kind = message.kind === "chronological" ? "chronological" : "comparison";
  const [memory, profile, summary, checkpoints, settings] = await Promise.all([
    getMemoryDocument(message.archiveUuid), getSlotProfile(message.archiveUuid), getComparisonSource(message.archiveUuid),
    listMemoryCheckpoints(message.archiveUuid), getGlobalSettings()
  ]);
  if (!memory) throw new Error("Extract long-term memory for the current slot first");
  if (kind === "comparison" && !summary) throw new Error("Read or paste and save the current slot's Muah SYSTEM SUMMARY first");
  const revision = sourceRevision(memory, profile, kind === "comparison" ? summary : null);
  const result = await new OutputEngine(new ApiClient(settings.api)).generate({
    kind, memory, corePrompt: profile?.corePrompt, summary: summary?.summary,
    checkpoints: selectCheckpointReferences(checkpoints), maximum: Math.max(300, Math.min(8000, Number(message.maximum) || 1800))
  });
  const latest = await Promise.all([getMemoryDocument(message.archiveUuid), getSlotProfile(message.archiveUuid), getComparisonSource(message.archiveUuid)]);
  if (sourceRevision(latest[0], latest[1], kind === "comparison" ? latest[2] : null) !== revision) throw new Error("Memory or comparison sources changed during generation. The stale result was discarded; regenerate it.");
  const output = { ...result, archiveUuid: message.archiveUuid, kind, revision, updatedAt: new Date().toISOString(), maximum: Number(message.maximum) || 1800 };
  await saveDerivedOutput(output);
  if (kind === "comparison") await appendComparisonHistory({ ...output, sourceSummary: summary, sourceCorePrompt: profile?.corePrompt || "" });
  return output;
}

function selectCheckpointReferences(checkpoints, maximumCharacters = 12000) {
  const usable = checkpoints.filter((item) => String(item.segmentSummary || "").trim());
  const targetCount = Math.min(24, usable.length);
  const preferred = targetCount === usable.length
    ? usable
    : Array.from({ length: targetCount }, (_unused, index) =>
      usable[Math.round(index * (usable.length - 1) / (targetCount - 1))]
    ).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  const selected = [];
  let size = 0;
  for (const item of preferred) {
    const summary = String(item.segmentSummary || "").trim();
    if (size + summary.length > maximumCharacters && selected.length > 0) continue;
    selected.push({
      fromMessageCount: Number(item.fromMessageCount || 0),
      toMessageCount: Number(item.toMessageCount || 0),
      segmentSummary: summary
    });
    size += summary.length;
  }
  return selected;
}

async function generateMemory(archiveUuid, options = {}) {
  if (memoryJobs.has(archiveUuid)) return memoryJobs.get(archiveUuid);
  const job = (async () => {
    const [settings, archive, initialMemory, slotProfile, allMessages, initialCheckpoints] = await Promise.all([
      getGlobalSettings(),
      getArchive(archiveUuid),
      getMemoryDocument(archiveUuid),
      getSlotProfile(archiveUuid),
      listMessages(archiveUuid, Number.MAX_SAFE_INTEGER),
      listMemoryCheckpoints(archiveUuid)
    ]);
    if (!archive) throw new Error("The current archive does not exist");
    if (allMessages.length === 0) throw new Error("The current slot has no chat records to process");
    const batchSize = Math.max(10, Math.min(200, Number(settings.memory?.recentMessageLimit) || 80));
    const rebuild = Boolean(options.rebuild);
    const maxBatches = Math.max(1, Math.min(50, Number(options.maxBatches) || 20));
    let existingMemory = rebuild ? null : initialMemory;
    let processed = rebuild
      ? 0
      : Math.max(0, Math.min(allMessages.length, Number(
        initialMemory?.memoryStrategyVersion === 2
          ? initialMemory.processedMessageCount
          : initialMemory?.sourceMessageCount || 0
      )));
    const checkpoints = rebuild ? [] : [...initialCheckpoints];
    const checkpointBaseCount = rebuild ? initialCheckpoints.length + (initialMemory ? 1 : 0) : 0;

    if (rebuild && initialMemory) {
      await createMemoryCheckpoint(archiveUuid, initialMemory, {
        reason: "before-full-memory-rebuild",
        fromMessageCount: 0,
        toMessageCount: Number(initialMemory.processedMessageCount || initialMemory.sourceMessageCount || 0),
        segmentSummary: initialMemory.segmentSummary || initialMemory.compactSummary || ""
      });
    }
    if (processed >= allMessages.length) {
      throw new Error("There is no unprocessed chat. Use Rebuild from the beginning to process all history again.");
    }

    const engine = new MemoryEngine(new ApiClient(settings.api));
    let batches = 0;
    await publishProgress(archiveUuid, { running: true, processedMessageCount: processed, totalMessageCount: allMessages.length, checkpointCount: checkpoints.length + checkpointBaseCount });
    while (processed < allMessages.length && batches < maxBatches) {
      const from = processed;
      const to = Math.min(allMessages.length, from + batchSize);
      await publishProgress(archiveUuid, { running: true, from: from + 1, to, processedMessageCount: processed, totalMessageCount: allMessages.length, checkpointCount: checkpoints.length + checkpointBaseCount });
      const extracted = await engine.extract({
        archiveUuid,
        archiveName: archive.name,
        messages: allMessages.slice(from, to),
        existingMemory,
        corePrompt: slotProfile?.corePrompt || "",
        globalPreferences: settings.writingPreferences,
        checkpointReferences: rebuild ? [] : selectCheckpointReferences(checkpoints),
        batchRange: { from, to }
      });
      const document = {
        archiveUuid,
        ...extracted,
        memoryStrategyVersion: 2,
        processedMessageCount: to,
        sourceMessageCount: to,
        totalMessageCount: allMessages.length,
        updatedAt: new Date().toISOString()
      };
      await setMemoryDocument(document);
      const checkpoint = await createMemoryCheckpoint(archiveUuid, document, {
        reason: rebuild ? "full-rebuild-batch" : "incremental-memory-batch",
        fromMessageCount: from,
        toMessageCount: to,
        segmentSummary: extracted.segmentSummary
      });
      checkpoints.push(checkpoint);
      existingMemory = { ...document, checkpointCount: checkpoints.length + checkpointBaseCount };
      processed = to;
      batches += 1;
      await publishProgress(archiveUuid, {
        running: true,
        processedMessageCount: processed,
        totalMessageCount: allMessages.length,
        checkpointCount: checkpoints.length + checkpointBaseCount
      });
    }
    const result = { ...existingMemory, checkpointCount: checkpoints.length + checkpointBaseCount };
    await setMemoryDocument(result);
    chrome.runtime.sendMessage({ type: "MEMORY_CHANGED", archiveUuid, memory: result }).catch(() => {});
    return result;
  })();
  memoryJobs.set(archiveUuid, job);
  try {
    return await job;
  } catch (error) {
    await publishProgress(archiveUuid, { ...(memoryProgress.get(archiveUuid) || {}), running: false, error: error.message });
    throw error;
  } finally {
    memoryJobs.delete(archiveUuid);
    const progress = memoryProgress.get(archiveUuid);
    if (progress?.running) await publishProgress(archiveUuid, { ...progress, running: false });
  }
}

async function maybeAutoGenerateMemory(archive) {
  const settings = await getGlobalSettings();
  if (!settings.memory?.autoExtractEnabled) return null;
  const existing = await getMemoryDocument(archive.uuid);
  const threshold = Math.max(1, Math.min(200, Number(settings.memory.triggerMessageCount) || 6));
  const processed = Number(existing?.sourceMessageCount || 0);
  if (archive.messageCount - processed < threshold) return null;
  try {
    return await generateMemory(archive.uuid, { maxBatches: 1 });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: "MEMORY_ERROR",
      archiveUuid: archive.uuid,
      error: error.message || String(error)
    }).catch(() => {});
    return null;
  }
}

async function getTabState(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const result = await chrome.storage.session.get(tabStateKey(tabId));
  return result[tabStateKey(tabId)] || null;
}

async function setTabState(tabId, value) {
  await chrome.storage.session.set({ [tabStateKey(tabId)]: value });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", tabId, state: value }).catch(() => {});
}

function identitySignature(identity) {
  return (identity?.candidates || [])
    .map((candidate) => candidate.nativeKey)
    .filter(Boolean)
    .sort()
    .join("|");
}

function scopeIdentity(identity, surface) {
  const normalizedSurface = surface === "pwa" ? "pwa" : "web";
  const prefix = normalizedSurface === "pwa" ? "pwa|" : "";
  return {
    ...(identity || {}),
    surface: normalizedSurface,
    label: `${normalizedSurface === "pwa" ? "PWA" : "网页"} · ${identity?.label || "Unrecognized slot"}`,
    candidates: (identity?.candidates || []).map((candidate) => ({
      ...candidate,
      nativeKey: prefix && !String(candidate.nativeKey || "").startsWith(prefix)
        ? `${prefix}${candidate.nativeKey}`
        : candidate.nativeKey
    }))
  };
}

async function observeTab(tabId, identity, messages, corePrompt = "", reason = "automatic", summary = null) {
  if (!Number.isInteger(tabId)) throw new Error("Missing sender tab");
  const target = await getCompanionTarget();
  // The mode switch is a hard gate: observations from the other surface are ignored.
  if (!target?.tab?.id || target.tab.id !== tabId) return getTabState(tabId);
  identity = scopeIdentity(identity, target.mode);
  const previous = await getTabState(tabId);
  const resolution = await resolveSlot(identity);
  const nextSignature = identitySignature(identity);

  // Only treat a confirmed new archive as a switch. Transient/ambiguous DOM never replaces state.
  if (
    resolution.canReadWrite &&
    previous?.lastConfirmedArchiveUuid &&
    previous.lastConfirmedArchiveUuid !== resolution.archive.uuid
  ) {
    await createSnapshot(previous.lastConfirmedArchiveUuid, "slot-switch");
  }

  const settings = await getGlobalSettings();
  const captureMode = settings.capture?.mode === "manual" ? "manual" : "automatic";
  const captureThreshold = Math.max(1, Math.min(50, Number(settings.capture?.triggerMessageCount) || 2));
  const observedMessageCount = Array.isArray(messages) ? messages.length : 0;
  const sameArchive = previous?.lastConfirmedArchiveUuid === resolution.archive?.uuid;
  const observedSignatures = (Array.isArray(messages) ? messages : []).map((item, index) => ({
    key: item?.sourceId
      ? `${item.role === "user" ? "user" : "assistant"}:source:${item.sourceId}`
      : `${item.role === "user" ? "user" : "assistant"}:position:${Number.isFinite(Number(item?.pageOrder)) ? Number(item.pageOrder) : index}`,
    text: String(item?.text || "")
  }));
  const previousObserved = new Map((sameArchive && Array.isArray(previous?.lastObservedMessages)
    ? previous.lastObservedMessages : []).map((item) => [item.key, item.text]));
  const pendingKeys = new Set(sameArchive && Array.isArray(previous?.capturePendingKeys)
    ? previous.capturePendingKeys : []);
  for (const item of observedSignatures) {
    if (previousObserved.get(item.key) !== item.text) pendingKeys.add(item.key);
  }
  let capturePendingCount = pendingKeys.size;
  const manualSave = reason === "manual-save";
  const shouldSaveMessages = manualSave || (captureMode === "automatic" && capturePendingCount >= captureThreshold);

  let saveResult = { inserted: 0, updated: 0 };
  if (resolution.canReadWrite && observedMessageCount > 0 && shouldSaveMessages) {
    saveResult = await saveMessages(resolution.archive.uuid, messages);
    resolution.archive.messageCount += saveResult.inserted;
    if (saveResult.inserted > 0 || saveResult.updated > 0) resolution.archive.updatedAt = new Date().toISOString();
    pendingKeys.clear();
    capturePendingCount = 0;
  }
  if (resolution.canReadWrite && String(corePrompt || "").trim()) {
    const profile = await setSlotCorePrompt(resolution.archive.uuid, corePrompt, "muah-auto");
    chrome.runtime.sendMessage({ type: "SLOT_PROFILE_CHANGED", archiveUuid: resolution.archive.uuid, profile }).catch(() => {});
  }
  if (resolution.canReadWrite && identity.captureArmed === true && summary !== null) {
    await saveComparisonSource(resolution.archive.uuid, summary, "muah-auto");
  }

  const state = {
    resolution,
    identitySignature: nextSignature,
    lastObservedAt: new Date().toISOString(),
    lastSaveReason: reason,
    lastInserted: saveResult.inserted,
    lastUpdated: saveResult.updated,
    captureMode,
    captureThreshold,
    capturePendingCount,
    lastSavedPageMessageCount: observedMessageCount,
    lastObservedMessages: observedSignatures,
    capturePendingKeys: [...pendingKeys],
    captureSavedThisScan: Boolean(resolution.canReadWrite && observedMessageCount > 0 && shouldSaveMessages),
    lastConfirmedArchiveUuid: resolution.canReadWrite
      ? resolution.archive.uuid
      : previous?.lastConfirmedArchiveUuid || null,
    lastConfirmedIdentity: resolution.canReadWrite
      ? resolution.identity
      : previous?.lastConfirmedIdentity || null
  };
  await setTabState(tabId, state);
  if (resolution.canReadWrite && saveResult.inserted > 0) {
    maybeAutoGenerateMemory(resolution.archive).catch(console.error);
  }
  return state;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabStateKey(tabId));
  chrome.storage.session.get(COMPANION_TARGET_KEY).then((stored) => {
    if (stored[COMPANION_TARGET_KEY] !== tabId) return;
    return chrome.storage.session.remove(COMPANION_TARGET_KEY).then(() => {
      chrome.runtime.sendMessage({ type: "TARGET_CHANGED", tabId: null }).catch(() => {});
    });
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["STATE_CHANGED", "MEMORY_CHANGED", "MEMORY_PROGRESS", "MEMORY_ERROR", "SLOT_PROFILE_CHANGED", "TARGET_CHANGED"].includes(message?.type)) return false;

  (async () => {
    switch (message?.type) {
      case "OBSERVATION":
        observationQueue = observationQueue.then(
          () => observeTab(sender.tab?.id, message.identity, message.messages, message.corePrompt, message.reason, message.summary ?? null),
          () => observeTab(sender.tab?.id, message.identity, message.messages, message.corePrompt, message.reason, message.summary ?? null)
        );
        return observationQueue;

      case "GET_TAB_STATE":
        return getTabState(message.tabId);

      case "GET_COMPANION_TARGET":
        return getCompanionTarget();

      case "GET_TARGET_MODE":
        return { mode: await getTargetMode() };

      case "SET_TARGET_MODE": {
        const mode = message.mode === "pwa" ? "pwa" : "web";
        await chrome.storage.local.set({ [TARGET_MODE_KEY]: mode });
        const target = await findTargetForMode(mode);
        if (!target) {
          await chrome.storage.session.remove(COMPANION_TARGET_KEY);
          chrome.runtime.sendMessage({ type: "TARGET_CHANGED", tabId: null }).catch(() => {});
          throw new Error(mode === "pwa"
            ? "No running Muah PWA window was found"
            : "No Muah page was found in a regular Chrome window");
        }
        await pinCompanionTarget(target.tab);
        return target;
      }

      case "GET_TAB_HINT": {
        const state = await getTabState(sender.tab?.id);
        const candidate = state?.lastConfirmedIdentity?.candidates?.find((item) => item.kind === "slot-index");
        return candidate ? { candidate, slotNumber: state.lastConfirmedIdentity.slotNumber || null } : null;
      }

      case "LIST_ARCHIVES":
        return listArchives();

      case "CREATE_ARCHIVE":
        return createArchive(message.name, { slotSurface: message.surface === "pwa" ? "pwa" : "web" });

      case "INITIALIZE_NUMBERED_SLOTS": {
        const current = await getTabState(message.tabId);
        const pageUrl = current?.resolution?.identity?.pageUrl;
        if (!pageUrl) throw new Error("No identity information has been received from the current Muah page");
        return initializeNumberedSlots(pageUrl, 10, current?.resolution?.identity?.surface || "web");
      }

      case "BIND_SLOT": {
        const target = await getCompanionTarget();
        if (target?.tab?.id !== message.tabId) throw new Error("The capture source changed. Confirm the current slot again.");
        const current = await getTabState(message.tabId);
        if (!current?.resolution?.identity) throw new Error("No slot evidence has been received from the current page");
        if (message.expectedSignature !== current.identitySignature) {
          throw new Error("The slot state just changed. Redetect it before binding.");
        }
        if (current.resolution.archive?.uuid && current.resolution.archive.uuid !== message.archiveUuid) {
          await createSnapshot(current.resolution.archive.uuid, "before-rebinding");
        }
        const resolution = await manuallyBind(current.resolution.identity, message.archiveUuid);
        if (
          current.lastConfirmedArchiveUuid &&
          current.lastConfirmedArchiveUuid !== resolution.archive.uuid
        ) {
          await createSnapshot(current.lastConfirmedArchiveUuid, "slot-switch");
        }
        const state = {
          ...current,
          resolution,
          identitySignature: identitySignature(resolution.identity),
          lastConfirmedArchiveUuid: resolution.archive.uuid,
          lastConfirmedIdentity: resolution.identity
        };
        await setTabState(message.tabId, state);
        return state;
      }

      case "LIST_MESSAGES":
        return listMessages(message.archiveUuid, message.limit || 500);

      case "GET_MEMORY":
        return getMemoryDocument(message.archiveUuid);

      case "LIST_MEMORY_CHECKPOINTS":
        return listMemoryCheckpoints(message.archiveUuid);

      case "GET_SLOT_PROFILE":
        return getSlotProfile(message.archiveUuid);

      case "SAVE_SLOT_CORE_PROMPT":
        await assertTabArchive(message, message.source === "muah-auto");
        return setSlotCorePrompt(message.archiveUuid, message.corePrompt, message.source || "manual");

      case "GET_COMPARISON_DATA":
        return { source: await getComparisonSource(message.archiveUuid), outputs: await getDerivedOutputs(message.archiveUuid), history: await listComparisonHistory(message.archiveUuid) };

      case "SAVE_COMPARISON_SOURCE":
        await assertTabArchive(message, message.source === "muah-auto");
        return saveComparisonSource(message.archiveUuid, message.summary, message.source || "manual");

      case "GENERATE_DERIVED_OUTPUT":
        return generateDerived(message);

      case "GET_MEMORY_PROGRESS": {
        const progress = memoryProgress.get(message.archiveUuid) || (await chrome.storage.session.get(`memory-progress:${message.archiveUuid}`))[`memory-progress:${message.archiveUuid}`];
        return progress ? { ...progress, running: memoryJobs.has(message.archiveUuid) } : null;
      }

      case "GENERATE_MEMORY":
        return generateMemory(message.archiveUuid, { maxBatches: 20 });

      case "REBUILD_MEMORY":
        return generateMemory(message.archiveUuid, { rebuild: true, maxBatches: 50 });

      case "CLEAR_ARCHIVE_DATA":
        if (memoryJobs.has(message.archiveUuid)) throw new Error("Memory extraction is running. Wait for it to finish before clearing data.");
        return clearArchiveData(message.archiveUuid);

      case "EXPORT_ARCHIVE":
        return exportArchive(message.archiveUuid);

      case "IMPORT_ARCHIVE":
        return importArchive(message.payload, message.surface === "pwa" ? "pwa" : "web");

      case "IMPORT_STORY_HTML": {
        const rows = Array.isArray(message.messages) ? message.messages : [];
        if (rows.length === 0) throw new Error("The HTML file contains no importable chat records");
        if (rows.length > 100000) throw new Error("The HTML contains an implausible number of chat records; import stopped");
        const surface = message.surface === "pwa" ? "pwa" : "web";
        const archive = await createArchive(`${String(message.name || "HTML story import").trim() || "HTML story import"}（HTML 导入）`, {
          slotSurface: surface,
          importedFromHtml: true,
          importedAt: new Date().toISOString()
        });
        await saveMessages(archive.uuid, rows.map((item, index) => ({
          role: item?.role === "user" ? "user" : "assistant",
          text: String(item?.text || "").slice(0, 1000000),
          sourceId: `html-import:${index + 1}`,
          pageOrder: index,
          observedAt: item?.observedAt || new Date().toISOString()
        })));
        await createSnapshot(archive.uuid, "html-import");
        return getArchive(archive.uuid);
      }

      case "GET_GLOBAL_SETTINGS":
        return getGlobalSettings();

      case "LIST_API_MODELS":
        return new ApiClient(message.config || {}).listModels();

      case "TEST_API_CONNECTION":
        return new ApiClient(message.config || {}).testConnection();

      case "SET_GLOBAL_SETTINGS":
        return setGlobalSettings(message.value);

      default:
        throw new Error(`Unknown message type: ${message?.type}`);
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("Muah RP Memory Companion:", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});
