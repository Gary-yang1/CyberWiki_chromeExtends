export const STORAGE_KEY = "cyberWikiBenchSettings";

export const DEFAULT_BENCHMARK_API = "http://127.0.0.1:8765/api/v1";

export const DEFAULT_SYSTEM_PROMPT = [
  "你是网络安全知识题做题助手。",
  "根据题干和选项给出最可能正确的答案。",
  "只输出 JSON，不要输出 Markdown 或推理过程。",
  "单选题格式：{\"answer\":\"A\",\"confidence\":0.0}。",
  "多选题格式：{\"answer\":[\"A\",\"B\"],\"confidence\":0.0}。",
  "判断题格式：{\"answer\":true,\"confidence\":0.0}。"
].join("\n");

export const DEFAULT_RAG_SETTINGS = {
  enabled: false,
  endpoint: "http://127.0.0.1:8787/retrieve",
  collection: "",
  topK: 3,
  timeoutMs: 3_000,
  maxContextCharacters: 6_000,
  headers: {}
};

export const DEFAULT_OVERLAY_SETTINGS = {
  enabled: false,
  stealth: false,
  stealthOpacity: 0.08,
  opacity: 0.68,
  clickThrough: false,
  collapsed: true,
  position: {
    right: 18,
    bottom: 18
  }
};

export const DEFAULT_COLLECTOR_SETTINGS = {
  enabled: false,
  endpoint: "http://127.0.0.1:8790/api/v1/extractions",
  timeoutMs: 5_000
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  benchmarkApiBaseUrl: DEFAULT_BENCHMARK_API,
  profiles: [],
  defaultProfileId: null,
  routing: {
    primaryProfileId: null,
    verifierProfileId: null,
    fallbackProfileId: null,
    confidenceThreshold: 0.85,
    enableVerification: false
  },
  rag: DEFAULT_RAG_SETTINGS,
  overlay: DEFAULT_OVERLAY_SETTINGS,
  collector: DEFAULT_COLLECTOR_SETTINGS
};

function normalizeRag(value = {}) {
  return {
    ...DEFAULT_RAG_SETTINGS,
    ...(value || {}),
    enabled: value?.enabled === true,
    endpoint: String(value?.endpoint || DEFAULT_RAG_SETTINGS.endpoint).trim(),
    collection: String(value?.collection || "").trim(),
    topK: Math.min(Math.max(Number(value?.topK) || 3, 1), 10),
    timeoutMs: Math.min(Math.max(Number(value?.timeoutMs) || 3_000, 500), 30_000),
    maxContextCharacters: Math.min(Math.max(Number(value?.maxContextCharacters) || 6_000, 500), 20_000),
    headers: typeof value?.headers === "object" && value.headers ? value.headers : {}
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(Math.max(numeric, minimum), maximum)
    : fallback;
}

export function normalizeOverlaySettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const position = source.position && typeof source.position === "object"
    ? source.position
    : {};
  return {
    ...DEFAULT_OVERLAY_SETTINGS,
    ...source,
    enabled: source.enabled === true,
    stealth: source.stealth === true,
    stealthOpacity: clampNumber(source.stealthOpacity, DEFAULT_OVERLAY_SETTINGS.stealthOpacity, 0.01, 0.3),
    opacity: clampNumber(source.opacity, DEFAULT_OVERLAY_SETTINGS.opacity, 0.3, 1),
    clickThrough: source.clickThrough === true,
    collapsed: source.collapsed !== false,
    position: {
      right: clampNumber(position.right, DEFAULT_OVERLAY_SETTINGS.position.right, 8, 10_000),
      bottom: clampNumber(position.bottom, DEFAULT_OVERLAY_SETTINGS.position.bottom, 8, 10_000)
    }
  };
}

export function normalizeCollectorSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_COLLECTOR_SETTINGS,
    ...source,
    enabled: source.enabled === true,
    endpoint: String(source.endpoint || DEFAULT_COLLECTOR_SETTINGS.endpoint).trim(),
    timeoutMs: clampNumber(source.timeoutMs, DEFAULT_COLLECTOR_SETTINGS.timeoutMs, 500, 30_000)
  };
}

function chromeStorageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (value) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(value);
    });
  });
}

function chromeStorageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeProfile(profile = {}, existingProfile = null) {
  const now = new Date().toISOString();
  const protocol = profile.protocol === "anthropic_messages"
    ? "anthropic_messages"
    : "openai_chat_completions";
  const defaultEndpoint = protocol === "anthropic_messages"
    ? "https://api.anthropic.com/v1/messages"
    : "https://api.openai.com/v1/chat/completions";
  return {
    id: profile.id || crypto.randomUUID(),
    name: String(profile.name || "未命名模型").trim() || "未命名模型",
    protocol,
    endpoint: String(profile.endpoint || defaultEndpoint).trim(),
    modelsEndpoint: String(profile.modelsEndpoint || "").trim(),
    model: String(profile.model || "").trim(),
    authMode: profile.authMode === "none" ? "none" : "api_key",
    // Settings pages intentionally receive sanitized profiles. Preserve the
    // existing secret when their update omits this field, while still allowing
    // an explicit empty string to clear it.
    apiKey: hasOwn(profile, "apiKey")
      ? String(profile.apiKey || "")
      : String(existingProfile?.apiKey || ""),
    timeoutMs: Math.min(Math.max(Number(profile.timeoutMs) || 30_000, 1_000), 300_000),
    maxOutputTokens: Math.min(Math.max(Number(profile.maxOutputTokens) || 128, 16), 16_384),
    concurrency: Math.min(Math.max(Number(profile.concurrency) || 1, 1), 16),
    enabled: profile.enabled !== false,
    systemPrompt: String(profile.systemPrompt || DEFAULT_SYSTEM_PROMPT),
    anthropicVersion: String(profile.anthropicVersion || "2023-06-01"),
    customHeaders: typeof profile.customHeaders === "object" && profile.customHeaders
      ? profile.customHeaders
      : {},
    createdAt: profile.createdAt || now,
    updatedAt: now
  };
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const merged = {
    ...DEFAULT_SETTINGS,
    ...source,
    routing: { ...DEFAULT_SETTINGS.routing, ...(source.routing || {}) },
    rag: normalizeRag(source.rag),
    overlay: normalizeOverlaySettings(source.overlay),
    collector: normalizeCollectorSettings(source.collector)
  };
  merged.profiles = Array.isArray(source.profiles)
    ? source.profiles.map(normalizeProfile)
    : [];
  if (!merged.profiles.some((profile) => profile.id === merged.defaultProfileId)) {
    merged.defaultProfileId = merged.profiles.find((profile) => profile.enabled)?.id || null;
  }
  if (!merged.profiles.some((profile) => profile.id === merged.routing.primaryProfileId)) {
    merged.routing.primaryProfileId = merged.defaultProfileId;
  }
  return merged;
}

export async function getSettings() {
  const saved = await chromeStorageGet(STORAGE_KEY);
  return normalizeSettings(saved[STORAGE_KEY]);
}

/**
 * Returns a normalized settings snapshot that is safe to pass to extension UI.
 * Background code should continue to use getSettings(), which retains secrets
 * needed to call a model provider.
 */
export async function getPublicSettings() {
  return sanitizeSettings(await getSettings());
}

export async function replaceSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chromeStorageSet({ [STORAGE_KEY]: normalized });
  return normalized;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const saved = await replaceSettings({
    ...current,
    ...patch,
    routing: { ...current.routing, ...(patch.routing || {}) },
    rag: { ...current.rag, ...(patch.rag || {}) },
    collector: { ...current.collector, ...(patch.collector || {}) },
    overlay: {
      ...current.overlay,
      ...(patch.overlay || {}),
      position: {
        ...current.overlay?.position,
        ...(patch.overlay?.position || {})
      }
    }
  });
  return sanitizeSettings(saved);
}

export async function listProfiles() {
  return (await getPublicSettings()).profiles;
}

export async function getProfile(profileId) {
  const settings = await getSettings();
  const id = profileId || settings.routing.primaryProfileId || settings.defaultProfileId;
  return settings.profiles.find((profile) => profile.id === id) || null;
}

export async function getDefaultProfile() {
  const settings = await getSettings();
  return getProfile(settings.defaultProfileId);
}

export async function saveProfile(profile) {
  const settings = await getSettings();
  const profileId = profile?.id;
  const index = settings.profiles.findIndex((item) => item.id === profileId);
  const existingProfile = index >= 0 ? settings.profiles[index] : null;
  const normalized = normalizeProfile(profile, existingProfile);
  if (index >= 0) {
    normalized.createdAt = existingProfile.createdAt;
    settings.profiles[index] = normalized;
  } else {
    settings.profiles.push(normalized);
  }
  if (!settings.defaultProfileId && normalized.enabled) {
    settings.defaultProfileId = normalized.id;
  }
  if (!settings.routing.primaryProfileId && normalized.enabled) {
    settings.routing.primaryProfileId = normalized.id;
  }
  await replaceSettings(settings);
  return sanitizeProfile(normalized);
}

export async function deleteProfile(profileId) {
  const settings = await getSettings();
  settings.profiles = settings.profiles.filter((profile) => profile.id !== profileId);
  if (settings.defaultProfileId === profileId) {
    settings.defaultProfileId = settings.profiles.find((profile) => profile.enabled)?.id || null;
  }
  for (const key of ["primaryProfileId", "verifierProfileId", "fallbackProfileId"]) {
    if (settings.routing[key] === profileId) settings.routing[key] = null;
  }
  if (!settings.routing.primaryProfileId) {
    settings.routing.primaryProfileId = settings.defaultProfileId;
  }
  return sanitizeSettings(await replaceSettings(settings));
}

