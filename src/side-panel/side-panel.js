import { sourceRevision } from "../memory/output-engine.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);

let activeTabId = null;
let activeTargetWindowType = null;
let currentState = null;
let toastTimer = null;
let currentMemory = null;
let memoryCheckpoints = [];
let currentSlotProfile = null;
let memoryChunks = [];
let modelCatalog = [];
let pendingImport = null;
let comparisonSource = null;
let derivedOutputs = [];
let comparisonHistory = [];
let comparisonChunks = [];
let summaryDirty = false;
let coreDirty = false;
let loadEpoch = 0;
let bindingImport = false;
const jobs = new Map();
const derivedJobs = new Set();
const currentUuid = () => currentState?.resolution?.archive?.uuid || null;
const slotContext = () => ({ tabId: activeTabId, archiveUuid: currentUuid(), expectedSignature: currentState?.identitySignature });

function renderMemoryOperations() {
  const uuid = currentUuid();
  const total = Number(currentState?.resolution?.archive?.messageCount || 0);
  const processed = Number(currentMemory?.processedMessageCount ?? currentMemory?.sourceMessageCount ?? 0);
  const pending = Math.max(0, total - processed);
  const batch = Math.max(10, Math.min(200, Number(elements.recentMessageLimit.value) || 80));
  const job = jobs.get(uuid);
  const running = Boolean(job?.running);
  elements.generateMemory.disabled = !currentState?.resolution?.canReadWrite || !pending || running;
  elements.rebuildMemory.disabled = !currentState?.resolution?.canReadWrite || !total || running;
  elements.generateMemory.textContent = running ? "正在建立长期记忆…" : pending ? `增量提取 · ${pending} 条待处理` : "已处理全部聊天";
  elements.memoryPendingStatus.textContent = !uuid ? "请先确认当前槽位" : pending ? `尚有 ${pending} 条未处理 · 预计 ${Math.ceil(pending / batch)} 个批次${pending > batch * 20 ? "（本次最多20批，完成后可继续）" : ""}` : `长期记忆已追平至第 ${processed} 条`;
  elements.rebuildEstimate.textContent = `共 ${total} 条 · 每批最多 ${batch} 条 · 预计 ${Math.ceil(total / batch)} 次模型调用${total > batch * 50 ? "（本次最多50批，剩余用增量继续）" : ""}`;
  elements.memoryProgress.classList.toggle("hidden", !running);
  elements.memoryProgress.max = Math.max(1, job?.totalMessageCount || total);
  elements.memoryProgress.value = job?.processedMessageCount || 0;
  elements.memoryProgressLabel.textContent = running
    ? `正在处理 ${job?.from || processed + 1}–${job?.to || processed} / ${job?.totalMessageCount || total}`
    : job?.error ? `处理中断：${job.error}。已成功的批次已保存，可以继续增量提取。` : "";
}

function renderPendingImport() {
  elements.pendingImportCard.classList.toggle("hidden", !pendingImport);
  if (!pendingImport) return;
  const surface = elements.pwaMode.checked ? "pwa" : "web";
  const importedSurface = pendingImport.metadata?.slotSurface || "web";
  const matches = surface === importedSurface;
  const slot = currentState?.resolution?.identity?.slotNumber;
  elements.pendingImportName.textContent = pendingImport.name;
  elements.pendingImportUuid.textContent = `UUID：${pendingImport.uuid}`;
  elements.pendingImportMeta.textContent = `${pendingImport.messageCount} 条聊天 · ${importedSurface === "pwa" ? "PWA" : "网页"} · ${pendingImport.importType || "JSON"}`;
  elements.pendingImportHint.textContent = !matches ? "存档与当前模式不同，请先切换模式。" : slot ? `请确认 Muah 已打开槽位 ${slot}，绑定后此编号将使用导入存档。` : "请先在 Muah 打开正确槽位，再选择上方同号编号。";
  elements.bindPendingImport.textContent = slot ? `绑定到当前槽位 ${slot}` : "等待选择槽位";
  elements.bindPendingImport.disabled = bindingImport || !matches || !slot || !currentState?.identitySignature;
  elements.switchImportMode.classList.toggle("hidden", matches);
  elements.switchImportMode.textContent = `切换到 ${importedSurface === "pwa" ? "PWA" : "网页"}模式`;
}

async function rememberImport(archive, importType) {
  pendingImport = { ...archive, importType };
  await chrome.storage.local.set({ pendingImportedArchive: pendingImport });
  renderPendingImport();
  renderComparison();
  elements.pendingImportCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展操作失败");
  return response.result;
}

async function sendToMuahTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const detail = String(error?.message || error);
    if (!/receiving end does not exist|could not establish connection/iu.test(detail)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/content-script.js"]
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = isError ? "show error" : "show";
  toastTimer = setTimeout(() => { elements.toast.className = ""; }, 2600);
}

