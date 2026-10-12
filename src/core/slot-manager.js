import { bindNativeKey, createArchive, getArchive, getBindings, getBindingsForArchive } from "./storage.js";

const HIGH_CONFIDENCE = new Set(["url-id", "dom-id"]);

function uniqueCandidates(identity) {
  const seen = new Set();
  return (identity?.candidates || []).filter((candidate) => {
    if (!candidate?.nativeKey || seen.has(candidate.nativeKey)) return false;
    seen.add(candidate.nativeKey);
    return true;
  });
}

export async function resolveSlot(identity) {
  const candidates = uniqueCandidates(identity);
  if (candidates.length === 0) {
    return status("unconfirmed", "No stable slot evidence was found", identity);
  }

  const bindings = await getBindings(candidates.map((item) => item.nativeKey));
  const archiveIds = [...new Set(bindings.map((item) => item.archiveUuid))];
  if (archiveIds.length > 1) {
    return status("conflict", "Slot evidence points to multiple archives; reads and writes are paused", identity);
  }

  if (archiveIds.length === 1) {
    const boundKeys = new Set(bindings.map((item) => item.nativeKey));
    const unboundHighEvidence = candidates.some(
      (item) => HIGH_CONFIDENCE.has(item.kind) && item.confidence === "high" && !boundKeys.has(item.nativeKey)
    );
    if (unboundHighEvidence) {
      return status("unconfirmed", "New stable but unbound slot evidence was detected; reads and writes are paused", identity);
    }
    const archive = await getArchive(archiveIds[0]);
    if (!archive) return status("conflict", "The binding points to a missing archive", identity);
    return status("normal", "Slot confirmed", identity, archive);
  }

  const high = candidates.filter((item) => HIGH_CONFIDENCE.has(item.kind) && item.confidence === "high");
  const distinctHigh = [...new Set(high.map((item) => item.nativeKey))];
  if (distinctHigh.length !== 1) {
    return status("unconfirmed", "Manually confirm the slot before saving", identity);
  }

  const archive = await createArchive(identity.label || "Muah slot", {
    createdFrom: high[0].kind,
    slotSurface: identity?.surface === "pwa" ? "pwa" : "web"
  });
  await bindNativeKey(high[0].nativeKey, archive.uuid, { automatic: true });
  return status("normal", "An independent archive was created for the stable slot", identity, archive);
}

export async function manuallyBind(identity, archiveUuid) {
  const candidates = uniqueCandidates(identity);
  if (candidates.length === 0) throw new Error("The current page has no slot evidence that can be bound");

  const existingForArchive = await getBindingsForArchive(archiveUuid);
  const target = await getArchive(archiveUuid);
  if (!target || (target.metadata?.slotSurface || "web") !== (identity.surface || "web")) {
    throw new Error("The archive's Web/PWA mode does not match the current slot; switch modes first");
  }
  const currentKeys = new Set(candidates.map((item) => item.nativeKey));
  if (existingForArchive.length > 0 && !existingForArchive.some((item) => currentKeys.has(item.nativeKey))) {
    throw new Error("This archive is already bound to another slot. Create an independent archive to prevent cross-slot contamination.");
  }

  // Bind every currently agreeing piece of evidence. A later disagreement becomes a conflict.
  for (const candidate of candidates) {
    await bindNativeKey(candidate.nativeKey, archiveUuid, {
      automatic: false,
      kind: candidate.kind,
      labelAtBinding: identity.label || ""
    });
  }
  return resolveSlot(identity);
}

export async function initializeNumberedSlots(pageUrl, count = 10, surface = "web") {
  const url = new URL(pageUrl);
  if (url.protocol !== "https:" || !(url.hostname === "muah.ai" || url.hostname.endsWith(".muah.ai"))) {
    throw new Error("Slots can only be initialized from a Muah AI page");
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Invalid slot count");

  const normalizedSurface = surface === "pwa" ? "pwa" : "web";
  // Keep legacy web keys unchanged so existing browser archives remain intact.
  const prefix = normalizedSurface === "pwa" ? "pwa|" : "";
  const keys = Array.from({ length: count }, (_, index) => `${prefix}${url.origin}|slot-index|${index}`);
  const existing = await getBindings(keys);
  const byKey = new Map(existing.map((item) => [item.nativeKey, item]));
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const nativeKey = keys[index];
    const binding = byKey.get(nativeKey);
    if (binding) {
      const archive = await getArchive(binding.archiveUuid);
      if (!archive) throw new Error(`The binding for slot ${index + 1} is damaged. Export your data before investigating.`);
      results.push({ slotNumber: index + 1, archive, created: false });
      continue;
    }
    const archive = await createArchive(`${normalizedSurface === "pwa" ? "Muah PWA" : "Muah Web"} slot ${index + 1}`, {
      fixedSlotNumber: index + 1,
      slotSurface: normalizedSurface,
      initializedAsNumberedSlot: true
    });
    await bindNativeKey(nativeKey, archive.uuid, {
      automatic: false,
      kind: "slot-index",
      slotSurface: normalizedSurface,
      fixedSlotNumber: index + 1
    });
    results.push({ slotNumber: index + 1, archive, created: true });
  }
  return results;
}

function status(code, detail, identity, archive = null) {
  return {
    code,
    detail,
    identity: identity || { label: "Unrecognized", candidates: [] },
    archive,
    canReadWrite: code === "normal" && Boolean(archive)
  };
}
