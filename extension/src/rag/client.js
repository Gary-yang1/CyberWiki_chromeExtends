export class RagError extends Error {
  constructor(message, code = "rag_error") {
    super(message);
    this.name = "RagError";
    this.code = code;
  }
}

function compactQuestion(question) {
  if (typeof question === "string") return question;
  const stem = question?.stem || question?.question || question?.title || "";
  const options = Array.isArray(question?.options)
    ? question.options.map((item) => `${item.key || item.label || ""}. ${item.text || item.content || ""}`).join("\n")
    : "";
  return [stem, options].filter(Boolean).join("\n");
}

function normalizeChunks(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.chunks || payload?.results || payload?.documents || [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item, index) => {
      if (typeof item === "string") return { text: item, source: "", score: null, index };
      return {
        text: String(item?.text || item?.content || item?.document || "").trim(),
        source: String(item?.source || item?.title || item?.metadata?.source || "").trim(),
        score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
        index,
      };
    })
    .filter((item) => item.text);
}

export async function retrieveContext(config, question, { fetchImpl = fetch } = {}) {
  if (!config?.enabled) return { enabled: false, chunks: [], context: "" };
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new RagError("RAG 检索地址无效。", "rag_invalid_endpoint");
  }
  if (!/^https?:$/.test(endpoint.protocol)) {
    throw new RagError("RAG 检索地址必须使用 HTTP 或 HTTPS。", "rag_invalid_endpoint");
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(Number(config.timeoutMs) || 3_000, 500), 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.headers || {}) },
      body: JSON.stringify({
        query: compactQuestion(question),
        top_k: Math.min(Math.max(Number(config.topK) || 3, 1), 10),
        ...(config.collection ? { collection: config.collection } : {}),
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new RagError(body?.error?.message || `RAG 服务返回 HTTP ${response.status}`, "rag_http_error");
    }
    const chunks = normalizeChunks(body);
    const maxContextCharacters = Math.min(Math.max(Number(config.maxContextCharacters) || 6_000, 500), 20_000);
    let used = 0;
    const selected = [];
    for (const chunk of chunks) {
      const remaining = maxContextCharacters - used;
      if (remaining <= 0) break;
      const text = chunk.text.slice(0, remaining);
      selected.push({ ...chunk, text });
      used += text.length;
    }
    const context = selected.map((chunk, index) => {
      const label = chunk.source ? `来源：${chunk.source}` : `资料片段 ${index + 1}`;
      return `[${label}]\n${chunk.text}`;
    }).join("\n\n");
    return { enabled: true, chunks: selected, context };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new RagError("RAG 检索超时。", "rag_timeout");
    }
    if (error instanceof RagError) throw error;
    throw new RagError(error?.message || "RAG 检索服务不可用。", "rag_unavailable");
  } finally {
    clearTimeout(timer);
  }
}