function dateText(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

function renderCaptureStatus(state = currentState) {
  const mode = state?.captureMode || (elements.captureMode.value === "manual" ? "manual" : "automatic");
  const threshold = Number(state?.captureThreshold || elements.captureTriggerCount.value || 2);
  const pending = Math.max(0, Number(state?.capturePendingCount || 0));
  elements.captureThresholdLabel.classList.toggle("disabled-field", mode === "manual");
  elements.captureTriggerCount.disabled = mode === "manual";
  if (mode === "manual") {
    elements.captureStatus.textContent = pending
      ? `仅手动抓取：页面有约 ${pending} 条待保存，点击上方“手动保存”同步。`
      : "仅手动抓取：不会自动写入聊天记录。";
    return;
  }
  elements.captureStatus.textContent = pending
    ? `自动抓取：已累计约 ${pending}/${threshold} 条，达到阈值后批量保存。`
    : `自动抓取：每新增约 ${threshold} 条保存一次。`;
}

function renderState(state) {
  const previousUuid = currentState?.resolution?.archive?.uuid || null;
  currentState = state;
  const resolution = state?.resolution;
  const nextUuid = resolution?.archive?.uuid || null;
  if (previousUuid !== nextUuid) {
    loadEpoch += 1;
    summaryDirty = false;
    coreDirty = false;
    comparisonSource = null;
    derivedOutputs = [];
    comparisonHistory = [];
    elements.muahSummaryText.value = "";
    renderMemoryCheckpoints([]);
    renderMemory(null);
    renderSlotProfile(null);
    renderComparison();
  }
  const code = resolution?.code || "unconfirmed";
  const labels = { normal: "正常", unconfirmed: "未确认", conflict: "存档冲突" };
  const capturePaused = resolution?.canReadWrite && resolution?.identity?.captureArmed === false;
  elements.statusBadge.textContent = capturePaused ? "暂停抓取" : labels[code] || "未确认";
  elements.statusBadge.className = `badge ${capturePaused ? "unknown" : code === "normal" ? "normal" : code === "conflict" ? "conflict" : "unknown"}`;
  elements.statusDetail.textContent = capturePaused
    ? "浏览模式：不会抓取当前页面。确认 Muah 页面与编号一致后点击“手动保存”。"
    : resolution?.detail || "请打开 Muah AI Chatroom 页面。";
  elements.saveNow.textContent = capturePaused ? "确认并抓取" : "立即抓取";
  elements.slotLabel.textContent = resolution?.identity?.label || "—";
  elements.archiveName.textContent = resolution?.archive?.name || "—";
  elements.archiveUuid.textContent = resolution?.archive?.uuid || "—";
  elements.messageCount.textContent = String(resolution?.archive?.messageCount || 0);
  elements.updatedAt.textContent = dateText(resolution?.archive?.updatedAt);
  const slotNumber = Number(resolution?.identity?.slotNumber);
  for (const button of elements.slotGrid.querySelectorAll("[data-slot-number]")) {
    button.classList.toggle("active", Number(button.dataset.slotNumber) === slotNumber);
  }
  elements.manualSlotHint.textContent = Number.isInteger(slotNumber) ? `已选择槽位 ${slotNumber}` : "未选择";
  elements.manualSlotHint.className = Number.isInteger(slotNumber) ? "active" : "";
  const ready = Boolean(resolution?.canReadWrite);
  elements.saveNow.disabled = !ready;
  elements.exportArchive.disabled = !ready;
  elements.refreshRecords.disabled = !ready;
  elements.openReader.disabled = !ready || Number(resolution?.archive?.messageCount || 0) === 0;
  elements.generateMemory.disabled = !ready || Number(resolution?.archive?.messageCount || 0) === 0;
  elements.rebuildMemory.disabled = !ready || Number(resolution?.archive?.messageCount || 0) === 0;
  elements.copyMemory.disabled = !ready || !currentMemory;
  elements.copyMemorySegment.disabled = !ready || !currentMemory;
  elements.insertMemory.disabled = !ready || !currentMemory;
  elements.syncCorePrompt.disabled = !ready;
  elements.saveCorePrompt.disabled = !ready;
  if (!ready) {
    elements.records.className = "records empty";
    elements.records.textContent = "槽位未确认，已暂停记忆读取和写入。";
  }
  renderCaptureStatus(state);
  renderMemoryOperations();
  renderPendingImport();
  renderComparison();
}

function renderSlotCards(archives) {
  const surface = currentState?.resolution?.identity?.surface || (elements.pwaMode.checked ? "pwa" : "web");
  const bySlot = new Map(archives
    .filter((archive) => archive.metadata?.fixedSlotNumber)
    .filter((archive) => (archive.metadata?.slotSurface || "web") === surface)
    .map((archive) => [Number(archive.metadata.fixedSlotNumber), archive]));
  for (const button of elements.slotGrid.querySelectorAll("[data-slot-number]")) {
    const slotNumber = Number(button.dataset.slotNumber);
    const archive = bySlot.get(slotNumber);
    const number = document.createElement("span");
    number.className = "slot-number";
    number.textContent = String(slotNumber);
    const name = document.createElement("span");
    name.className = "slot-name";
    name.textContent = archive?.name || "未初始化";
    const count = document.createElement("span");
    count.className = "slot-count";
    count.textContent = archive ? `${archive.messageCount} 条聊天` : "无本地存档";
    button.replaceChildren(number, name, count);
  }
}

async function getActiveTab() {
  const modeState = await call({ type: "GET_TARGET_MODE" });
  const mode = modeState?.mode === "pwa" ? "pwa" : "web";
  elements.pwaMode.checked = mode === "pwa";
  elements.initializeSlots.textContent = `初始化${mode === "pwa" ? " PWA" : "网页"}槽位 1–10（一一对应）`;
  const pinned = await call({ type: "GET_COMPANION_TARGET" });
  if (pinned?.tab?.id) {
    activeTabId = pinned.tab.id;
    activeTargetWindowType = pinned.windowType || null;
    elements.sourcePage.textContent = `${mode === "pwa" ? "PWA 独立应用" : "普通网页"} · ${pinned.tab.title || "Muah AI"}`;
    elements.targetBannerText.textContent = `正在抓取：${mode === "pwa" ? "PWA 独立应用" : "普通网页"} · ${pinned.tab.title || "Muah AI"}`;
    elements.targetBanner.className = "target-banner connected";
    return pinned.tab;
  }
  activeTabId = null;
  activeTargetWindowType = null;
  elements.sourcePage.textContent = mode === "pwa" ? "未找到 PWA 独立应用" : "未找到普通 Muah 网页";
  elements.targetBannerText.textContent = mode === "pwa"
    ? "PWA 模式已开启，但当前没有运行中的 Muah PWA；已停止抓取，不会改抓网页。"
    : "网页模式已开启，但当前没有普通 Muah 网页；已停止抓取，不会改抓 PWA。";
  elements.targetBanner.className = "target-banner warning";
  return null;
}

async function requestScan(reason) {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(tab.url || "")) {
    renderState(null);
    throw new Error("当前标签页不是 Muah AI 页面");
  }
  const response = await sendToMuahTab(tab.id, { type: "SCAN_NOW", reason });
  if (!response?.ok) throw new Error(response?.error || "页面扫描失败");
  await new Promise((resolve) => setTimeout(resolve, 100));
  renderState(await call({ type: "GET_TAB_STATE", tabId: tab.id }));
}

async function refreshArchives(selectedUuid = null) {
  const surface = currentState?.resolution?.identity?.surface || (elements.pwaMode.checked ? "pwa" : "web");
  const allArchives = await call({ type: "LIST_ARCHIVES" });
  if (surface !== (elements.pwaMode.checked ? "pwa" : "web")) return;
  const archives = allArchives.filter((archive) => (archive.metadata?.slotSurface || "web") === surface);
  archives.sort((left, right) => {
    const leftSlot = Number(left.metadata?.fixedSlotNumber) || 999;
    const rightSlot = Number(right.metadata?.fixedSlotNumber) || 999;
    return leftSlot - rightSlot || left.name.localeCompare(right.name, "zh-CN");
  });
  renderSlotCards(archives);
  elements.archiveSelect.replaceChildren();
  if (archives.length === 0) {
    const option = new Option("尚无本地存档", "");
    elements.archiveSelect.add(option);
    elements.bindArchive.disabled = true;
    return;
  }
  for (const archive of archives) {
    const slotPrefix = archive.metadata?.fixedSlotNumber ? `槽位 ${archive.metadata.fixedSlotNumber} → ` : "";
    elements.archiveSelect.add(new Option(`${slotPrefix}${archive.name} · ${archive.messageCount} 条`, archive.uuid));
  }
  elements.bindArchive.disabled = false;
  const preferred = selectedUuid || currentState?.resolution?.archive?.uuid;
  if (preferred && archives.some((item) => item.uuid === preferred)) elements.archiveSelect.value = preferred;
}

function formatMemory(memory) {
  if (!memory) return "";
  const sections = [];
  if (memory.overview) sections.push(memory.overview);
  const add = (title, rows) => {
    if (rows?.length) sections.push(`【${title}】\n${rows.map((item) => `• ${item}`).join("\n")}`);
  };
  add("Important facts", memory.importantFacts);
  add("Characters", memory.characters);
  add("Relationships", memory.relationships);
  add("Story timeline", memory.timeline);
  add("Open threads", memory.openThreads);
  return sections.join("\n\n");
}

function renderMemory(memory) {
  currentMemory = memory || null;
  elements.memoryText.value = formatMemory(memory);
  elements.memoryMeta.textContent = memory
    ? `已处理 ${memory.processedMessageCount ?? memory.sourceMessageCount ?? 0}/${memory.totalMessageCount ?? currentState?.resolution?.archive?.messageCount ?? 0} 条 · ${memory.checkpointCount ?? memoryCheckpoints.length} 个检查点 · ${dateText(memory.updatedAt)} · ${memory.responseModel || "模型"}`
    : "尚未生成";
  elements.memoryStatus.textContent = memory
    ? "这是当前存档 UUID 的私有记忆；切换槽位后会加载另一个记忆文档。"
    : "尚无提取记忆。配置模型后点击“立即提取”。";
  const ready = Boolean(currentState?.resolution?.canReadWrite && memory);
  elements.copyMemory.disabled = !ready;
  elements.copyMemorySegment.disabled = !ready;
  elements.insertMemory.disabled = !ready;
  renderMemoryOutput();
  renderMemoryOperations();
  renderComparison();
}

