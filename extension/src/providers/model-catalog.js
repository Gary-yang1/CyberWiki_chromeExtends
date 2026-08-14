import {
  MODEL_PROTOCOLS,
  buildProviderHeaders,
  completeCallPath,
  normalizeModelProfile,
  resolveApiKey,
} from "../shared/model-profile.js";
import { ProviderError } from "../shared/provider-error.js";
import { fetchWithTimeout } from "../shared/fetch-timeout.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const NON_CHAT_MODEL_PATTERN = /(?:embedding|moderation|whisper|transcrib|\btts\b|speech|audio|realtime|image|dall[._-]?e|sora|video)/i;
const CATALOG_PROTOCOLS = new Set([
  MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
  MODEL_PROTOCOLS.ANTHROPIC_MESSAGES,
]);

function asHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function normalizeTimeout(timeoutMs) {
  return Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 60_000);
}

function catalogUnsupported(profile) {
  return new ProviderError("当前模型服务不支持自动获取模型列表；请继续手动填写模型 ID。", {
    code: "model_catalog_unsupported",
    protocol: profile?.protocol,
  });
}

/**
 * Resolve the companion models endpoint without assuming that an
 * OpenAI-compatible gateway is hosted at the public OpenAI origin.
 */
export function deriveModelsEndpoint(rawProfile = {}, options = {}) {
  const profile = normalizeModelProfile(rawProfile);
  if (!CATALOG_PROTOCOLS.has(profile.protocol)) {
    throw catalogUnsupported(profile);
  }

  const suppliedEndpoint = asHttpUrl(profile.endpoint || options.endpoint);
  if (!suppliedEndpoint) {
    throw new ProviderError("请先填写有效的 Chat Completions Endpoint。", {
      code: "invalid_profile",
      protocol: profile.protocol,
    });
  }
  // Derive from the completed call path so a base-style endpoint (e.g.
  // https://host or https://host/v1) yields the same versioned base as the
  // actual chat request instead of a root-level /models.
  const requestEndpoint = new URL(completeCallPath(suppliedEndpoint, profile.protocol));

  const configured = String(rawProfile?.modelsEndpoint || options.modelsEndpoint || "").trim();
  if (configured) {
    const explicit = asHttpUrl(configured);
    if (explicit) return explicit.toString();
    try {
      const resolved = new URL(configured, requestEndpoint);
      if (!["http:", "https:"].includes(resolved.protocol)) throw new Error("invalid protocol");
      return resolved.toString();
    } catch {
      throw new ProviderError("模型列表 Endpoint 必须是有效的 HTTP(S) URL 或相对路径。", {
        code: "invalid_profile",
        protocol: profile.protocol,
      });
    }
  }

  const modelsEndpoint = new URL(requestEndpoint.toString());
  const pathname = modelsEndpoint.pathname.replace(/\/+$/, "");
  const versionMatch = pathname.match(/^(.*\/v\d+)(?:\/.*)?$/i);
  if (versionMatch) {
    modelsEndpoint.pathname = `${versionMatch[1]}/models`;
  } else if (/\/chat\/completions$/i.test(pathname)) {
    modelsEndpoint.pathname = pathname.replace(/\/chat\/completions$/i, "/models");
  } else {
    modelsEndpoint.pathname = `${pathname || ""}/models`.replace(/^([^/])/, "/$1");
  }
  modelsEndpoint.search = "";
  modelsEndpoint.hash = "";
  return modelsEndpoint.toString();
}

/**
 * Build headers for a GET /models request using the profile's existing auth.
 * Model discovery frequently crosses protocol styles on the same host — e.g.
 * an Anthropic-compatible gateway (DeepSeek) that only lists models on the
 * OpenAI-style /v1/models — so send both header styles when a key exists;
 * servers ignore the style they do not recognize.
 */
export function buildModelsRequestHeaders(rawProfile = {}, options = {}) {
  const profile = normalizeModelProfile(rawProfile);
  if (!CATALOG_PROTOCOLS.has(profile.protocol)) {
    throw catalogUnsupported(profile);
  }
  const headers = buildProviderHeaders(profile, options);
  const apiKey = resolveApiKey(profile, options);
  if (apiKey && profile.authMode !== "none") {
    headers.authorization ??= `Bearer ${apiKey}`;
    headers["x-api-key"] ??= apiKey;
  }
  return headers;
}

function asModelRecord(value) {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, displayName: "", ownedBy: "", created: null } : null;
  }
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || value.model || value.name || value.slug || "").trim();
  if (!id) return null;
  const displayName = String(value.display_name || value.displayName || value.label || "").trim();
  const ownedBy = String(value.owned_by || value.ownedBy || value.owner || value.provider || "").trim();
  const createdValue = Number(value.created ?? value.created_at ?? value.createdAt);
  return {
    id,
    displayName,
    ownedBy,
    created: Number.isFinite(createdValue) ? createdValue : null,
  };
}

function findModelCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.result?.data)) return payload.result.data;
  if (Array.isArray(payload.result?.models)) return payload.result.models;
  return [];
}

