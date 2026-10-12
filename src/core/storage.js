import { sourceRevision } from "./source-revision.js";

const DB_NAME = "muah-rp-memory-companion";
const DB_VERSION = 5;

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  writingPreferences: [
    "Natural dialogue in the roleplay's language",
    "Avoid excessively ornate prose",
    "Do not make characters disclose deeply personal information without narrative justification",
    "Relationship development must remain consistent with long-term story events",
    "Avoid character personality drift"
  ],
  api: {
    baseUrl: "",
    apiKey: "",
    modelName: "",
    temperature: 0.7,
    maxTokens: 1200
  },
  memory: {
    autoExtractEnabled: false,
    triggerMessageCount: 6,
    recentMessageLimit: 80
  },
  capture: {
    mode: "automatic",
    triggerMessageCount: 2
  }
});

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("archives")) {
        const archives = db.createObjectStore("archives", { keyPath: "uuid" });
        archives.createIndex("updatedAt", "updatedAt");
      }

      if (!db.objectStoreNames.contains("bindings")) {
        const bindings = db.createObjectStore("bindings", { keyPath: "nativeKey" });
        bindings.createIndex("archiveUuid", "archiveUuid");
      }

      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: ["archiveUuid", "messageKey"] });
        messages.createIndex("byArchive", ["archiveUuid", "capturedAt"]);
      }

      if (!db.objectStoreNames.contains("snapshots")) {
        const snapshots = db.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
        snapshots.createIndex("byArchive", ["archiveUuid", "createdAt"]);
      }

      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("memoryDocuments")) {
        db.createObjectStore("memoryDocuments", { keyPath: "archiveUuid" });
      }
      if (!db.objectStoreNames.contains("memoryCheckpoints")) {
        const checkpoints = db.createObjectStore("memoryCheckpoints", { keyPath: "id", autoIncrement: true });
        checkpoints.createIndex("byArchive", ["archiveUuid", "createdAt"]);
      }
      if (!db.objectStoreNames.contains("slotProfiles")) {
        db.createObjectStore("slotProfiles", { keyPath: "archiveUuid" });
      }
      if (!db.objectStoreNames.contains("comparisonSources")) db.createObjectStore("comparisonSources", { keyPath: "archiveUuid" });
      if (!db.objectStoreNames.contains("derivedOutputs")) db.createObjectStore("derivedOutputs", { keyPath: ["archiveUuid", "kind"] });
      if (!db.objectStoreNames.contains("comparisonHistory")) {
        const history = db.createObjectStore("comparisonHistory", { keyPath: "id", autoIncrement: true });
        history.createIndex("byArchive", ["archiveUuid", "createdAt"]);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function createArchive(name, metadata = {}) {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const archive = {
    uuid: crypto.randomUUID(),
    name: String(name || "Untitled archive").trim() || "Untitled archive",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    metadata
  };
  const tx = db.transaction("archives", "readwrite");
  tx.objectStore("archives").add(archive);
  await transactionDone(tx);
  return archive;
}

export async function getArchive(uuid) {
  const db = await openDatabase();
  const tx = db.transaction("archives", "readonly");
  return requestToPromise(tx.objectStore("archives").get(uuid));
}

export async function listArchives() {
  const db = await openDatabase();
  const tx = db.transaction("archives", "readonly");
  const rows = await requestToPromise(tx.objectStore("archives").getAll());
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getBindings(nativeKeys) {
  const db = await openDatabase();
  const tx = db.transaction("bindings", "readonly");
  const store = tx.objectStore("bindings");
  const found = await Promise.all(nativeKeys.map((key) => requestToPromise(store.get(key))));
  return found.filter(Boolean);
}

export async function getBindingsForArchive(archiveUuid) {
  const db = await openDatabase();
  const tx = db.transaction("bindings", "readonly");
  return requestToPromise(tx.objectStore("bindings").index("archiveUuid").getAll(archiveUuid));
}

export async function bindNativeKey(nativeKey, archiveUuid, details = {}) {
  const archive = await getArchive(archiveUuid);
  if (!archive) throw new Error("Target archive does not exist");
  const db = await openDatabase();
  const tx = db.transaction(["bindings", "archives"], "readwrite");
  const slotMatch = nativeKey.match(/\|slot-index\|(\d+)$/u);
  if (slotMatch) {
    const surface = nativeKey.startsWith("pwa|") ? "pwa" : "web";
    const archives = await requestToPromise(tx.objectStore("archives").getAll());
    const fixedSlotNumber = Number(slotMatch[1]) + 1;
    for (const row of archives) {
      if (row.uuid !== archiveUuid && row.metadata?.fixedSlotNumber === fixedSlotNumber && (row.metadata?.slotSurface || "web") === surface) {
        const metadata = { ...row.metadata };
        delete metadata.fixedSlotNumber;
        tx.objectStore("archives").put({ ...row, metadata });
      }
    }
    tx.objectStore("archives").put({ ...archive, metadata: { ...archive.metadata, fixedSlotNumber, slotSurface: surface } });
  }
  tx.objectStore("bindings").put({
    nativeKey,
    archiveUuid,
    confirmed: true,
    details,
    updatedAt: new Date().toISOString()
  });
  await transactionDone(tx);
}

async function messageDigest(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const TRAILING_MESSAGE_CONTROLS = /(?:\s+(?:复制|copy|生成语音|generate audio|编辑|edit|删除|delete|重新生成|regenerate|朗读|read aloud|更多|more)){2,}\s*$/iu;
const TRAILING_TOKEN_METADATA = /(?:\s*\d{1,2}:\d{2}(?:\s*-\s*[^()\n]{0,80})?)?\s*\(?\s*[\d,.]+\s+tokens?\s*-\s*[\d,.]+\s+tokens?\s+total\s*\)?\s*$/iu;

export function cleanStoredMessageText(value) {
  return String(value || "")
    .replace(/\[\[MUAH_RP_MEMORY_CONTEXT_BEGIN\]\][\s\S]*?\[\[MUAH_RP_MEMORY_CONTEXT_END\]\]/giu, " ")
    .replace(/<MEMORY(?:_PART\b[^>]*)?>[\s\S]*?<\/MEMORY(?:_PART)?>/giu, " ")
    .replace(TRAILING_TOKEN_METADATA, " ")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(TRAILING_MESSAGE_CONTROLS, "")
    .trim();
}

function messageIdentityText(value) {
  return cleanStoredMessageText(value).replace(/\s+/gu, " ").trim();
}

function isDerivedSystemContent(text) {
  const value = cleanStoredMessageText(text);
  return /\bsystem summary\b/iu.test(value) || /^(?:聊天已重置[。.!]?|chat (?:has been )?reset[.!]?)$/iu.test(value);
}

function compareMessages(left, right) {
  const leftSequence = Number(left.sequence);
  const rightSequence = Number(right.sequence);
  if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftOrder = Number.isFinite(Number(left.pageOrder)) ? Number(left.pageOrder) : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(Number(right.pageOrder)) ? Number(right.pageOrder) : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const captured = String(left.capturedAt || left.observedAt || "")
    .localeCompare(String(right.capturedAt || right.observedAt || ""));
  if (captured) return captured;
  return String(left.messageKey || "").localeCompare(String(right.messageKey || ""));
}

export function findRegenerationCandidate(existingSorted, anchorMessageKey, role, usedKeys = new Set()) {
  const anchorIndex = existingSorted.findIndex((row) => row.messageKey === anchorMessageKey);
  const candidate = anchorIndex >= 0 ? existingSorted[anchorIndex + 1] : null;
  return candidate?.role === role && !usedKeys.has(candidate.messageKey) ? candidate : null;
}

export function assignMessageSequences(existingSorted, resolvedItems, usedKeys) {
  const fallbackSequence = new Map(existingSorted.map((row, index) => [
    row.messageKey,
    Number.isFinite(Number(row.sequence)) ? Number(row.sequence) : index + 1
  ]));
  const authoritative = existingSorted.length === 0 || existingSorted.every((row) => usedKeys.has(row.messageKey));
  if (authoritative) return resolvedItems.map((_row, index) => index + 1);

  const sequences = resolvedItems.map(({ previous }) => previous ? fallbackSequence.get(previous.messageKey) : null);
  const maxExisting = Math.max(0, ...fallbackSequence.values());
  let start = 0;
  while (start < sequences.length) {
    if (Number.isFinite(sequences[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < sequences.length && !Number.isFinite(sequences[end + 1])) end += 1;
    const before = start > 0 && Number.isFinite(sequences[start - 1]) ? sequences[start - 1] : null;
    const after = end + 1 < sequences.length && Number.isFinite(sequences[end + 1]) ? sequences[end + 1] : null;
    const count = end - start + 1;
    for (let offset = 0; offset < count; offset += 1) {
      if (before !== null && after !== null) {
        sequences[start + offset] = before + ((after - before) * (offset + 1)) / (count + 1);
      } else if (before !== null) {
        // A partial/virtualized transcript can begin at an old anchor and then
        // jump to today's messages. Never place that new tail on top of hidden
        // historical rows that already follow the anchor.
        const appendBase = before >= maxExisting ? before : maxExisting;
        sequences[start + offset] = appendBase + offset + 1;
      } else if (after !== null) {
        sequences[start + offset] = after - (count - offset);
      } else {
        sequences[start + offset] = maxExisting + offset + 1;
      }
    }
    start = end + 1;
  }
  return sequences;
}

export async function saveMessages(archiveUuid, observedMessages) {
  if (!archiveUuid || !Array.isArray(observedMessages) || observedMessages.length === 0) {
    return { inserted: 0 };
  }
  const archive = await getArchive(archiveUuid);
  if (!archive) throw new Error("Archive does not exist");

  const normalized = [];
  const occurrences = new Map();
  for (const [pageOrder, item] of observedMessages.entries()) {
    const text = cleanStoredMessageText(item.text);
    if (!text) continue;
    const role = item.role === "user" ? "user" : "assistant";
    // Paragraph-only differences must update the existing row instead of
    // creating a duplicate when Muah is scanned again.
    const occurrenceBase = `${role}\u0000${messageIdentityText(text)}`;
    const occurrence = (occurrences.get(occurrenceBase) || 0) + 1;
    occurrences.set(occurrenceBase, occurrence);
    const sourceKey = item.sourceId
      ? `source:${item.sourceId}`
      : `content:${await messageDigest(`${occurrenceBase}\u0000${occurrence}`)}`;
    normalized.push({
      role,
      text,
      sourceKey,
      pageOrder: Number.isFinite(Number(item.pageOrder)) ? Number(item.pageOrder) : pageOrder,
      observedAt: item.observedAt || new Date().toISOString()
    });
  }

  const db = await openDatabase();
  const readTx = db.transaction("messages", "readonly");
  const readStore = readTx.objectStore("messages");
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  const existingRows = await requestToPromise(readStore.getAll(range));
  const existingByKey = new Map(existingRows.map((row) => [row.messageKey, row]));
  const existingSorted = [...existingRows].sort(compareMessages);
  const existingByContent = new Map();
  for (const row of existingRows) {
    const contentKey = `${row.role}\u0000${messageIdentityText(row.text)}`;
    if (!existingByContent.has(contentKey)) existingByContent.set(contentKey, []);
    existingByContent.get(contentKey).push(row);
  }

  const now = new Date().toISOString();
  const writeTx = db.transaction(["messages", "archives"], "readwrite");
  const messageStore = writeTx.objectStore("messages");
  let inserted = 0;
  let updated = 0;
  const usedKeys = new Set();
  let previousObservedMatch = null;
  const resolvedItems = [];
  for (const item of normalized) {
    let previous = existingByKey.get(item.sourceKey);
    if (previous && usedKeys.has(previous.messageKey)) previous = null;
    if (!previous) {
      const contentKey = `${item.role}\u0000${messageIdentityText(item.text)}`;
      previous = (existingByContent.get(contentKey) || []).find((row) => !usedKeys.has(row.messageKey));
    }
    // Regeneration may replace the DOM message id and text together. If the
    // preceding message is anchored, reuse the next stored position instead
    // of appending the regenerated branch as a duplicate.
    if (!previous && previousObservedMatch) {
      const candidate = findRegenerationCandidate(existingSorted, previousObservedMatch.messageKey, item.role, usedKeys);
      // Only the final stored response may be regenerated implicitly. Reusing
      // a historical middle row caused imported story beginnings to be
      // overwritten when Muah rendered a partial window.
      if (candidate?.messageKey === existingSorted.at(-1)?.messageKey) previous = candidate;
    }
    let messageKey = previous?.messageKey || item.sourceKey;
    if (!previous && usedKeys.has(messageKey)) {
      messageKey = `${item.sourceKey}:duplicate:${item.pageOrder}`;
    }
    usedKeys.add(messageKey);
    if (!previous) inserted += 1;
    resolvedItems.push({ item, previous, messageKey });
    previousObservedMatch = previous || null;
  }

  const sequences = assignMessageSequences(existingSorted, resolvedItems, usedKeys);
  for (const [index, { item, previous, messageKey }] of resolvedItems.entries()) {
    const sequence = sequences[index];
    if (previous && (
      previous.role !== item.role ||
      cleanStoredMessageText(previous.text) !== item.text ||
      Number(previous.pageOrder) !== Number(item.pageOrder) ||
      Number(previous.sequence) !== sequence
    )) updated += 1;
    messageStore.put({
      archiveUuid,
      messageKey,
      role: item.role,
      text: item.text,
      capturedAt: previous?.capturedAt || now,
      observedAt: previous?.observedAt || item.observedAt,
      pageOrder: item.pageOrder,
      sequence,
      orderUpdatedAt: now
    });
  }
  // Clean old rows even when they are currently outside the rendered Muah transcript.
  for (const [legacyIndex, row] of existingSorted.entries()) {
    if (usedKeys.has(row.messageKey)) continue;
    const cleaned = cleanStoredMessageText(row.text);
    const sequence = Number.isFinite(Number(row.sequence)) ? Number(row.sequence) : legacyIndex + 1;
    if (cleaned && (cleaned !== row.text || Number(row.sequence) !== sequence)) {
      messageStore.put({ ...row, text: cleaned, sequence });
    }
  }
  writeTx.objectStore("archives").put({
    ...archive,
    // Reconcile counters on every write; older builds could drift when two
    // observed nodes shared a source id.
    messageCount: existingRows.length + inserted,
    updatedAt: inserted > 0 || updated > 0 ? now : archive.updatedAt
  });
  await transactionDone(writeTx);
  return { inserted, updated };
}

export async function listMessages(archiveUuid, limit = 500) {
  const db = await openDatabase();
  const tx = db.transaction("messages", "readonly");
  const index = tx.objectStore("messages").index("byArchive");
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  const rows = (await requestToPromise(index.getAll(range)))
    .map((row) => ({ ...row, text: cleanStoredMessageText(row.text) }))
    .filter((row) => row.text && !isDerivedSystemContent(row.text));
  return rows.sort(compareMessages).slice(-Math.max(1, limit));
}

export async function createSnapshot(archiveUuid, reason) {
  const archive = await getArchive(archiveUuid);
  if (!archive) return null;
  const [messages, memory, slotProfile, comparisonSource, derivedOutputs] = await Promise.all([
    listMessages(archiveUuid, Number.MAX_SAFE_INTEGER),
    getMemoryDocument(archiveUuid),
    getSlotProfile(archiveUuid),
    getComparisonSource(archiveUuid),
    getDerivedOutputs(archiveUuid)
  ]);
  const db = await openDatabase();
  const tx = db.transaction("snapshots", "readwrite");
  const snapshot = {
    archiveUuid,
    createdAt: new Date().toISOString(),
    reason,
    archive: { ...archive },
    messages,
    memory: memory || null,
    slotProfile: slotProfile || null,
    comparisonSource: comparisonSource || null,
    derivedOutputs
  };
  const id = await requestToPromise(tx.objectStore("snapshots").add(snapshot));
  await transactionDone(tx);
  return { ...snapshot, id };
}

export async function listSnapshots(archiveUuid) {
  const db = await openDatabase();
  const tx = db.transaction("snapshots", "readonly");
  const index = tx.objectStore("snapshots").index("byArchive");
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  return requestToPromise(index.getAll(range));
}

export async function exportArchive(archiveUuid) {
  const archive = await getArchive(archiveUuid);
  if (!archive) throw new Error("Archive does not exist");
  return {
    format: "muah-rp-memory-companion",
    version: 4,
    exportedAt: new Date().toISOString(),
    archive,
    messages: await listMessages(archiveUuid, Number.MAX_SAFE_INTEGER),
    snapshots: await listSnapshots(archiveUuid),
    memory: await getMemoryDocument(archiveUuid),
    memoryCheckpoints: await listMemoryCheckpoints(archiveUuid),
    slotProfile: await getSlotProfile(archiveUuid),
    comparisonSource: await getComparisonSource(archiveUuid),
    derivedOutputs: await getDerivedOutputs(archiveUuid),
    comparisonHistory: await listComparisonHistory(archiveUuid)
  };
}

export function recoverImportedMessages(payload) {
  const current = Array.isArray(payload?.messages) ? payload.messages : [];
  const sequences = current.map((item) => Number(item.sequence)).filter(Number.isFinite);
  const duplicateSequence = new Set(sequences).size !== sequences.length;
  const countMismatch = Number(payload?.archive?.messageCount || 0) !== current.length;
  if (!duplicateSequence && !countMismatch) return current;

  // Damaged v0.22.0 exports can still contain an intact import/switch snapshot.
  // Start from the largest snapshot, then append only genuinely new live rows.
  const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
  const best = snapshots
    .filter((item) => Array.isArray(item?.messages))
    .sort((left, right) => right.messages.length - left.messages.length)[0];
  if (!best?.messages?.length) return current;
  const identity = (item) => `${item?.role === "user" ? "user" : "assistant"}\u0000${cleanStoredMessageText(item?.text)}`;
  const recovered = best.messages.map((item) => ({ ...item }));
  const seen = new Set(recovered.map(identity));
  for (const item of current) {
    const key = identity(item);
    if (!cleanStoredMessageText(item?.text) || seen.has(key)) continue;
    recovered.push({ ...item, sequence: recovered.length + 1 });
    seen.add(key);
  }
  return recovered;
}

export async function importArchive(payload, surface = "web") {
  if (payload?.format !== "muah-rp-memory-companion" || ![1, 2, 3, 4].includes(payload?.version)) {
    throw new Error("Unsupported or invalid backup file");
  }
  if (!payload.archive || !Array.isArray(payload.messages)) {
    throw new Error("Backup is missing archive data");
  }

  // Import always creates an independent UUID. It never silently overwrites local data.
  const archive = await createArchive(`${payload.archive.name || "Imported archive"} (imported)`, {
    importedFromUuid: payload.archive.uuid || null,
    importedAt: new Date().toISOString(),
    slotSurface: surface === "pwa" ? "pwa" : "web"
  });
  const sourceMessages = recoverImportedMessages(payload);
  const messages = sourceMessages.map((item) => ({
    role: item.role,
    text: item.text,
    sourceId: `import:${item.messageKey || crypto.randomUUID()}`,
    observedAt: item.observedAt || item.capturedAt
  }));
  await saveMessages(archive.uuid, messages);

  if (Array.isArray(payload.snapshots) && payload.snapshots.length > 0) {
    const db = await openDatabase();
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    for (const oldSnapshot of payload.snapshots) {
      store.add({
        archiveUuid: archive.uuid,
        createdAt: oldSnapshot.createdAt || new Date().toISOString(),
        reason: `imported:${oldSnapshot.reason || "snapshot"}`,
        archive: { ...(oldSnapshot.archive || {}), uuid: archive.uuid, name: archive.name },
        messages: Array.isArray(oldSnapshot.messages)
          ? oldSnapshot.messages.map((item) => ({ ...item, archiveUuid: archive.uuid }))
          : [],
        memory: oldSnapshot.memory
          ? { ...oldSnapshot.memory, archiveUuid: archive.uuid }
          : null,
        slotProfile: oldSnapshot.slotProfile ? { ...oldSnapshot.slotProfile, archiveUuid: archive.uuid } : null,
        comparisonSource: oldSnapshot.comparisonSource ? { ...oldSnapshot.comparisonSource, archiveUuid: archive.uuid } : null,
        derivedOutputs: Array.isArray(oldSnapshot.derivedOutputs) ? oldSnapshot.derivedOutputs.map((item) => ({ ...item, archiveUuid: archive.uuid })) : []
      });
    }
    await transactionDone(tx);
  }
  if (payload.memory && typeof payload.memory === "object") {
    await setMemoryDocument({
      ...payload.memory,
      archiveUuid: archive.uuid,
      importedAt: new Date().toISOString()
    });
  }
  if (Array.isArray(payload.memoryCheckpoints) && payload.memoryCheckpoints.length > 0) {
    const db = await openDatabase();
    const tx = db.transaction("memoryCheckpoints", "readwrite");
    const store = tx.objectStore("memoryCheckpoints");
    for (const checkpoint of payload.memoryCheckpoints) {
      store.add({
        archiveUuid: archive.uuid,
        createdAt: checkpoint.createdAt || new Date().toISOString(),
        reason: `imported:${checkpoint.reason || "memory-checkpoint"}`,
        fromMessageCount: Number(checkpoint.fromMessageCount || 0),
        toMessageCount: Number(checkpoint.toMessageCount || 0),
        segmentSummary: String(checkpoint.segmentSummary || ""),
        memory: checkpoint.memory ? { ...checkpoint.memory, archiveUuid: archive.uuid } : null
      });
    }
    await transactionDone(tx);
  }
  if (payload.slotProfile && typeof payload.slotProfile === "object") {
    await setSlotCorePrompt(
      archive.uuid,
      payload.slotProfile.corePrompt || "",
      "import"
    );
  }
  if (payload.comparisonSource) await saveComparisonSource(archive.uuid, payload.comparisonSource.summary || "", "import");
  if (Array.isArray(payload.derivedOutputs)) {
    const [memory, profile, summary] = await Promise.all([getMemoryDocument(archive.uuid), getSlotProfile(archive.uuid), getComparisonSource(archive.uuid)]);
    for (const output of payload.derivedOutputs) {
      if (["chronological", "comparison"].includes(output.kind)) {
        const wasCurrent = output.revision === sourceRevision(payload.memory, payload.slotProfile, output.kind === "comparison" ? payload.comparisonSource : null);
        await saveDerivedOutput({ ...output, archiveUuid: archive.uuid, revision: wasCurrent ? sourceRevision(memory, profile, output.kind === "comparison" ? summary : null) : null, imported: true });
      }
    }
  }
  if (Array.isArray(payload.comparisonHistory)) {
    for (const item of payload.comparisonHistory) {
      const { id: _oldId, ...row } = item;
      await appendComparisonHistory({ ...row, archiveUuid: archive.uuid, sourceSummary: row.sourceSummary ? { ...row.sourceSummary, archiveUuid: archive.uuid } : null });
    }
  }
  await createSnapshot(archive.uuid, "import");
  return getArchive(archive.uuid);
}

export async function getGlobalSettings() {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readonly");
  const row = await requestToPromise(tx.objectStore("settings").get("global"));
  const stored = row?.value || {};
  return {
    ...structuredClone(DEFAULT_GLOBAL_SETTINGS),
    ...stored,
    api: { ...DEFAULT_GLOBAL_SETTINGS.api, ...(stored.api || {}) },
    memory: { ...DEFAULT_GLOBAL_SETTINGS.memory, ...(stored.memory || {}) },
    capture: { ...DEFAULT_GLOBAL_SETTINGS.capture, ...(stored.capture || {}) }
  };
}

export async function setGlobalSettings(value) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key: "global", value, updatedAt: new Date().toISOString() });
  await transactionDone(tx);
  return value;
}

export async function getMemoryDocument(archiveUuid) {
  const db = await openDatabase();
  const tx = db.transaction("memoryDocuments", "readonly");
  return requestToPromise(tx.objectStore("memoryDocuments").get(archiveUuid));
}

export async function setMemoryDocument(document) {
  if (!document?.archiveUuid) throw new Error("Memory document requires archiveUuid");
  const db = await openDatabase();
  const tx = db.transaction("memoryDocuments", "readwrite");
  tx.objectStore("memoryDocuments").put(document);
  await transactionDone(tx);
  return document;
}

export async function createMemoryCheckpoint(archiveUuid, memory, details = {}) {
  if (!archiveUuid || !memory) throw new Error("Memory checkpoint requires archiveUuid and memory");
  const db = await openDatabase();
  const tx = db.transaction("memoryCheckpoints", "readwrite");
  const checkpoint = {
    archiveUuid,
    createdAt: new Date().toISOString(),
    reason: details.reason || "incremental-memory",
    fromMessageCount: Number(details.fromMessageCount || 0),
    toMessageCount: Number(details.toMessageCount || memory.processedMessageCount || memory.sourceMessageCount || 0),
    segmentSummary: String(details.segmentSummary || memory.segmentSummary || "").trim(),
    memory: { ...memory }
  };
  const id = await requestToPromise(tx.objectStore("memoryCheckpoints").add(checkpoint));
  await transactionDone(tx);
  return { ...checkpoint, id };
}

export async function listMemoryCheckpoints(archiveUuid) {
  const db = await openDatabase();
  const tx = db.transaction("memoryCheckpoints", "readonly");
  const index = tx.objectStore("memoryCheckpoints").index("byArchive");
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  return requestToPromise(index.getAll(range));
}

export async function getSlotProfile(archiveUuid) {
  const db = await openDatabase();
  const tx = db.transaction("slotProfiles", "readonly");
  return requestToPromise(tx.objectStore("slotProfiles").get(archiveUuid));
}

export async function setSlotCorePrompt(archiveUuid, corePrompt, source = "manual") {
  const archive = await getArchive(archiveUuid);
  if (!archive) throw new Error("Archive does not exist");
  const text = String(corePrompt || "").trim().slice(0, 100000);
  const previous = await getSlotProfile(archiveUuid);
  if (previous?.corePrompt === text) return previous;
  const profile = {
    archiveUuid,
    corePrompt: text,
    source: source === "muah-auto" ? "muah-auto" : source === "import" ? "import" : "manual",
    updatedAt: new Date().toISOString()
  };
  const db = await openDatabase();
  const tx = db.transaction("slotProfiles", "readwrite");
  tx.objectStore("slotProfiles").put(profile);
  await transactionDone(tx);
  return profile;
}

export async function clearArchiveData(archiveUuid) {
  const archive = await getArchive(archiveUuid);
  if (!archive) throw new Error("Archive does not exist");
  await createSnapshot(archiveUuid, "before-manual-clear");
  const db = await openDatabase();
  const tx = db.transaction(["messages", "memoryDocuments", "memoryCheckpoints", "archives", "derivedOutputs"], "readwrite");
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  tx.objectStore("messages").delete(range);
  tx.objectStore("memoryDocuments").delete(archiveUuid);
  tx.objectStore("derivedOutputs").delete(range);
  const checkpointStore = tx.objectStore("memoryCheckpoints");
  const checkpointCursor = checkpointStore.index("byArchive").openKeyCursor(range);
  checkpointCursor.onsuccess = () => {
    const cursor = checkpointCursor.result;
    if (!cursor) return;
    checkpointStore.delete(cursor.primaryKey);
    cursor.continue();
  };
  const updated = { ...archive, messageCount: 0, updatedAt: new Date().toISOString() };
  tx.objectStore("archives").put(updated);
  await transactionDone(tx);
  return updated;
}

export async function getComparisonSource(archiveUuid) {
  const db = await openDatabase();
  return requestToPromise(db.transaction("comparisonSources").objectStore("comparisonSources").get(archiveUuid));
}

export async function saveComparisonSource(archiveUuid, summary, source = "manual") {
  if (!await getArchive(archiveUuid)) throw new Error("Archive does not exist");
  const previous = await getComparisonSource(archiveUuid);
  const text = String(summary || "").trim().slice(0, 50000);
  if (previous?.summary === text) return previous;
  const document = { archiveUuid, summary: text, source, version: crypto.randomUUID(), updatedAt: new Date().toISOString() };
  const db = await openDatabase();
  const tx = db.transaction("comparisonSources", "readwrite");
  tx.objectStore("comparisonSources").put(document);
  await transactionDone(tx);
  return document;
}

export async function getDerivedOutputs(archiveUuid) {
  const db = await openDatabase();
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  return requestToPromise(db.transaction("derivedOutputs").objectStore("derivedOutputs").getAll(range));
}

export async function saveDerivedOutput(output) {
  if (!output?.archiveUuid || !output.kind) throw new Error("The output is missing archive ownership");
  const db = await openDatabase();
  const tx = db.transaction("derivedOutputs", "readwrite");
  tx.objectStore("derivedOutputs").put(output);
  await transactionDone(tx);
  return output;
}

export async function appendComparisonHistory(output) {
  const db = await openDatabase();
  const tx = db.transaction("comparisonHistory", "readwrite");
  const { id: _id, ...row } = output;
  tx.objectStore("comparisonHistory").add({ ...row, createdAt: output.createdAt || new Date().toISOString() });
  await transactionDone(tx);
}

export async function listComparisonHistory(archiveUuid) {
  const db = await openDatabase();
  const range = IDBKeyRange.bound([archiveUuid, ""], [archiveUuid, "\uffff"]);
  return requestToPromise(db.transaction("comparisonHistory").objectStore("comparisonHistory").index("byArchive").getAll(range));
}