function renderMemoryCheckpoints(checkpoints = []) {
  memoryCheckpoints = [...checkpoints].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  elements.checkpointSummary.textContent = `记忆历史存档 · ${memoryCheckpoints.length} 个检查点`;
  elements.checkpointSelect.replaceChildren();
  if (!memoryCheckpoints.length) {
    elements.checkpointSelect.add(new Option("尚无检查点", ""));
    elements.checkpointPreview.value = "";
    return;
  }
  for (const checkpoint of memoryCheckpoints) {
    const range = `${Number(checkpoint.fromMessageCount || 0) + 1}-${Number(checkpoint.toMessageCount || 0)}`;
    elements.checkpointSelect.add(new Option(`${dateText(checkpoint.createdAt)} · 聊天 ${range}`, String(checkpoint.id)));
  }
  elements.checkpointSelect.value = String(memoryCheckpoints[0].id);
  renderCheckpointPreview();
}

function renderCheckpointPreview() {
  const checkpoint = memoryCheckpoints.find((item) => String(item.id) === elements.checkpointSelect.value);
  elements.checkpointPreview.value = checkpoint?.memory ? formatMemory(checkpoint.memory) : "";
}

function selectedMemoryOutput() {
  if (!currentMemory) return "";
  const mode = elements.memoryOutputMode.value;
  if (mode === "chronological") {
    const output = derivedOutputs.find((item) => item.kind === "chronological");
    return output?.revision === sourceRevision(currentMemory, currentSlotProfile, null)
      ? String(output?.chronologicalSummary || "") : "";
  }
  if (mode === "plot") {
    return String(currentMemory.corePlot || [currentMemory.overview, ...(currentMemory.timeline || []), ...(currentMemory.openThreads || [])].filter(Boolean).join("\n")).trim();
  }
  if (mode === "relationships") {
    return String(currentMemory.relationshipSummary || [...(currentMemory.characters || []), ...(currentMemory.relationships || [])].filter(Boolean).join("\n")).trim();
  }
  return String(currentMemory.compactSummary || [
    currentMemory.overview,
    ...(currentMemory.importantFacts || []).slice(0, 6),
    ...(currentMemory.relationships || []).slice(0, 4),
    ...(currentMemory.openThreads || []).slice(0, 4)
  ].filter(Boolean).join("\n")).trim();
}