/**
 * Normalize OpenAI's `{ data: [...] }` response and common compatible
 * response variants. `models` is deliberately complete; callers can use the
 * recommended subset as a display default without losing accessible IDs.
 */
export function normalizeModelCatalog(payload) {
  const byId = new Map();
  for (const item of findModelCandidates(payload)) {
    const model = asModelRecord(item);
    if (!model) continue;
    const prior = byId.get(model.id);
    if (!prior
      || (!prior.displayName && model.displayName)
      || (!prior.ownedBy && model.ownedBy)
      || (prior.created === null && model.created !== null)) {
      byId.set(model.id, model);
    }
  }
  const models = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    models,
    recommendedModels: models.filter((model) => !NON_CHAT_MODEL_PATTERN.test(model.id)),
  };
}

function responseRequestId(headers) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get("x-request-id") || headers.get("request-id") || undefined;
  }
  return headers["x-request-id"] || headers["request-id"];
}

async function readJson(response) {
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (!text || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("模型列表服务返回了无效的 JSON。", {
        code: "invalid_response",
      });
    }
  }
  if (typeof response?.json === "function") {
    try {
      return await response.json();
    } catch {
      throw new ProviderError("模型列表服务返回了无效的 JSON。", {
        code: "invalid_response",
      });
    }
  }
  throw new ProviderError("模型列表服务没有返回可读取的响应。", {
    code: "invalid_response",
  });
}

function isOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  return Number(response?.status) >= 200 && Number(response?.status) < 300;
}

function errorMessage(payload, status) {
  const message = payload?.error?.message || payload?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : `模型列表服务返回 HTTP ${status || "错误"}。`;
}

function catalogSource(endpoint, protocol) {
  if (protocol === MODEL_PROTOCOLS.ANTHROPIC_MESSAGES) return "Anthropic Models API";
  const host = new URL(endpoint).hostname.toLowerCase();
  return host === "api.openai.com" ? "OpenAI Models API" : "OpenAI-compatible Models API";
}

/**
 * Ordered candidate URLs for model discovery. An explicitly configured
 * modelsEndpoint is authoritative and never falls back; a derived endpoint
 * may be missing on gateways that host the catalog on a different path
 * (e.g. DeepSeek's Anthropic layer serves calls at /anthropic/v1/messages
 * but only lists models on the OpenAI-style /v1/models), so same-origin
 * fallbacks are appended for automatic discovery.
 */
export function modelsEndpointCandidates(rawProfile = {}, options = {}) {
  const primary = deriveModelsEndpoint(rawProfile, options);
  const explicit = String(rawProfile?.modelsEndpoint || options.modelsEndpoint || "").trim();
  if (explicit) return [primary];
  const { origin } = new URL(primary);
  const candidates = [primary];
  for (const fallback of [`${origin}/v1/models`, `${origin}/models`]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  return candidates;
}

/**
 * Fetch models available to this profile. The returned data intentionally
 * excludes the profile and every credential; it is safe to forward to UI.
 */
export async function listProviderModels(rawProfile = {}, options = {}) {
  const profile = normalizeModelProfile(rawProfile);
  const headers = buildModelsRequestHeaders(rawProfile, options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderError("当前环境不支持网络请求。", {
      code: "fetch_unavailable",
      protocol: profile.protocol,
    });
  }

  async function fetchCatalog(modelsEndpoint) {
    let response;
    let latencyMs;
    try {
      const outcome = await fetchWithTimeout(modelsEndpoint, {
        method: "GET",
        headers,
      }, {
        timeoutMs: normalizeTimeout(options.timeoutMs || profile.timeoutMs),
        signal: options.signal,
        fetchImpl,
      });
      response = outcome.value;
      latencyMs = outcome.latencyMs;
    } catch (error) {
      if (error instanceof ProviderError) {
        error.protocol ||= profile.protocol;
        throw error;
      }
      throw new ProviderError("无法连接模型列表服务。", {
        code: "network_error",
        protocol: profile.protocol,
        retryable: true,
        cause: error,
      });
    }

    const status = Number.isInteger(response?.status) ? response.status : 0;
    const requestId = responseRequestId(response?.headers);
    const payload = await readJson(response);
    if (!isOk(response)) {
      throw new ProviderError(errorMessage(payload, status), {
        code: "model_catalog_http_error",
        status,
        protocol: profile.protocol,
        requestId,
        retryable: status === 408 || status === 429 || status >= 500,
        details: { errorType: payload?.error?.type || payload?.error?.code },
      });
    }

    const catalog = normalizeModelCatalog(payload);
    return {
      ...catalog,
      fetchedAt: new Date().toISOString(),
      modelsEndpoint,
      source: catalogSource(modelsEndpoint, profile.protocol),
      requestId,
      latencyMs,
    };
  }

  let lastError;
  for (const candidate of modelsEndpointCandidates(rawProfile, options)) {
    try {
      return await fetchCatalog(candidate);
    } catch (error) {
      // Only "path does not exist" justifies trying the next candidate.
      // Auth failures, rate limits and server errors must surface as-is.
      if (!(error instanceof ProviderError)
        || error.code !== "model_catalog_http_error"
        || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}
