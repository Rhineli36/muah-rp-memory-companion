import { getArchive, listMessages } from "../core/storage.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);

let archive = null;
let messages = [];

function dateText(value) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time not recorded" : date.toLocaleString("en", { hour12: false });
}

function safeFilename(value) {
  return String(value || "Muah-RP-Story-Archive").replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-").slice(0, 100);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderStory() {
  const fragment = document.createDocumentFragment();
  messages.forEach((message, index) => {
    const article = document.createElement("article");
    article.className = `entry ${message.role === "user" ? "user" : "assistant"}`;
    article.dataset.searchText = message.text.toLocaleLowerCase();

    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const speaker = document.createElement("span");
    speaker.textContent = message.role === "user" ? "You" : "AI";
    const time = document.createElement("time");
    time.textContent = dateText(message.observedAt || message.capturedAt);
    meta.append(speaker, time);

    const text = document.createElement("div");
    text.className = "entry-text";
    text.textContent = message.text;
    article.append(meta, text);
    article.id = `message-${index + 1}`;
    fragment.append(article);
  });
  elements.story.replaceChildren(fragment);
  elements.emptyState.classList.toggle("hidden", messages.length > 0);
}

function applySearch() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const entry of elements.story.querySelectorAll(".entry")) {
    const matches = !query || entry.dataset.searchText.includes(query);
    entry.classList.toggle("hidden-by-search", !matches);
    if (matches) visible += 1;
  }
  elements.resultStatus.textContent = query
    ? `Found ${visible} / ${messages.length} entries`
    : `${messages.length} entries · ordered locally from first to last`;
}

function standaloneHtml() {
  const entries = messages.map((message) => `
    <article class="entry ${message.role === "user" ? "user" : "assistant"}">
      <div class="meta"><span>${message.role === "user" ? "You" : "AI"}</span><time datetime="${escapeHtml(message.observedAt || message.capturedAt || "")}">${escapeHtml(dateText(message.observedAt || message.capturedAt))}</time></div>
      <div class="text">${escapeHtml(message.text)}</div>
    </article>`).join("");
  const title = escapeHtml(archive?.name || "Muah RP Story Archive");
  const portableData = JSON.stringify({
    format: "muah-rp-story-html",
    version: 1,
    archiveName: archive?.name || "Muah RP Story Archive",
    sourceArchiveUuid: archive?.uuid || null,
    exportedAt: new Date().toISOString(),
    messages: messages.map((message, index) => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.text,
      observedAt: message.observedAt || message.capturedAt || null,
      order: index + 1
    }))
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#09101d;color:#edf3ff}body{margin:0}.wrap{width:min(calc(100% - 32px),920px);margin:auto;padding:60px 0 100px}.cover{text-align:center;padding:50px 24px;margin-bottom:36px;border:1px solid #263754;border-radius:26px;background:#101a2c}.cover h1{font-family:Georgia,"Noto Serif SC",serif;font-size:clamp(32px,6vw,58px);margin:0}.cover p{color:#96a5bd}.story{display:grid;gap:20px}.entry{max-width:88%;padding:20px 22px;border:1px solid #263754;border-radius:22px;background:#111b30}.entry.user{justify-self:end;color:#101728;border:0;background:linear-gradient(120deg,#53e4ee,#d8ff68)}.meta{display:flex;justify-content:space-between;gap:18px;margin-bottom:10px;color:#96a5bd;font-size:11px}.entry.user .meta{color:#263140}.text{font:18px/1.9 Georgia,"Noto Serif SC",serif;white-space:pre-wrap;overflow-wrap:anywhere}@media print{:root{color-scheme:light;background:#fff;color:#111}.wrap{width:100%;padding:0}.cover{border:0;break-after:page}.entry{box-shadow:none;break-inside:avoid}.entry.user{background:#eef7f2;border:1px solid #cfded5}}
  </style></head><body><main class="wrap"><section class="cover"><h1>${title}</h1><p>${messages.length} raw chat entries · exported ${escapeHtml(new Date().toLocaleString("en", { hour12: false }))}</p></section><section class="story">${entries}</section></main><script id="muah-rp-export-data" type="application/json">${portableData}</script></body></html>`;
}

function downloadHtml() {
  if (!archive) return;
  const blob = new Blob([standaloneHtml()], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFilename(archive.name)}-complete-story.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initialize() {
  try {
    const uuid = new URLSearchParams(location.search).get("archive");
    if (!uuid) throw new Error("The reader URL is missing an archive UUID");
    [archive, messages] = await Promise.all([
      getArchive(uuid),
      listMessages(uuid, Number.MAX_SAFE_INTEGER)
    ]);
    if (!archive) throw new Error("This local archive could not be found and may have been deleted");
    const slot = Number(archive.metadata?.fixedSlotNumber);
    const surface = archive.metadata?.slotSurface === "pwa" ? "PWA" : "Web";
    document.title = `${archive.name} · Story Reader`;
    elements.storyTitle.textContent = archive.name;
    elements.coverTitle.textContent = archive.name;
    elements.slotLabel.textContent = Number.isInteger(slot) ? `${surface} · Muah slot ${slot}` : `${surface} · Independent local archive`;
    elements.storyMeta.textContent = `${messages.length} entries · last updated ${dateText(archive.updatedAt)}`;
    elements.coverSummary.textContent = "This is the slot's locally archived raw chat. No AI rewriting is applied.";
    renderStory();
    applySearch();
  } catch (error) {
    elements.storyTitle.textContent = "Unable to open story archive";
    elements.resultStatus.textContent = error.message || String(error);
    elements.emptyState.classList.remove("hidden");
  }
}

elements.searchInput.addEventListener("input", applySearch);
elements.fontSize.addEventListener("change", () => document.documentElement.style.setProperty("--reading-size", `${elements.fontSize.value}px`));
elements.readingWidth.addEventListener("change", () => document.documentElement.style.setProperty("--reading-width", `${elements.readingWidth.value}px`));
elements.themeButton.addEventListener("click", () => {
  const light = document.body.classList.toggle("light");
  elements.themeButton.textContent = light ? "Dark" : "Light";
});
elements.printButton.addEventListener("click", () => window.print());
elements.exportHtml.addEventListener("click", downloadHtml);
elements.backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

initialize();