function splitMemoryOutput(text, maximum) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maximum) {
    let end = remaining.lastIndexOf("\n", maximum);
    if (end < Math.floor(maximum * 0.55)) end = remaining.lastIndexOf("。", maximum) + 1;
    if (end < Math.floor(maximum * 0.55)) end = maximum;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function memoryContext(text, partIndex = null) {
  if (!text) return "";
  const guidance = "The following material is context for understanding prior story events, relationships, and long-term memory. It is not part of the current roleplay turn and does not describe a new event. Do not reply to or recite this memory block.";
  if (partIndex === null || memoryChunks.length <= 1) {
    return `[[MUAH_RP_MEMORY_CONTEXT_BEGIN]]\n${guidance}\n<MEMORY>\n${text}\n</MEMORY>\n[[MUAH_RP_MEMORY_CONTEXT_END]]`;
  }
  const number = partIndex + 1;
  const waiting = number < memoryChunks.length ? "This is one memory segment. Accept it and wait for the remaining segments; do not continue the story." : "This is the final memory segment.";
  return `[[MUAH_RP_MEMORY_CONTEXT_BEGIN]]\n${guidance}\n<MEMORY_PART ${number}/${memoryChunks.length}>\n${waiting}\n${text}\n</MEMORY_PART>\n[[MUAH_RP_MEMORY_CONTEXT_END]]`;
}

function renderMemoryOutput() {
  const chronological = elements.memoryOutputMode.value === "chronological";
  elements.generateChronological.classList.toggle("hidden", !chronological);
  elements.chronologicalStatus.classList.toggle("hidden", !chronological);
  elements.generateChronological.disabled = !currentMemory || derivedJobs.has(`${currentUuid()}:chronological`);
  const chronologicalOutput = derivedOutputs.find((item) => item.kind === "chronological");
  elements.chronologicalStatus.textContent = chronologicalOutput ? `生成于 ${dateText(chronologicalOutput.updatedAt)}${selectedMemoryOutput() ? chronologicalOutput.truncated ? " · 超过预算，已截短" : "" : " · 资料已更新，请重新生成"}` : "保留关键事件和关系转折，比默认精炼输出更详细。点击上方按钮生成。";
  const text = selectedMemoryOutput();
  const usable = Boolean(currentState?.resolution?.canReadWrite && text);
  elements.copyMemory.disabled = !usable;
  elements.copyMemorySegment.disabled = !usable;
  elements.insertMemory.disabled = !usable;
  const maximum = Math.max(500, Math.min(10000, Number(elements.memorySegmentSize.value) || 1800));
  const previous = Number(elements.memorySegment.value || 0);
  memoryChunks = text ? splitMemoryOutput(text, maximum) : [];
  elements.memorySegment.replaceChildren();
  if (!memoryChunks.length) {
    elements.memorySegment.add(new Option("尚无输出", "0"));
    elements.memoryOutputPreview.value = "";
    return;
  }
  memoryChunks.forEach((_chunk, index) => elements.memorySegment.add(new Option(`第 ${index + 1}/${memoryChunks.length} 段`, String(index))));
  elements.memorySegment.value = String(Math.min(previous, memoryChunks.length - 1));
  elements.memoryOutputPreview.value = memoryContext(memoryChunks[Number(elements.memorySegment.value)], Number(elements.memorySegment.value));
}

function renderSlotProfile(profile) {
  currentSlotProfile = profile || null;
  if (!coreDirty) elements.corePromptText.value = profile?.corePrompt || "";
  elements.corePromptStatus.textContent = profile?.corePrompt
    ? `${profile.source === "muah-auto" ? "已从 Muah 同步" : "已手动保存"} · ${dateText(profile.updatedAt)}`
    : "当前槽位尚未保存核心提示词。";
  renderComparison();
  renderMemoryOutput();
}

async function loadMemory() {
  const epoch = loadEpoch;
  const uuid = currentState?.resolution?.archive?.uuid;
  if (!uuid || !currentState?.resolution?.canReadWrite) {
    renderMemory(null);
    renderMemoryCheckpoints([]);
    return;
  }
  const [memory, checkpoints, progress] = await Promise.all([
    call({ type: "GET_MEMORY", archiveUuid: uuid }),
    call({ type: "LIST_MEMORY_CHECKPOINTS", archiveUuid: uuid }),
    call({ type: "GET_MEMORY_PROGRESS", archiveUuid: uuid })
  ]);
  if (uuid !== currentUuid() || epoch !== loadEpoch) return;
  if (progress) jobs.set(uuid, progress);
  renderMemoryCheckpoints(checkpoints);
  renderMemory(memory || null);
}

async function loadSlotProfile() {
  const epoch = loadEpoch;
  const uuid = currentState?.resolution?.archive?.uuid;
  if (!uuid || !currentState?.resolution?.canReadWrite) {
    renderSlotProfile(null);
    return;
  }
  const profile = await call({ type: "GET_SLOT_PROFILE", archiveUuid: uuid });
  if (uuid === currentUuid() && epoch === loadEpoch) renderSlotProfile(profile);
}

async function loadComparison() {
  const uuid = currentUuid();
  const epoch = loadEpoch;
  if (!uuid || !currentState?.resolution?.canReadWrite) return;
  const data = await call({ type: "GET_COMPARISON_DATA", archiveUuid: uuid });
  if (uuid !== currentUuid() || epoch !== loadEpoch) return;
  comparisonSource = data.source || null;
  derivedOutputs = data.outputs || [];
  comparisonHistory = data.history || [];
  if (!summaryDirty) elements.muahSummaryText.value = comparisonSource?.summary || "";
  renderComparison();
  renderMemoryOutput();
}

function activeComparison() {
  const output = derivedOutputs.find((item) => item.kind === "comparison");
  return output && !summaryDirty && !coreDirty && output.revision === sourceRevision(currentMemory, currentSlotProfile, comparisonSource) ? output : null;
}

function renderComparison() {
  const uuid = currentUuid();
  const ready = Boolean(uuid && currentState?.resolution?.canReadWrite);
  const running = derivedJobs.has(`${uuid}:comparison`);
  elements.readMuahSummary.disabled = !ready;
  elements.saveMuahSummary.disabled = !ready;
  elements.compareMemory.disabled = !ready || !currentMemory || !comparisonSource || summaryDirty || coreDirty || running;
  elements.compareMemory.textContent = running ? "正在交叉对比…" : "对比并生成补全";
  elements.muahSummaryMeta.textContent = comparisonSource ? `${comparisonSource.source === "muah-auto" ? "从 Muah 读取" : "已保存"} · ${dateText(comparisonSource.updatedAt)}` : "尚未保存对照摘要";
  const output = activeComparison();
  const stored = derivedOutputs.find((item) => item.kind === "comparison");
  if (!running) elements.comparisonStatus.textContent = summaryDirty || coreDirty ? "有尚未保存的资料，请先保存摘要/核心提示词再对比。" : stored && !output ? "记忆或对照资料已更新，旧结果已暂停复制，请重新对比。" : output ? `已对比 · ${dateText(output.updatedAt)}${output.truncated ? " · 部分正文超过预算，已截短" : ""}` : "读取或粘贴保存摘要后，点击对比生成。";
  elements.comparisonReport.textContent = output ? [
    ["Missing from both Muah sources", output.missing], ["Covered only by core prompt", output.coreOnly], ["Conflicts / review required", output.conflicts], ["Compressed / omitted", output.omitted]
  ].map(([title, rows]) => `[${title}]\n${rows?.length ? rows.map((item) => `• ${item}`).join("\n") : "None"}`).join("\n\n") : "";
  const text = output?.[elements.comparisonMode.value] || "";
  comparisonChunks = text ? splitMemoryOutput(text, Math.max(500, Number(elements.memorySegmentSize.value) || 1800)) : [];
  const index = Math.min(Number(elements.comparisonSegment.value || 0), Math.max(0, comparisonChunks.length - 1));
  elements.comparisonSegment.replaceChildren();
  comparisonChunks.forEach((_part, position) => elements.comparisonSegment.add(new Option(`第 ${position + 1}/${comparisonChunks.length} 段`, String(position))));
  elements.comparisonSegment.value = String(index);
  elements.comparisonPreview.value = comparisonChunks[index] || "";
  elements.comparisonLength.textContent = `${text.length} 字符 · 预算 ${output?.maximum || elements.comparisonBudget.value}${output && !text ? " · 没有需要补充的内容" : ""}`;
  elements.copyComparison.disabled = !output || !text;
  elements.copyComparisonSegment.disabled = !output || !text;
  const selectedHistory = elements.comparisonHistorySelect.value;
  elements.comparisonHistorySelect.replaceChildren();
  [...comparisonHistory].reverse().forEach((item) => elements.comparisonHistorySelect.add(new Option(dateText(item.createdAt || item.updatedAt), String(item.id))));
  if (selectedHistory && comparisonHistory.some((item) => String(item.id) === selectedHistory)) elements.comparisonHistorySelect.value = selectedHistory;
  renderComparisonHistory();
}

function renderComparisonHistory() {
  const item = comparisonHistory.find((row) => String(row.id) === elements.comparisonHistorySelect.value);
  elements.comparisonHistoryPreview.value = item ? `[Memory supplement]\n${item.supplement || "None"}\n\n[Completed combined summary]\n${item.completedSummary || ""}\n\n[Core-prompt patch]\n${item.corePatch || ""}` : "";
}

async function bindImportedArchive() {
  if (!pendingImport) return;
  const archive = pendingImport;
  await requestScan("pre-bind");
  const context = slotContext();
  const slot = currentState?.resolution?.identity?.slotNumber;
  if (!slot || !context.expectedSignature) throw new Error("请先选择对应槽位编号");
  if ((archive.metadata?.slotSurface || "web") !== (elements.pwaMode.checked ? "pwa" : "web")) throw new Error("请先切换到导入存档所属模式");
  if (!confirm(`将 ${archive.name}（${archive.messageCount} 条）绑定到 ${elements.pwaMode.checked ? "PWA" : "网页"}槽位 ${slot}？\n\n当前存档：${currentState?.resolution?.archive?.name || "未绑定"}\n导入 UUID：${archive.uuid}\n\n旧存档仍保留，当前编号将改用导入存档。请确认 Muah 页面也是槽位 ${slot}。`)) return;
  const state = await call({ ...context, type: "BIND_SLOT", archiveUuid: archive.uuid });
  pendingImport = null;
  await chrome.storage.local.remove("pendingImportedArchive");
  if (activeTabId === context.tabId && currentState?.identitySignature === context.expectedSignature) renderState(state);
  await Promise.all([refreshArchives(), refreshRecords(), loadMemory(), loadSlotProfile(), loadComparison()]);
  renderPendingImport();
  toast("导入存档已绑定，聊天与记忆已加载");
}

elements.bindPendingImport.addEventListener("click", async () => {
  if (bindingImport) return;
  bindingImport = true;
  renderPendingImport();
  try { await bindImportedArchive(); }
  catch (error) { toast(error.message, true); }
  finally { bindingImport = false; renderPendingImport(); }
});
elements.dismissPendingImport.addEventListener("click", async () => {
  pendingImport = null;
  await chrome.storage.local.remove("pendingImportedArchive");
  renderPendingImport();
});
elements.switchImportMode.addEventListener("click", async () => {
  elements.pwaMode.checked = pendingImport?.metadata?.slotSurface === "pwa";
  elements.pwaMode.dispatchEvent(new Event("change"));
});
elements.muahSummaryText.addEventListener("input", () => { summaryDirty = true; renderComparison(); });
elements.corePromptText.addEventListener("input", () => { coreDirty = true; renderComparison(); });
elements.recentMessageLimit.addEventListener("input", renderMemoryOperations);

async function saveSummary(summary, source) {
  const context = slotContext();
  const result = await call({ ...context, type: "SAVE_COMPARISON_SOURCE", summary, source });
  if (context.archiveUuid !== currentUuid()) return;
  summaryDirty = false;
  comparisonSource = result;
  elements.muahSummaryText.value = result.summary;
  renderComparison();
}

elements.readMuahSummary.addEventListener("click", async () => {
  const context = slotContext();
  const slotNumber = currentState?.resolution?.identity?.slotNumber;
  try {
    const result = await sendToMuahTab(context.tabId, { type: "READ_SYSTEM_SUMMARY", slotNumber });
    if (!result?.ok) throw new Error(result?.error || "读取失败");
    if (context.archiveUuid !== currentUuid()) return;
    await saveSummary(result.summary, "muah-auto");
    toast("已保存当前槽位的 Muah 摘要");
  } catch (error) { if (context.archiveUuid === currentUuid()) toast(error.message, true); }
});
elements.saveMuahSummary.addEventListener("click", () => saveSummary(elements.muahSummaryText.value, "manual").then(() => toast("摘要已保存，可以开始对比")).catch((error) => toast(error.message, true)));

async function generateOutput(kind) {
  const context = slotContext();
  if (!context.archiveUuid) return;
  const key = `${context.archiveUuid}:${kind}`;
  if (derivedJobs.has(key)) return;
  const maximum = kind === "comparison" ? Number(elements.comparisonBudget.value) : 2800;
  if (!Number.isInteger(maximum) || maximum < 300 || maximum > 8000) throw new Error("字符预算需在 300–8000 之间");
  derivedJobs.add(key);
  renderComparison();
  renderMemoryOutput();
  try {
    await call({ ...context, type: "GENERATE_DERIVED_OUTPUT", kind, maximum });
    if (context.archiveUuid === currentUuid()) {
      await loadComparison();
      toast(kind === "comparison" ? "补全结果已生成，请检查冲突列表后复制" : "时间顺序汇总已生成");
    }
  } catch (error) {
    if (context.archiveUuid === currentUuid()) toast(error.message, true);
  } finally {
    derivedJobs.delete(key);
    renderComparison();
    renderMemoryOutput();
  }
}
elements.compareMemory.addEventListener("click", () => generateOutput("comparison").catch((error) => toast(error.message, true)));
elements.generateChronological.addEventListener("click", () => generateOutput("chronological").catch((error) => toast(error.message, true)));
elements.comparisonMode.addEventListener("change", renderComparison);
elements.comparisonSegment.addEventListener("change", renderComparison);
elements.comparisonHistorySelect.addEventListener("change", renderComparisonHistory);
async function copyComparison(segmentOnly) {
  const output = activeComparison();
  if (!output) throw new Error("资料已变化，请重新对比");
  const index = Number(elements.comparisonSegment.value || 0);
  const text = segmentOnly ? comparisonChunks[index] : output[elements.comparisonMode.value];
  if (!text) throw new Error("没有需要复制的补充");
  const marked = elements.comparisonAsContext.checked && elements.comparisonMode.value !== "corePatch";
  // Use a plain MEMORY wrapper here; normal memory output keeps its own partition counter.
  const copied = marked ? memoryContext(text) : text;
  await navigator.clipboard.writeText(copied);
  toast("已复制，粘贴前请确认当前 Muah 槽位");
}
elements.copyComparison.addEventListener("click", () => copyComparison(false).catch((error) => toast(error.message, true)));
elements.copyComparisonSegment.addEventListener("click", () => copyComparison(true).catch((error) => toast(error.message, true)));

function showTab(name) {
  const memoryActive = name === "memory";
  elements.memoryTab.classList.toggle("active", memoryActive);
  elements.recordsTab.classList.toggle("active", !memoryActive);
  elements.memoryTab.setAttribute("aria-selected", String(memoryActive));
  elements.recordsTab.setAttribute("aria-selected", String(!memoryActive));
  elements.memoryPanel.classList.toggle("hidden", !memoryActive);
  elements.recordsPanel.classList.toggle("hidden", memoryActive);
  if (!memoryActive) refreshRecords().catch((error) => toast(error.message, true));
}

async function refreshRecords() {
  const uuid = currentState?.resolution?.archive?.uuid;
  if (!uuid || !currentState?.resolution?.canReadWrite) return;
  const messages = await call({ type: "LIST_MESSAGES", archiveUuid: uuid, limit: 500 });
  if (uuid !== currentUuid()) return;
  elements.records.replaceChildren();
  elements.records.className = messages.length ? "records" : "records empty";
  if (!messages.length) {
    elements.records.textContent = "尚未保存聊天记录。";
    return;
  }
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message ${message.role}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = `${message.role === "user" ? "用户" : "AI"} · ${dateText(message.observedAt || message.capturedAt)}`;
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.text;
    item.append(meta, text);
    elements.records.append(item);
  }
  elements.records.scrollTop = elements.records.scrollHeight;
}

