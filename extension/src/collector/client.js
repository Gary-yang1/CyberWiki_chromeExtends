/*
 * Client for the local question-collector server (collector/server.py).
 * Mirrors the RAG client: injectable fetch for unit tests, AbortController
 * timeout, and typed errors carrying status/code for the badge feedback.
 */

export class CollectorError extends Error {
  constructor(message, { status = 0, code = "collector_error", cause } = {}) {
    super(message);
    this.name = "CollectorError";
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function normalizeTimeout(timeoutMs) {
  const numeric = Number(timeoutMs);
  return Number.isFinite(numeric) ? Math.min(Math.max(numeric, 500), 30_000) : 5_000;
}

function requireEndpoint(config) {
  const endpoint = String(config?.endpoint || "").trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new CollectorError("题库采集服务地址无效，请在侧边栏设置。", { code: "invalid_endpoint" });
  }
  return endpoint;
}

async function fetchWithCollectorTimeout(url, init, config, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new CollectorError("当前环境不支持网络请求。", { code: "fetch_unavailable" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizeTimeout(config?.timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new CollectorError("题库采集服务响应超时。", { code: "collector_timeout", cause: error });
    }
    throw new CollectorError("无法连接题库采集服务，请确认已运行 start_collector.sh。", {
      code: "collector_network_error",
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST one page extraction to the collector. Payload shape matches the
 * server's POST /api/v1/extractions. Returns the normalized confirmation.
 */
export async function collectExtraction(config, payload = {}, { fetchImpl = globalThis.fetch } = {}) {
  const endpoint = requireEndpoint(config);
  const response = await fetchWithCollectorTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, config, fetchImpl);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new CollectorError(
      data?.error?.message || `题库采集服务返回 HTTP ${response.status}。`,
      { status: response.status, code: data?.error?.code || "collector_http_error" },
    );
  }
  return {
    saved: data?.saved === true,
    extraction: {
      id: String(data?.extraction?.id || ""),
      questionCount: Number(data?.extraction?.questionCount) || 0,
      contentHash: String(data?.extraction?.contentHash || ""),
    },
  };
}

/**
 * Probe the collector's GET /api/v1/health for the sidepanel test button.
 * The configured endpoint points at /api/v1/extractions, so probe the same
 * origin's health route.
 */
export async function checkCollectorHealth(config, { fetchImpl = globalThis.fetch } = {}) {
  const endpoint = requireEndpoint(config);
  const healthUrl = `${new URL(endpoint).origin}/api/v1/health`;
  const startedAt = Date.now();
  const response = await fetchWithCollectorTimeout(healthUrl, { method: "GET" }, config, fetchImpl);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new CollectorError(
      data?.error?.message || `题库采集服务返回 HTTP ${response.status}。`,
      { status: response.status, code: data?.error?.code || "collector_http_error" },
    );
  }
  return {
    ok: true,
    service: String(data?.service || ""),
    latencyMs: Date.now() - startedAt,
  };
}
