import { ProviderError } from "./provider-error.js";

export const MODEL_PROTOCOLS = Object.freeze({
  OPENAI_CHAT_COMPLETIONS: "openai_chat_completions",
  ANTHROPIC_MESSAGES: "anthropic_messages",
});

const SUPPORTED_PROTOCOLS = new Set(Object.values(MODEL_PROTOCOLS));
const RESERVED_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-api-key",
  "anthropic-version",
]);

const DEFAULTS_BY_PROTOCOL = Object.freeze({
  [MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS]: {
    baseUrl: "https://api.openai.com",
    endpoint: "/v1/chat/completions",
    authMode: "bearer",
  },
  [MODEL_PROTOCOLS.ANTHROPIC_MESSAGES]: {
    baseUrl: "https://api.anthropic.com",
    endpoint: "/v1/messages",
    authMode: "x-api-key",
  },
});

const VALID_AUTH_MODES = new Set(["bearer", "x-api-key", "none"]);

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isAbsoluteUrl(value) {
  return Boolean(parseHttpUrl(value));
}

function isLocalHost(value) {
  const url = parseHttpUrl(value);
  if (!url) {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

function normalizeHeaderMap(headers) {
  if (!isObject(headers)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = asTrimmedString(key);
    if (!headerName || typeof value !== "string") {
      continue;
    }
    normalized[headerName] = value.trim();
  }
  return normalized;
}

function numericOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize profiles supplied by the settings page without changing their
 * persistent shape. An absolute `endpoint` is sufficient; `baseUrl` is only
 * required when an endpoint is relative or omitted.
 */
export function normalizeModelProfile(rawProfile = {}) {
  const raw = isObject(rawProfile) ? rawProfile : {};
  const protocol = asTrimmedString(raw.protocol);
  const defaults = DEFAULTS_BY_PROTOCOL[protocol] || {};

  const explicitEndpoint = asTrimmedString(raw.endpoint);
  const baseUrl = asTrimmedString(raw.baseUrl || raw.baseURL || defaults.baseUrl);
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const endpointForLocalCheck = explicitEndpoint || baseUrl;
  const inferredAuthMode = apiKey || !isLocalHost(endpointForLocalCheck)
    ? defaults.authMode
    : "none";
  // The extension settings UI uses the convenient `api_key` label. Normalize
  // it to the wire-level header scheme expected by the selected protocol.
  const requestedAuthMode = asTrimmedString(raw.authMode);
  const authMode = requestedAuthMode === "api_key"
    ? defaults.authMode
    : requestedAuthMode || inferredAuthMode;

  return {
    id: asTrimmedString(raw.id),
    name: asTrimmedString(raw.name),
    protocol,
    // Keep an explicitly configured endpoint. Default paths are resolved by
    // getProfileEndpoint so a baseUrl can still be overridden independently.
    endpoint: explicitEndpoint,
    baseUrl,
    model: asTrimmedString(raw.model),
    apiKey,
    authMode,
    timeoutMs: numericOrDefault(raw.timeoutMs, 30_000),
    maxOutputTokens: numericOrDefault(raw.maxOutputTokens, 128),
    concurrency: numericOrDefault(raw.concurrency, 1),
    temperature: typeof raw.temperature === "number" && Number.isFinite(raw.temperature)
      ? raw.temperature
      : undefined,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
    customHeaders: normalizeHeaderMap(raw.customHeaders),
    anthropicVersion: asTrimmedString(raw.anthropicVersion) || "2023-06-01",
    enabled: raw.enabled !== false,
  };
}

export function getDefaultEndpoint(protocol) {
  return DEFAULTS_BY_PROTOCOL[protocol]?.endpoint || "";
}

/**
 * Complete the request path for endpoints supplied as a base URL. Providers
 * usually document base addresses such as https://api.deepseek.com/v1; calling
 * that verbatim 404s while the derived GET /models works, so the catalog would
 * succeed while every chat call fails. Bare origins get the protocol's default
 * path; versioned bases get the chat suffix appended. Any other custom path is
 * kept verbatim to stay compatible with gateways that expose their own routes.
 */
export function completeCallPath(url, protocol) {
  const suffix = protocol === MODEL_PROTOCOLS.ANTHROPIC_MESSAGES
    ? "/messages"
    : "/chat/completions";
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) {
    url.pathname = getDefaultEndpoint(protocol);
  } else if (!new RegExp(`${suffix}$`, "i").test(pathname) && /\/v\d+$/.test(pathname)) {
    url.pathname = `${pathname}${suffix}`;
  }
  return url.toString();
}

/**
 * Build a safe HTTP(S) endpoint. It intentionally accepts a complete endpoint
 * string because that is the simplest form for local OpenAI-compatible hosts.
 */
export function getProfileEndpoint(profile) {
  const normalized = normalizeModelProfile(profile);
  const endpoint = normalized.endpoint || getDefaultEndpoint(normalized.protocol);

  if (isAbsoluteUrl(endpoint)) {
    return completeCallPath(new URL(endpoint), normalized.protocol);
  }

  const base = parseHttpUrl(normalized.baseUrl);
  if (!base || !endpoint) {
    return "";
  }

  // String joining preserves a path such as http://localhost:11434/v1.
  // URL(endpoint, base) would discard that path for endpoints beginning '/'.
  const baseText = base.toString().replace(/\/+$/, "");
  const endpointText = endpoint.replace(/^\/+/, "");
  return `${baseText}/${endpointText}`;
}

function validateCustomHeaders(headers, errors) {
  if (headers === undefined || headers === null) {
    return;
  }
  if (!isObject(headers)) {
    errors.push("customHeaders must be a plain object.");
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = asTrimmedString(name).toLowerCase();
    if (!normalizedName || typeof value !== "string") {
      errors.push("customHeaders must contain non-empty string names and string values.");
      continue;
    }
    if (RESERVED_HEADERS.has(normalizedName)) {
      errors.push(`customHeaders must not override the reserved header '${name}'.`);
    }
  }
}

/**
 * Return validation errors instead of throwing so settings forms can show all
 * problems at once. Use assertValidModelProfile before issuing a request.
 */
export function validateModelProfile(rawProfile, options = {}) {
  const raw = isObject(rawProfile) ? rawProfile : null;
  const normalized = normalizeModelProfile(rawProfile);
  const errors = [];

  if (!raw) {
    errors.push("Model profile must be an object.");
  }
  if (!SUPPORTED_PROTOCOLS.has(normalized.protocol)) {
    errors.push("protocol must be 'openai_chat_completions' or 'anthropic_messages'.");
  }
  if (!normalized.model) {
    errors.push("model is required.");
  }
  if (!VALID_AUTH_MODES.has(normalized.authMode)) {
    errors.push("authMode must be 'bearer', 'x-api-key', or 'none'.");
  }
  if (!Number.isInteger(normalized.timeoutMs) || normalized.timeoutMs < 1 || normalized.timeoutMs > 300_000) {
    errors.push("timeoutMs must be an integer between 1 and 300000.");
  }
  if (!Number.isInteger(normalized.maxOutputTokens) || normalized.maxOutputTokens < 1 || normalized.maxOutputTokens > 32_768) {
    errors.push("maxOutputTokens must be an integer between 1 and 32768.");
  }
  if (!Number.isInteger(normalized.concurrency) || normalized.concurrency < 1 || normalized.concurrency > 64) {
    errors.push("concurrency must be an integer between 1 and 64.");
  }
  if (normalized.temperature !== undefined && (normalized.temperature < 0 || normalized.temperature > 2)) {
    errors.push("temperature must be between 0 and 2.");
  }

  const endpoint = getProfileEndpoint(normalized);
  if (!parseHttpUrl(endpoint)) {
    errors.push("endpoint must be an absolute HTTP(S) URL, or baseUrl must be a valid HTTP(S) URL.");
  }
  validateCustomHeaders(raw?.customHeaders, errors);

  const providedApiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : normalized.apiKey;
  if (options.requireCredentials && normalized.authMode !== "none" && !providedApiKey) {
    errors.push("An API key is required for the selected authMode.");
  }

  return {
    valid: errors.length === 0,
    errors,
    profile: normalized,
    endpoint,
  };
}

export function assertValidModelProfile(rawProfile, options = {}) {
  const result = validateModelProfile(rawProfile, options);
  if (!result.valid) {
    throw new ProviderError(result.errors.join(" "), {
      code: "invalid_profile",
      protocol: result.profile.protocol,
      details: { errors: result.errors },
    });
  }
  return result;
}

export function resolveApiKey(profile, options = {}) {
  const explicit = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const fromProfile = typeof profile?.apiKey === "string" ? profile.apiKey.trim() : "";
  return explicit || fromProfile;
}

export function buildProviderHeaders(profile, options = {}) {
  const normalized = normalizeModelProfile(profile);
  const apiKey = resolveApiKey(normalized, options);
  const headers = {
    "content-type": "application/json",
    ...normalized.customHeaders,
  };

  if (normalized.authMode === "bearer") {
    if (!apiKey) {
      throw new ProviderError("An API key is required for bearer authentication.", {
        code: "invalid_profile",
        protocol: normalized.protocol,
      });
    }
    headers.authorization = `Bearer ${apiKey}`;
  } else if (normalized.authMode === "x-api-key") {
    if (!apiKey) {
      throw new ProviderError("An API key is required for x-api-key authentication.", {
        code: "invalid_profile",
        protocol: normalized.protocol,
      });
    }
    headers["x-api-key"] = apiKey;
  }

  if (normalized.protocol === MODEL_PROTOCOLS.ANTHROPIC_MESSAGES) {
    headers["anthropic-version"] = normalized.anthropicVersion;
  }

  return headers;
}

export function isSupportedModelProtocol(protocol) {
  return SUPPORTED_PROTOCOLS.has(protocol);
}