function apiFormConfig() {
  return {
    baseUrl: elements.baseUrl.value.trim(),
    apiKey: elements.apiKey.value,
    modelName: elements.modelName.value,
    temperature: Number(elements.temperature.value || 0.3),
    maxTokens: Number(elements.maxTokens.value || 1200)
  };
}

async function ensureApiPermission(baseUrl) {
  if (!baseUrl) throw new Error("请先填写 Base URL");
  const url = new URL(baseUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Base URL 必须使用 HTTPS；本机 localhost/127.0.0.1 可使用 HTTP");
  }
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) throw new Error("未授予该 API 域名的访问权限");
}

function renderModelOptions(result, preferred = "") {
  modelCatalog = result.models || [];
  const available = modelCatalog.filter((item) => item.available);
  const unavailable = modelCatalog.filter((item) => !item.available);
  elements.modelName.replaceChildren();
  elements.modelName.add(new Option(available.length ? "请选择模型" : "没有账号可用模型", ""));
  for (const model of available) {
    const context = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k` : "";
    const option = new Option(`${model.name}${context} · ${model.id}`, model.id);
    option.title = `Model ID: ${model.id}`;
    elements.modelName.add(option);
  }
  const preferredModel = modelCatalog.find((item) => item.id === preferred);
  if (preferred && !preferredModel) {
    const option = new Option(`已保存但不在当前列表：${preferred}`, preferred);
    elements.modelName.add(option);
  } else if (preferredModel && !preferredModel.available) {
    const option = new Option(`不可用：${preferredModel.name} · ${preferredModel.unavailableReason}`, preferred);
    option.disabled = true;
    elements.modelName.add(option);
  }
  if ([...elements.modelName.options].some((option) => option.value === preferred && !option.disabled)) {
    elements.modelName.value = preferred;
  }
  const filterText = result.accountFiltered
    ? `已按当前 OpenRouter 账号过滤：${available.length} 个可用，${unavailable.length} 个受限。`
    : `已加载 ${available.length} 个模型，但账号级可用性未验证。`;
  elements.apiStatus.textContent = [filterText, result.filterWarning].filter(Boolean).join(" ");
}

async function loadSettings() {
  const settings = await call({ type: "GET_GLOBAL_SETTINGS" });
  elements.writingPreferences.value = (settings.writingPreferences || []).join("\n");
  elements.baseUrl.value = settings.api?.baseUrl || "";
  elements.apiKey.value = settings.api?.apiKey || "";
  const savedModel = settings.api?.modelName || "";
  elements.modelName.replaceChildren(new Option(savedModel ? `已保存：${savedModel}` : "请先获取模型列表", savedModel));
  elements.modelName.value = savedModel;
  elements.temperature.value = settings.api?.temperature ?? 0.7;
  elements.maxTokens.value = settings.api?.maxTokens ?? 1200;
  elements.autoExtractEnabled.checked = Boolean(settings.memory?.autoExtractEnabled);
  elements.triggerMessageCount.value = settings.memory?.triggerMessageCount ?? 6;
  elements.recentMessageLimit.value = settings.memory?.recentMessageLimit ?? 80;
  elements.captureMode.value = settings.capture?.mode === "manual" ? "manual" : "automatic";
  elements.captureTriggerCount.value = settings.capture?.triggerMessageCount ?? 2;
  renderCaptureStatus(currentState);
  renderMemoryOperations();
}

elements.pwaMode.addEventListener("change", async () => {
  const mode = elements.pwaMode.checked ? "pwa" : "web";
  elements.pwaMode.disabled = true;
  elements.targetBannerText.textContent = `正在切换到${mode === "pwa" ? " PWA 独立应用" : "普通网页"}模式…`;
  elements.targetBanner.className = "target-banner warning";
  try {
    await call({ type: "SET_TARGET_MODE", mode });
    toast(mode === "pwa" ? "已锁定 PWA 独立应用" : "已锁定普通 Muah 网页");
  } catch (error) {
    renderState(null);
    toast(error.message, true);
  } finally {
    elements.pwaMode.disabled = false;
    await initialize();
  }
});

elements.saveNow.addEventListener("click", () => requestScan("manual-save").then(() => {
  toast("已立即抓取并保存当前聊天");
  return Promise.all([refreshArchives(), refreshRecords()]);
}).catch((error) => toast(error.message, true)));

elements.captureMode.addEventListener("change", () => renderCaptureStatus(null));

elements.saveCaptureSettings.addEventListener("click", async () => {
  try {
    const mode = elements.captureMode.value === "manual" ? "manual" : "automatic";
    const triggerMessageCount = Number(elements.captureTriggerCount.value);
    if (!Number.isInteger(triggerMessageCount) || triggerMessageCount < 1 || triggerMessageCount > 50) {
      throw new Error("自动抓取条数必须在 1–50 之间");
    }
    const settings = await call({ type: "GET_GLOBAL_SETTINGS" });
    await call({
      type: "SET_GLOBAL_SETTINGS",
      value: { ...settings, capture: { mode, triggerMessageCount } }
    });
    await requestScan("capture-settings-change");
    toast(mode === "manual" ? "已切换为仅手动抓取" : `已设置为每新增约 ${triggerMessageCount} 条自动抓取`);
  } catch (error) { toast(error.message, true); }
});

elements.recognizeNow.addEventListener("click", () => requestScan("manual-recognize").then(() => {
  toast("已重新识别当前槽位");
  return refreshArchives();
}).catch((error) => toast(error.message, true)));

elements.createArchive.addEventListener("click", async () => {
  try {
    const name = elements.newArchiveName.value.trim();
    if (!name) throw new Error("请输入新存档名称");
    const archive = await call({ type: "CREATE_ARCHIVE", name, surface: elements.pwaMode.checked ? "pwa" : "web" });
    elements.newArchiveName.value = "";
    await refreshArchives(archive.uuid);
    toast("已创建独立存档；如需使用，请再点击绑定");
  } catch (error) { toast(error.message, true); }
});

elements.initializeSlots.addEventListener("click", async () => {
  try {
    await requestScan("pre-initialize-slots");
    if (!activeTabId) throw new Error("当前没有 Muah 标签页");
    const rows = await call({ type: "INITIALIZE_NUMBERED_SLOTS", tabId: activeTabId });
    await refreshArchives();
    await requestScan("post-initialize-slots");
    const created = rows.filter((item) => item.created).length;
    if (currentState?.resolution?.canReadWrite) {
      await refreshRecords();
      toast(`槽位 1–10 已一一映射，本次新建 ${created} 个存档`);
    } else {
      toast("已建立十槽位映射；请打开“角色槽位”弹窗并重新识别");
    }
  } catch (error) { toast(error.message, true); }
});

async function activateNumberedSlot(slotNumber) {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(tab.url || "")) {
    throw new Error("当前标签页不是 Muah AI 页面");
  }
  const response = await sendToMuahTab(tab.id, { type: "SET_NUMBERED_SLOT", slotNumber });
  if (!response?.ok) throw new Error(response?.error || "无法确认槽位编号");
  const state = await call({ type: "GET_TAB_STATE", tabId: tab.id });
  renderState(state);
  await Promise.all([refreshArchives(state?.resolution?.archive?.uuid), refreshRecords(), loadMemory(), loadSlotProfile(), loadComparison()]);
  return state;
}

elements.slotGrid.addEventListener("click", async (event) => {
  try {
    const button = event.target.closest("[data-slot-number]");
    if (!button) return;
    const slotNumber = Number(button.dataset.slotNumber);
    await activateNumberedSlot(slotNumber);
    toast(`已确认当前为槽位 ${slotNumber}`);
  } catch (error) { toast(error.message, true); }
});

elements.bindArchive.addEventListener("click", async () => {
  try {
    const archiveUuid = elements.archiveSelect.value;
    if (!archiveUuid) throw new Error("请选择本地存档");
    await requestScan("pre-bind");
    if (!activeTabId || !currentState?.identitySignature) throw new Error("当前没有可绑定的 Muah 槽位证据");
    const state = await call({
      type: "BIND_SLOT",
      tabId: activeTabId,
      archiveUuid,
      expectedSignature: currentState.identitySignature
    });
    renderState(state);
    await Promise.all([refreshArchives(archiveUuid), refreshRecords(), loadMemory(), loadSlotProfile(), loadComparison()]);
    toast("已绑定当前槽位");
  } catch (error) { toast(error.message, true); }
});

elements.refreshRecords.addEventListener("click", () => refreshRecords().catch((error) => toast(error.message, true)));

elements.openReader.addEventListener("click", async () => {
  try {
    const archive = currentState?.resolution?.archive;
    if (!currentState?.resolution?.canReadWrite || !archive?.uuid) {
      throw new Error("请先确认当前 Muah 槽位");
    }
    if (!Number(archive.messageCount || 0)) throw new Error("当前槽位尚无聊天记录");
    const url = chrome.runtime.getURL(`src/reader/reader.html?archive=${encodeURIComponent(archive.uuid)}`);
    await chrome.tabs.create({ url, active: true });
  } catch (error) { toast(error.message, true); }
});

elements.memoryTab.addEventListener("click", () => showTab("memory"));
elements.recordsTab.addEventListener("click", () => showTab("records"));
elements.memoryOutputMode.addEventListener("change", renderMemoryOutput);
elements.memorySegmentSize.addEventListener("change", renderMemoryOutput);
elements.memorySegment.addEventListener("change", renderMemoryOutput);

elements.syncCorePrompt.addEventListener("click", async () => {
  const context = slotContext();
  const slotNumber = currentState?.resolution?.identity?.slotNumber;
  try {
    const uuid = currentState?.resolution?.archive?.uuid;
    if (!uuid) throw new Error("请先确认当前槽位");
    const tab = await getActiveTab();
    if (!tab?.id || !/^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(tab.url || "")) throw new Error("当前标签页不是 Muah AI 页面");
    const response = await sendToMuahTab(tab.id, { type: "READ_CORE_PROMPT", slotNumber });
    if (!response?.ok) throw new Error(response?.error || "没有读取到核心提示词");
    const profile = await call({ ...context, type: "SAVE_SLOT_CORE_PROMPT", archiveUuid: uuid, corePrompt: response.corePrompt, source: "muah-auto" });
    if (context.archiveUuid !== currentUuid()) return;
    coreDirty = false;
    renderSlotProfile(profile);
    toast("核心提示词已同步到当前槽位");
  } catch (error) { toast(error.message, true); }
});

elements.saveCorePrompt.addEventListener("click", async () => {
  const context = slotContext();
  try {
    const uuid = currentState?.resolution?.archive?.uuid;
    if (!uuid) throw new Error("请先确认当前槽位");
    const profile = await call({
      ...context,
      type: "SAVE_SLOT_CORE_PROMPT",
      archiveUuid: uuid,
      corePrompt: elements.corePromptText.value,
      source: "manual"
    });
    if (context.archiveUuid !== currentUuid()) return;
    coreDirty = false;
    renderSlotProfile(profile);
    toast("核心提示词已保存到当前槽位 UUID");
  } catch (error) { toast(error.message, true); }
});

elements.generateMemory.addEventListener("click", async () => {
  const uuid = currentState?.resolution?.archive?.uuid;
  if (!uuid) return toast("请先确认当前槽位", true);
  jobs.set(uuid, { running: true });
  renderMemoryOperations();
  elements.memoryStatus.textContent = "正在按顺序处理尚未进入长期记忆的新聊天；已处理内容不会重复发送。";
  try {
    const memory = await call({ type: "GENERATE_MEMORY", archiveUuid: uuid });
    if (uuid === currentUuid()) {
      await loadMemory();
      toast(`长期记忆已增量更新至第 ${memory.processedMessageCount || memory.sourceMessageCount || 0} 条`);
    }
  } catch (error) {
    if (uuid === currentUuid()) {
      elements.memoryStatus.textContent = error.message;
      toast(error.message, true);
      await loadMemory();
    }
  } finally {
    jobs.set(uuid, { ...jobs.get(uuid), running: false });
    renderMemoryOperations();
  }
});

elements.rebuildMemory.addEventListener("click", async () => {
  const uuid = currentState?.resolution?.archive?.uuid;
  const count = Number(currentState?.resolution?.archive?.messageCount || 0);
  if (!uuid) return toast("请先确认当前槽位", true);
  const batchSize = Math.max(10, Math.min(200, Number(elements.recentMessageLimit.value) || 80));
  const calls = Math.ceil(count / batchSize);
  if (!confirm(`从头重建会按每批 ${batchSize} 条重新处理约 ${count} 条聊天，预计调用模型 ${Math.min(calls, 50)} 次。${calls > 50 ? "\n本次最多50批；剩余聊天在完成后点击增量提取继续。" : ""}\n\n当前记忆会先存入历史检查点；是否继续？`)) return;
  jobs.set(uuid, { running: true });
  renderMemoryOperations();
  elements.memoryStatus.textContent = `正在从第 1 条开始分批重建，预计 ${calls} 次模型调用…`;
  try {
    const memory = await call({ type: "REBUILD_MEMORY", archiveUuid: uuid });
    if (uuid === currentUuid()) {
      await loadMemory();
      toast(`已重建 ${memory.processedMessageCount || 0}/${memory.totalMessageCount || count} 条${memory.processedMessageCount < memory.totalMessageCount ? "；剩余可用增量继续" : ""}`);
    }
  } catch (error) {
    if (uuid === currentUuid()) {
      toast(error.message, true);
      await loadMemory();
    }
  } finally {
    jobs.set(uuid, { ...jobs.get(uuid), running: false });
    renderMemoryOperations();
  }
});

elements.checkpointSelect.addEventListener("change", renderCheckpointPreview);

elements.copyMemory.addEventListener("click", async () => {
  try {
    const text = memoryContext(selectedMemoryOutput());
    if (!text) throw new Error("当前槽位还没有提取记忆");
    await navigator.clipboard.writeText(text);
    toast("已复制全部精炼汇总");
  } catch (error) { toast(error.message, true); }
});

elements.copyMemorySegment.addEventListener("click", async () => {
  try {
    const index = Number(elements.memorySegment.value || 0);
    const text = memoryContext(memoryChunks[index], index);
    if (!text) throw new Error("当前槽位还没有可复制的记忆分段");
    await navigator.clipboard.writeText(text);
    toast(`已复制第 ${index + 1}/${memoryChunks.length} 段`);
  } catch (error) { toast(error.message, true); }
});

elements.insertMemory.addEventListener("click", async () => {
  const uuid = currentUuid();
  const slotNumber = currentState?.resolution?.identity?.slotNumber;
  try {
    const index = Number(elements.memorySegment.value || 0);
    const text = memoryContext(memoryChunks[index], index);
    if (!text) throw new Error("当前槽位还没有提取记忆");
    const tab = await getActiveTab();
    if (!tab?.id || !/^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(tab.url || "")) {
      throw new Error("当前标签页不是 Muah AI 页面");
    }
    if (uuid !== currentUuid()) throw new Error("槽位已变化，请重新选择输出");
    const response = await sendToMuahTab(tab.id, { type: "INSERT_MEMORY", text, slotNumber });
    if (!response?.ok) throw new Error(response?.error || "填入失败");
    toast(`已填入第 ${index + 1}/${memoryChunks.length} 段，请检查后手动发送`);
  } catch (error) { toast(error.message, true); }
});

elements.clearArchiveData.addEventListener("click", async () => {
  const uuid = currentState?.resolution?.archive?.uuid;
  const name = currentState?.resolution?.archive?.name;
  if (!uuid) return toast("请先选择要清理的槽位", true);
  const confirmed = confirm(`确定清除“${name}”的全部聊天和提取记忆吗？\n\n清除前会自动生成快照，但请确认当前选中的是误存槽位。`);
  if (!confirmed) return;
  try {
    if (activeTabId) await sendToMuahTab(activeTabId, { type: "PAUSE_CAPTURE" });
    const archive = await call({ type: "CLEAR_ARCHIVE_DATA", archiveUuid: uuid });
    if (currentState?.resolution?.archive?.uuid === uuid) {
      renderState({
        ...currentState,
        resolution: { ...currentState.resolution, archive }
      });
    }
    await Promise.all([refreshArchives(uuid), refreshRecords(), loadMemory()]);
    toast("当前槽位数据已清除，清除前快照已保留");
  } catch (error) { toast(error.message, true); }
});

elements.fetchModels.addEventListener("click", async () => {
  const original = elements.fetchModels.textContent;
  try {
    const config = apiFormConfig();
    await ensureApiPermission(config.baseUrl);
    elements.fetchModels.disabled = true;
    elements.fetchModels.textContent = "获取中…";
    elements.apiStatus.textContent = "正在读取模型目录并按当前账号权限过滤…";
    const result = await call({ type: "LIST_API_MODELS", config });
    renderModelOptions(result, config.modelName);
  } catch (error) {
    elements.apiStatus.textContent = error.message;
    toast(error.message, true);
  } finally {
    elements.fetchModels.disabled = false;
    elements.fetchModels.textContent = original;
  }
});

elements.testConnection.addEventListener("click", async () => {
  const original = elements.testConnection.textContent;
  try {
    const config = apiFormConfig();
    await ensureApiPermission(config.baseUrl);
    if (!config.modelName) throw new Error("请先从模型列表选择一个模型");
    const catalogEntry = modelCatalog.find((item) => item.id === config.modelName);
    if (catalogEntry && !catalogEntry.available) throw new Error(catalogEntry.unavailableReason);
    elements.testConnection.disabled = true;
    elements.testConnection.textContent = "测试中…";
    elements.apiStatus.textContent = `正在实际调用 ${config.modelName}…`;
    const result = await call({ type: "TEST_API_CONNECTION", config });
    const tokenText = result.usage?.total_tokens ? `，使用 ${result.usage.total_tokens} tokens` : "";
    elements.apiStatus.textContent = `连接成功：${result.model}${tokenText}。模型回复：${result.reply}`;
    toast("API 与所选模型均可用");
  } catch (error) {
    elements.apiStatus.textContent = error.message;
    toast(error.message, true);
  } finally {
    elements.testConnection.disabled = false;
    elements.testConnection.textContent = original;
  }
});

elements.exportArchive.addEventListener("click", async () => {
  try {
    const uuid = currentState?.resolution?.archive?.uuid;
    if (!uuid) throw new Error("当前没有可导出的存档");
    const payload = await call({ type: "EXPORT_ARCHIVE", archiveUuid: uuid });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `muah-memory-${payload.archive.name.replace(/[^\p{L}\p{N}._-]+/gu, "-")}-${uuid}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("存档已导出");
  } catch (error) { toast(error.message, true); }
});

