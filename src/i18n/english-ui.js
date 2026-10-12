(() => {
  "use strict";
  const exact = new Map(Object.entries({
    "未确认":"Unconfirmed","正常":"Ready","存档冲突":"Archive conflict","暂停抓取":"Capture paused",
    "立即抓取":"Capture now","确认并抓取":"Confirm and capture","未选择":"Not selected","未初始化":"Not initialized",
    "尚未生成":"Not generated","尚无检查点":"No checkpoints","尚无输出":"No output","无":"None",
    "获取中…":"Fetching…","测试中…":"Testing…","对比并生成补全":"Compare and generate supplement",
    "正在建立长期记忆…":"Building long-term memory…","正在交叉对比…":"Comparing sources…",
    "尚未保存聊天记录。":"No chat entries have been saved.","当前没有可显示的记录。":"No records to display.",
    "重要事实":"Important facts","人物设定":"Characters","人物关系":"Relationships","剧情时间线":"Story timeline",
    "未完成剧情与伏笔":"Open threads","两处均遗漏":"Missing from both Muah sources","仅核心提示词覆盖":"Covered only by core prompt",
    "冲突 / 待确认":"Conflicts / review required","压缩 / 未纳入":"Compressed / omitted",
    "当前槽位尚未保存核心提示词。":"No core prompt has been saved for this slot.",
    "尚未保存对照摘要":"No comparison summary saved","读取失败":"Read failed","填入失败":"Insert failed",
    "扩展操作失败":"Extension operation failed","页面扫描失败":"Page scan failed","无法确认槽位编号":"Could not confirm the slot number",
    "存档已导出":"Archive exported","已重新识别当前槽位":"Current slot redetected",
    "已立即抓取并保存当前聊天":"Current chat captured and saved","已处理全部聊天":"All chat entries processed",
    "已绑定当前槽位":"Current slot bound","已复制全部精炼汇总":"Complete compact output copied",
    "模型与自动提取配置已保存":"Model and automatic extraction settings saved","API 与所选模型均可用":"API and selected model are available",
    "时间顺序汇总已生成":"Chronological summary generated","资料已变化，请重新对比":"Sources changed; run the comparison again",
    "补全结果已生成，请检查冲突列表后复制":"Supplement generated. Review the conflict list before copying.",
    "没有需要复制的补充":"There is no supplement to copy","当前槽位还没有提取记忆":"This slot has no extracted memory yet",
    "当前槽位尚无聊天记录":"This slot has no chat records","当前没有可导出的存档":"There is no current archive to export",
    "请选择本地存档":"Select a local archive","请输入新存档名称":"Enter a new archive name",
    "请先获取模型列表":"Fetch the model list first","请选择模型":"Select a model","没有账号可用模型":"No models are available to this account",
    "请先填写 Base URL":"Enter a Base URL first","请先从模型列表选择一个模型":"Select a model from the model list first",
    "未授予该 API 域名的访问权限":"Access to this API domain was not granted",
    "当前没有 Muah 标签页":"No Muah tab is currently available","当前标签页不是 Muah AI 页面":"The current tab is not a Muah AI page",
    "请打开 Muah AI Chatroom 页面。":"Open a Muah AI Chatroom page.","等待选择槽位":"Waiting for slot selection",
    "PWA 独立应用":"PWA app","普通网页":"regular browser tab","网页":"Web","模型":"model","用户":"User",
    "从 Muah 读取":"Read from Muah","已保存":"Saved","已从 Muah 同步":"Synced from Muah","已手动保存":"Saved manually"
  }));
  const patterns = [
    [/^(\d+) 条聊天$/u, "$1 chat entries"],
    [/^槽位 (\d+) → /u, "Slot $1 → "],
    [/^已选择槽位 (\d+)$/u, "Selected slot $1"],
    [/^绑定到当前槽位 (\d+)$/u, "Bind to current slot $1"],
    [/^第 (\d+)\/(\d+) 段$/u, "Segment $1/$2"],
    [/^记忆历史存档 · (\d+) 个检查点$/u, "Memory history · $1 checkpoints"],
    [/^自动抓取：每新增约 (\d+) 条保存一次。$/u, "Automatic capture: save after approximately $1 changed entries."],
    [/^自动抓取：已累计约 (\d+)\/(\d+) 条，达到阈值后批量保存。$/u, "Automatic capture: approximately $1/$2 changes pending."],
    [/^仅手动抓取：不会自动写入聊天记录。$/u, "Manual capture only: chat is never written automatically."],
    [/^已确认当前为槽位 (\d+)$/u, "Confirmed as slot $1"],
    [/^已设置为每新增约 (\d+) 条自动抓取$/u, "Automatic capture set to approximately every $1 changed entries"],
    [/^正在抓取：(.+)$/u, "Capturing: $1"],
    [/^Capturing: 普通网页 · (.+)$/u, "Capturing: Web · $1"],
    [/^Capturing: PWA 独立应用 · (.+)$/u, "Capturing: PWA · $1"],
    [/^普通网页 · (.+)$/u, "Web · $1"],
    [/^网页 · (.+)$/u, "Web · $1"],
    [/^Web · 槽位 (\d+) · (.+)$/u, "Web · slot $1 · $2"],
    [/^Web · 槽位 (\d+)$/u, "Web · slot $1"],
    [/^PWA 独立应用 · (.+)$/u, "PWA · $1"],
    [/^初始化网页槽位 1–10（一一对应）$/u, "Initialize Web slots 1–10 (one-to-one)"],
    [/^初始化 PWA槽位 1–10（一一对应）$/u, "Initialize PWA slots 1–10 (one-to-one)"],
    [/^用户 · (.+)$/u, "User · $1"],
    [/^已手动保存 · (.+)$/u, "Saved manually · $1"],
    [/^已从 Muah 同步 · (.+)$/u, "Synced from Muah · $1"],
    [/^正在切换到(.+)模式…$/u, "Switching to $1 mode…"],
    [/^未找到普通 Muah 网页$/u, "No regular Muah tab found"],
    [/^未找到 PWA 独立应用$/u, "No Muah PWA found"],
    [/^(\d+) 字符 · 预算 (\d+)(.*)$/u, "$1 characters · budget $2$3"],
    [/^已处理 (\d+)\/(\d+) 条 · (\d+) 个检查点 · /u, "Processed $1/$2 entries · $3 checkpoints · "],
    [/^正在处理 (\d+)–(\d+) \/ (\d+)$/u, "Processing $1–$2 / $3"],
    [/^增量提取 · (\d+) 条待处理$/u, "Incremental extraction · $1 pending"],
    [/^长期记忆已追平至第 (\d+) 条$/u, "Long-term memory is current through entry $1"]
  ];
  function translate(value) {
    let text = String(value ?? "");
    if (exact.has(text)) return exact.get(text);
    for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
    return text;
  }
  function apply(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const translated = translate(node.data);
      if (translated !== node.data) node.data = translated;
    }
    const elements = root instanceof Element ? [root, ...root.querySelectorAll("[title],[aria-label],[placeholder]")] : [...root.querySelectorAll("[title],[aria-label],[placeholder]")];
    for (const element of elements) for (const attribute of ["title", "aria-label", "placeholder"]) {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, translate(element.getAttribute(attribute)));
    }
  }
  const nativeConfirm = globalThis.confirm?.bind(globalThis);
  if (nativeConfirm) globalThis.confirm = (message) => nativeConfirm(translate(message));
  globalThis.__muahTranslateEnglish = translate;
  addEventListener("DOMContentLoaded", () => {
    apply();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          const translated = translate(record.target.data);
          if (translated !== record.target.data) record.target.data = translated;
        } else for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) apply(node);
          if (node.nodeType === Node.TEXT_NODE) {
            const translated = translate(node.data);
            if (translated !== node.data) node.data = translated;
          }
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }, { once: true });
})();
