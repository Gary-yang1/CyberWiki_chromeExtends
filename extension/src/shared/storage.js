export const STORAGE_KEY = "cyberWikiBenchSettings";

export const DEFAULT_BENCHMARK_API = "http://127.0.0.1:8765/api/v1";

export const DEFAULT_SYSTEM_PROMPT = [
  "你是网络安全知识题做题助手。",
  "根据题干和选项给出最可能正确的答案。",
  "只输出 JSON，不要输出 Markdown 或推理过程。",
  "单选题格式：{\"answer\":\"A\",\"confidence\":0.0}。",
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
  rag: DEFAULT_RAG_SETTINGS
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

function normalizeProfile(profile) {
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
    model: String(profile.model || "").trim(),
    authMode: profile.authMode === "none" ? "none" : "api_key",
    apiKey: String(profile.apiKey || ""),
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
  const merged = {
    ...DEFAULT_SETTINGS,
    ...value,
    routing: { ...DEFAULT_SETTINGS.routing, ...(value.routing || {}) },
    rag: normalizeRag(value.rag)
  };
  merged.profiles = Array.isArray(value.profiles)
    ? value.profiles.map(normalizeProfile)
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

export async function replaceSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chromeStorageSet({ [STORAGE_KEY]: normalized });
  return normalized;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  return replaceSettings({
    ...current,
    ...patch,
    routing: { ...current.routing, ...(patch.routing || {}) },
    rag: { ...current.rag, ...(patch.rag || {}) }
  });
}

export async function listProfiles() {
  return (await getSettings()).profiles;
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
  const normalized = normalizeProfile(profile);
  const index = settings.profiles.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    normalized.createdAt = settings.profiles[index].createdAt;
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
  return normalized;
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
  return replaceSettings(settings);
}

export async function setDefaultProfile(profileId) {
  const settings = await getSettings();
  if (!settings.profiles.some((profile) => profile.id === profileId && profile.enabled)) {
    throw new Error("请选择一个已启用的模型配置");
  }
  settings.defaultProfileId = profileId;
  settings.routing.primaryProfileId = profileId;
  return replaceSettings(settings);
}

export function sanitizeProfile(profile) {
  if (!profile) return profile;
  const { apiKey, ...safe } = profile;
  return { ...safe, hasApiKey: Boolean(apiKey) };
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

export async function requestOriginPermission(endpoint) {
  const url = new URL(endpoint);
  const origin = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/*`;
  const hasPermission = await new Promise((resolve) => {
    chrome.permissions.contains({ origins: [origin] }, resolve);
  });
  if (hasPermission) return true;
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [origin] }, resolve);
  });
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