elements.importFile.addEventListener("change", async () => {
  try {
    const file = elements.importFile.files?.[0];
    if (!file) return;
    const payload = JSON.parse(await file.text());
    const archive = await call({ type: "IMPORT_ARCHIVE", payload, surface: elements.pwaMode.checked ? "pwa" : "web" });
    await rememberImport(archive, "JSON");
    await refreshArchives(archive.uuid);
    toast("已导入为独立存档；请确认后手动绑定");
  } catch (error) { toast(error.message, true); }
  finally { elements.importFile.value = ""; }
});

function parseStoryHtml(source) {
  const documentNode = new DOMParser().parseFromString(String(source || ""), "text/html");
  const portable = documentNode.querySelector("#muah-rp-export-data[type='application/json']");
  if (portable?.textContent) {
    let payload;
    try { payload = JSON.parse(portable.textContent); }
    catch (_error) { throw new Error("HTML 内嵌的剧情数据已损坏"); }
    if (payload?.format !== "muah-rp-story-html" || payload?.version !== 1 || !Array.isArray(payload.messages)) {
      throw new Error("HTML 内嵌的剧情数据格式不受支持");
    }
    const messages = payload.messages.map((item) => ({
      role: item?.role === "user" ? "user" : "assistant",
      text: String(item?.text || "").trim(),
      observedAt: item?.observedAt || null
    })).filter((item) => item.text);
    return { name: String(payload.archiveName || documentNode.title || "HTML 剧情").trim(), messages };
  }

  // 兼容 v0.20.0 及更早版本导出的阅读 HTML；只读取明确的故事消息节点。
  const entries = [...documentNode.querySelectorAll(".story .entry")];
  const messages = entries.map((entry) => {
    const time = entry.querySelector("time");
    return {
      role: entry.classList.contains("user") ? "user" : "assistant",
      text: String(entry.querySelector(".text")?.textContent || "").trim(),
      observedAt: time?.getAttribute("datetime") || null
    };
  }).filter((item) => item.text);
  const name = String(documentNode.querySelector(".cover h1")?.textContent || documentNode.title || "HTML 剧情").trim();
  return { name, messages };
}

