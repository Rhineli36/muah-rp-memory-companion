export class ApiClient {
  constructor(config) {
    this.config = { ...config };
  }

  endpoint() {
    const baseUrl = String(this.config.baseUrl || "").trim().replace(/\/+$/u, "");
    if (!baseUrl) throw new Error("Configure the API Base URL first");
    if (/\/chat\/completions$/u.test(baseUrl)) return baseUrl;
    return `${baseUrl}/chat/completions`;
  }

  apiRoot() {
    return String(this.config.baseUrl || "").trim()
      .replace(/\/+$/u, "")
      .replace(/\/chat\/completions$/u, "");
  }

  headers() {
    const apiKey = String(this.config.apiKey || "").trim();
    if (!apiKey) throw new Error("Configure an API key first");
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
    if (/(^|\.)openrouter\.ai$/iu.test(new URL(this.apiRoot()).hostname)) {
      headers["X-OpenRouter-Metadata"] = "enabled";
      headers["X-Title"] = "Muah RP Memory Companion";
    }
    return headers;
  }

  async requestJson(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...this.headers(), ...(options.headers || {}) } });
    const text = await response.text();
    if (!response.ok) throw new Error(this.formatApiError(response.status, text));
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new Error("The API returned invalid JSON");
    }
  }

  formatApiError(status, text) {
    let payload;
    try { payload = JSON.parse(text); } catch (_error) { payload = null; }
    const error = payload?.error || {};
    const router = payload?.openrouter_metadata || {};
    const details = [error.message || text || `HTTP ${status}`];
    if (error.metadata?.reason) details.push(`原因：${error.metadata.reason}`);
    if (error.metadata?.provider_name) details.push(`Provider：${error.metadata.provider_name}`);
    if (error.metadata?.raw) details.push(`Provider 返回：${String(error.metadata.raw)}`);
    if (router.region) details.push(`地域路由：${router.region}`);
    if (router.summary) details.push(`路由摘要：${router.summary}`);
    const stages = Array.isArray(router.pipeline)
      ? router.pipeline.map((item) => item.summary).filter(Boolean).slice(0, 4)
      : [];
    if (stages.length) details.push(`限制：${stages.join("；")}`);
    return `API 请求失败 (${status})：${details.join("；").slice(0, 1200)}`;
  }

  async listModels() {
    const root = this.apiRoot();
    if (!root) throw new Error("Configure the API Base URL first");
    const catalog = await this.requestJson(`${root}/models`, { method: "GET" });
    const allModels = Array.isArray(catalog?.data) ? catalog.data : [];
    if (!allModels.length) throw new Error("The model endpoint returned no usable models");

    let allowedIds = null;
    let accountFiltered = false;
    let filterWarning = "";
    if (/(^|\.)openrouter\.ai$/iu.test(new URL(root).hostname)) {
      try {
        const filtered = await this.requestJson(`${root}/models/user`, { method: "GET" });
        allowedIds = new Set((filtered?.data || []).map((item) => item.id).filter(Boolean));
        accountFiltered = true;
      } catch (error) {
        filterWarning = `账号可用性过滤接口不可用：${error.message}`;
      }
    }

    const models = allModels.map((item) => ({
      id: item.id,
      name: item.name || item.id,
      contextLength: item.context_length || null,
      promptPrice: item.pricing?.prompt || null,
      completionPrice: item.pricing?.completion || null,
      available: allowedIds ? allowedIds.has(item.id) : true,
      unavailableReason: allowedIds && !allowedIds.has(item.id)
        ? "This model is unavailable under the current OpenRouter provider preferences, privacy settings, guardrails, or regional filters"
        : ""
    })).filter((item) => item.id).sort((left, right) => left.name.localeCompare(right.name));
    return { models, accountFiltered, filterWarning };
  }

  async testConnection() {
    const model = String(this.config.modelName || "").trim();
    if (!model) throw new Error("Select a Model Name from the fetched list");
    const result = await this.chatCompletion({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      responseFormat: null,
      // Reasoning models may spend their first tokens thinking before producing
      // the final "OK". Eight tokens caused a false negative with finish_reason=length.
      overrides: { temperature: 0, max_tokens: 256 }
    });
    return { ok: true, model: result.model, reply: result.content.trim(), usage: result.usage };
  }

  completionContent(payload) {
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const joined = content.map((part) => {
        if (typeof part === "string") return part;
        return typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "";
      }).join("\n").trim();
      if (joined) return joined;
    }
    if (typeof choice?.text === "string" && choice.text.trim()) return choice.text;
    if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
    return "";
  }

  emptyCompletionError(payload, retried = false) {
    const choice = payload?.choices?.[0] || {};
    const message = choice.message || {};
    const finishReason = choice.finish_reason || choice.native_finish_reason || "not provided";
    const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
    const reasoningTokens = payload?.usage?.completion_tokens_details?.reasoning_tokens
      ?? payload?.usage?.output_tokens_details?.reasoning_tokens
      ?? null;
    const details = [`finish_reason=${finishReason}`];
    if (payload?.error?.message) details.push(`API 错误：${payload.error.message}`);
    if (message.refusal) details.push(`拒绝原因：${String(message.refusal)}`);
    if (reasoning || Array.isArray(message.reasoning_details)) {
      details.push(`返回了推理内容${reasoningTokens !== null ? `（${reasoningTokens} reasoning tokens）` : ""}，但没有最终答案`);
    }
    if (finishReason === "length") details.push("The output budget was exhausted; a reasoning model may have spent its tokens on internal reasoning");
    if (finishReason === "content_filter") details.push("Provider content filtering blocked the final response");
    if (retried) details.push("The request was retried once without JSON mode, but the final response was still empty");
    return `模型没有返回可用正文（${details.join("；")}）。${finishReason === "length"
      ? "Try a non-reasoning model or send fewer chat entries."
      : "Try another provider/model or verify structured-output support."}`;
  }

  async chatCompletion({ messages, responseFormat = "json_object", overrides = {} }) {
    const apiKey = String(this.config.apiKey || "").trim();
    const model = String(this.config.modelName || "").trim();
    if (!apiKey) throw new Error("Configure an API key first");
    if (!model) throw new Error("Select a model first");

    const body = {
      model,
      messages,
      temperature: overrides.temperature ?? Number(this.config.temperature ?? 0.3),
      max_tokens: overrides.max_tokens ?? Number(this.config.maxTokens ?? 1600)
    };
    if (responseFormat) body.response_format = { type: responseFormat };

    const send = () => fetch(this.endpoint(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    let response = await send();
    if (!response.ok && response.status === 400 && body.response_format) {
      const firstError = await response.text();
      if (/response[_ ]format|json[_ ]object/iu.test(firstError)) {
        delete body.response_format;
        response = await send();
      } else {
        throw new Error(this.formatApiError(400, firstError));
      }
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(this.formatApiError(response.status, detail || response.statusText));
    }
    let payload = await response.json();
    let content = this.completionContent(payload);
    let retriedWithoutResponseFormat = false;
    if (!content && body.response_format) {
      const finishReason = payload?.choices?.[0]?.finish_reason;
      const unsafeToRetry = ["length", "content_filter", "tool_calls"].includes(finishReason);
      if (!unsafeToRetry) {
        delete body.response_format;
        retriedWithoutResponseFormat = true;
        response = await send();
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 800);
          throw new Error(this.formatApiError(response.status, detail || response.statusText));
        }
        payload = await response.json();
        content = this.completionContent(payload);
      }
    }
    if (!content) throw new Error(this.emptyCompletionError(payload, retriedWithoutResponseFormat));
    return {
      content,
      usage: payload.usage || null,
      model: payload.model || model,
      finishReason: payload?.choices?.[0]?.finish_reason || null,
      retriedWithoutResponseFormat
    };
  }
}