export async function setDefaultProfile(profileId) {
  const settings = await getSettings();
  if (!settings.profiles.some((profile) => profile.id === profileId && profile.enabled)) {
    throw new Error("请选择一个已启用的模型配置");
  }
  settings.defaultProfileId = profileId;
  settings.routing.primaryProfileId = profileId;
  return sanitizeSettings(await replaceSettings(settings));
}

export function sanitizeProfile(profile) {
  if (!profile) return profile;
  const { apiKey, ...safe } = profile;
  return { ...safe, hasApiKey: Boolean(apiKey) };
}

export function sanitizeSettings(settings = {}) {
  const { profiles, ...safe } = settings || {};
  return {
    ...safe,
    profiles: Array.isArray(profiles) ? profiles.map(sanitizeProfile) : [],
  };
}

/**
 * Subscribes to updates of the persisted settings document. The callback gets
 * a normalized, secret-free settings snapshot by default. Pass
 * { includeSecrets: true } only from trusted background code that needs model
 * credentials. The returned unsubscribe function is idempotent.
 */
export function subscribeToSettings(listener, { includeSecrets = false } = {}) {
  if (typeof listener !== "function") {
    throw new TypeError("subscribeToSettings requires a listener function");
  }
  const changeEvent = globalThis.chrome?.storage?.onChanged;
  if (!changeEvent?.addListener || !changeEvent?.removeListener) {
    return () => {};
  }

  let subscribed = true;
  const handleChange = (changes, areaName) => {
    if (!subscribed || areaName !== "local" || !hasOwn(changes, STORAGE_KEY)) return;
    const settings = normalizeSettings(changes[STORAGE_KEY]?.newValue);
    listener(includeSecrets ? settings : sanitizeSettings(settings));
  };
  changeEvent.addListener(handleChange);

  return () => {
    if (!subscribed) return;
    subscribed = false;
    changeEvent.removeListener(handleChange);
  };
}

export function validateProfile(profile) {
  const errors = [];
  if (!profile?.name?.trim()) errors.push("请填写配置名称");
  if (!profile?.model?.trim()) errors.push("请填写模型名称");
  try {
    const url = new URL(profile?.endpoint || "");
    if (!["https:", "http:"].includes(url.protocol)) errors.push("Endpoint 必须使用 http 或 https");
  } catch {
    errors.push("Endpoint URL 无效");
  }
  if (profile?.authMode !== "none" && !profile?.apiKey?.trim()) errors.push("请填写 API Key");
  return errors;
}

export function originPermissionPattern(endpoint) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new TypeError("只能请求 http 或 https 网站的访问权限。");
  }
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/*`;
}

export function hasOriginPermission(endpoint) {
  const origin = originPermissionPattern(endpoint);
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins: [origin] }, (granted) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

// These mirror the manifest's required host_permissions. They are granted at
// install time and can never be revoked at runtime, so the settings UI marks
// them as built-in instead of offering a remove button.
const REQUIRED_ORIGIN_PATTERNS = new Set(["http://127.0.0.1/*", "http://localhost/*"]);

export function isRequiredOriginPattern(origin) {
  return REQUIRED_ORIGIN_PATTERNS.has(String(origin || ""));
}

/** Every currently granted http(s) origin pattern, in sorted order. */
export function listGrantedOrigins() {
  return new Promise((resolve, reject) => {
    chrome.permissions.getAll((permissions) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const origins = Array.isArray(permissions?.origins) ? permissions.origins : [];
      resolve(origins.filter((origin) => /^https?:\/\//.test(origin)).sort());
    });
  });
}

/**
 * Revoke a previously granted optional origin. Resolves false when Chrome
 * could not remove it, for example a manifest-required permission.
 */
export function removeOriginPermission(originPattern) {
  return new Promise((resolve, reject) => {
    chrome.permissions.remove({ origins: [String(originPattern)] }, (removed) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Boolean(removed));
    });
  });
}

/**
 * Requests a declared optional host permission.  This intentionally calls
 * permissions.request() directly: Chrome requires the request to happen
 * during a user gesture, and an asynchronous contains() check first can lose
 * that gesture in side panel and options-page event handlers.
 */
export function requestOriginsPermission(endpoints) {
  const origins = [...new Set((endpoints || []).map(originPermissionPattern))];
  if (!origins.length) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins }, (granted) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

export function requestOriginPermission(endpoint) {
  return requestOriginsPermission([endpoint]);
}

export function createProfile(protocol = "openai_chat_completions") {
  const isAnthropic = protocol === "anthropic_messages";
  return normalizeProfile({
    protocol,
    name: isAnthropic ? "Anthropic 模型" : "OpenAI-compatible 模型",
    endpoint: isAnthropic
      ? "https://api.anthropic.com/v1/messages"
      : "https://api.openai.com/v1/chat/completions",
    model: "",
    apiKey: "",
    timeoutMs: 30_000,
    maxOutputTokens: 128,
    concurrency: 1,
    enabled: true
  });
}