elements.importHtmlFile.addEventListener("change", async () => {
  try {
    const file = elements.importHtmlFile.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) throw new Error("HTML 文件超过 100 MB，已停止导入");
    const parsed = parseStoryHtml(await file.text());
    if (!parsed.messages.length) throw new Error("没有在 HTML 中找到“阅读全部”导出的剧情记录");
    const archive = await call({
      type: "IMPORT_STORY_HTML",
      name: parsed.name,
      messages: parsed.messages,
      surface: elements.pwaMode.checked ? "pwa" : "web"
    });
    await rememberImport(archive, "阅读 HTML");
    await refreshArchives(archive.uuid);
    toast(`已按原顺序导入 ${archive.messageCount || parsed.messages.length} 条剧情；请手动绑定对应槽位`);
  } catch (error) { toast(error.message, true); }
  finally { elements.importHtmlFile.value = ""; }
});

elements.saveSettings.addEventListener("click", async () => {
  try {
    const temperature = Number(elements.temperature.value);
    const maxTokens = Number(elements.maxTokens.value);
    const triggerMessageCount = Number(elements.triggerMessageCount.value);
    const recentMessageLimit = Number(elements.recentMessageLimit.value);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("Temperature 必须在 0–2 之间");
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Max Tokens 必须是正整数");
    if (!Number.isInteger(triggerMessageCount) || triggerMessageCount < 1 || triggerMessageCount > 200) throw new Error("自动总结触发条数必须在 1–200 之间");
    if (!Number.isInteger(recentMessageLimit) || recentMessageLimit < 10 || recentMessageLimit > 200) throw new Error("最近聊天条数必须在 10–200 之间");
    const baseUrl = elements.baseUrl.value.trim();
    if (baseUrl) {
      await ensureApiPermission(baseUrl);
    } else if (elements.autoExtractEnabled.checked) {
      throw new Error("启用自动提取前必须填写 Base URL");
    }
    await call({
      type: "SET_GLOBAL_SETTINGS",
      value: {
        writingPreferences: elements.writingPreferences.value.split("\n").map((item) => item.trim()).filter(Boolean),
        api: {
          baseUrl,
          apiKey: elements.apiKey.value,
          modelName: elements.modelName.value.trim(),
          temperature,
          maxTokens
        },
        memory: {
          autoExtractEnabled: elements.autoExtractEnabled.checked,
          triggerMessageCount,
          recentMessageLimit
        },
        capture: {
          mode: elements.captureMode.value === "manual" ? "manual" : "automatic",
          triggerMessageCount: Number(elements.captureTriggerCount.value || 2)
        }
      }
    });
    toast("模型与自动提取配置已保存");
  } catch (error) { toast(error.message, true); }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TARGET_CHANGED") {
    initialize().catch((error) => toast(error.message, true));
    return;
  }
  if (message?.type === "STATE_CHANGED" && message.tabId === activeTabId) {
    renderState(message.state);
    refreshArchives().catch(console.error);
    if (message.state?.lastInserted > 0 || message.state?.lastUpdated > 0) refreshRecords().catch(console.error);
    loadMemory().catch(console.error);
    loadSlotProfile().catch(console.error);
    loadComparison().catch(console.error);
  }
  if (message?.type === "MEMORY_CHANGED" && message.archiveUuid === currentState?.resolution?.archive?.uuid) {
    renderMemory(message.memory);
    loadMemory().catch(console.error);
  }
  if (message?.type === "MEMORY_ERROR" && message.archiveUuid === currentState?.resolution?.archive?.uuid) {
    elements.memoryStatus.textContent = message.error;
    toast(`自动提取失败：${message.error}`, true);
  }
  if (message?.type === "MEMORY_PROGRESS" && message.archiveUuid === currentState?.resolution?.archive?.uuid) {
    jobs.set(message.archiveUuid, message);
    renderMemoryOperations();
    elements.memoryStatus.textContent = `${message.running ? "增量记忆处理中" : "本次处理结束"}：${message.processedMessageCount}/${message.totalMessageCount} 条 · ${message.checkpointCount} 个历史检查点`;
  }
  if (message?.type === "SLOT_PROFILE_CHANGED" && message.archiveUuid === currentState?.resolution?.archive?.uuid) {
    renderSlotProfile(message.profile);
  }
});

async function initialize() {
  try {
    if (!pendingImport) {
      const stored = await chrome.storage.local.get("pendingImportedArchive");
      pendingImport = stored.pendingImportedArchive || null;
    }
    const tab = await getActiveTab();
    const state = tab?.id ? await call({ type: "GET_TAB_STATE", tabId: tab.id }) : null;
    renderState(state);
    await Promise.all([refreshArchives(), loadSettings()]);
    if (tab?.url && /^https:\/\/([\w-]+\.)*muah\.ai\//iu.test(tab.url)) {
      await requestScan("panel-open");
      await Promise.all([refreshArchives(), refreshRecords(), loadMemory(), loadSlotProfile(), loadComparison()]);
    }
  } catch (error) {
    renderState(null);
    toast(error.message, true);
  }
}

initialize();
