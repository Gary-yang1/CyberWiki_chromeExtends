import {
  deleteProfile,
  getPublicSettings,
  isRequiredOriginPattern,
  listGrantedOrigins,
  originPermissionPattern,
  removeOriginPermission,
  requestOriginPermission,
  saveProfile,
  setDefaultProfile,
  subscribeToSettings,
} from "../src/shared/storage.js";
import { deriveModelsEndpoint } from "../src/providers/model-catalog.js";

const DEFAULT_ENDPOINTS = {
  openai_chat_completions: "https://api.openai.com/v1/chat/completions",
  anthropic_messages: "https://api.anthropic.com/v1/messages",
};

const state = {
  profiles: [],
  defaultProfileId: null,
  editingId: null,
  unsubscribeSettings: null,
  modelCatalog: {
    models: [],
    recommendedIds: new Set(),
    fetchedAt: null,
    source: "",
    modelsEndpoint: "",
    cached: false,
    stale: false,
  },
};

const $ = (selector) => document.querySelector(selector);

function profileId(value) {
  return typeof value === "string" ? value : value?.id || null;
}

function protocolLabel(protocol) {
  return protocol === "anthropic_messages" ? "Anthropic Messages" : "OpenAI-compatible";
}

function endpointHint(protocol) {
  return protocol === "anthropic_messages"
    ? "Anthropic 使用 /v1/messages，认证头会自动使用 x-api-key。"
    : "使用 Chat Completions 兼容接口，认证头会自动使用 Bearer Token。";
}

function showToast(message, variant = "default") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", variant === "error");
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function setStatus(message, variant = "") {
  const status = $("#formStatus");
  status.textContent = message;
  status.className = `form-status${variant ? ` is-${variant}` : ""}`;
}

function setButtonBusy(button, busy, text) {
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.originalText;
}

function setModelCatalogStatus(message, variant = "") {
  const status = $("#modelCatalogStatus");
  status.textContent = message;
  status.className = `model-catalog-status${variant ? ` is-${variant}` : ""}`;
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("Chrome 扩展运行环境不可用。"));
      return;
    }
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return reject(new Error(runtimeError.message));
      if (!response) return reject(new Error("后台服务没有返回响应。"));
      if (response.ok === false) return reject(new Error(response.error?.message || response.error || "请求失败。"));
      resolve(response.data ?? response);
    });
  });
}

function profileHasKey(profile) {
  return profile?.authMode === "none" || Boolean(profile?.hasApiKey || profile?.apiKey || profile?.secretRef || profile?.keyConfigured);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCatalogModel(value) {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, label: id, searchText: id.toLowerCase() } : null;
  }
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || value.model || value.name || "").trim();
  if (!id) return null;
  const displayName = String(value.displayName || value.display_name || value.label || "").trim();
  const owner = String(value.ownedBy || value.owned_by || value.owner || value.provider || "").trim();
  const labelParts = [displayName && displayName !== id ? `${displayName} — ${id}` : id];
  if (owner) labelParts.push(owner);
  return {
    id,
    label: labelParts.join(" · "),
    searchText: `${id} ${displayName} ${owner}`.toLowerCase(),
  };
}

function formatCatalogTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function currentCatalogModels() {
  const search = $("#modelCatalogSearch").value.trim().toLowerCase();
  const showAll = $("#showAllModels").checked;
  const allModels = state.modelCatalog.models;
  const recommended = state.modelCatalog.recommendedIds;
  const scopedModels = showAll || !recommended.size
    ? allModels
    : allModels.filter((model) => recommended.has(model.id));
  return scopedModels.filter((model) => !search || model.searchText.includes(search));
}

function renderModelCatalog() {
  const select = $("#modelCatalog");
  const search = $("#modelCatalogSearch");
  const summary = $("#modelCatalogSummary");
  const meta = $("#modelCatalogMeta");
  const hasModels = state.modelCatalog.models.length > 0;
  const catalogUsable = hasModels && !state.modelCatalog.stale;
  const models = currentCatalogModels();
  const showAll = $("#showAllModels").checked;
  const recommended = state.modelCatalog.recommendedIds;
  const selectedModel = $("#profileModel").value.trim();

  search.disabled = !catalogUsable;
  select.disabled = !catalogUsable;
  select.replaceChildren();

  if (!hasModels) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "点击“刷新模型列表”后选择";
    select.append(option);
    summary.textContent = "使用当前 Endpoint、认证方式和 API Key 刷新列表。";
    meta.textContent = "";
    return;
  }

  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有匹配的模型；仍可在上方手动填写模型 ID";
    select.append(option);
  } else {
    const recommendedModels = models.filter((model) => recommended.has(model.id));
    const otherModels = models.filter((model) => !recommended.has(model.id));
    const appendOptions = (parent, entries) => {
      entries.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.label;
        parent.append(option);
      });
    };
    if (showAll && recommendedModels.length && otherModels.length) {
      const recommendedGroup = document.createElement("optgroup");
      recommendedGroup.label = "推荐模型";
      appendOptions(recommendedGroup, recommendedModels);
      const otherGroup = document.createElement("optgroup");
      otherGroup.label = "其他可用模型";
      appendOptions(otherGroup, otherModels);
      select.append(recommendedGroup, otherGroup);
    } else {
      appendOptions(select, models);
    }
  }

  const total = state.modelCatalog.models.length;
  const recommendationCount = state.modelCatalog.recommendedIds.size;
  const filtered = models.length;
  const filterSuffix = $("#modelCatalogSearch").value.trim() ? `，匹配 ${filtered} 个` : "";
  const scopeText = showAll || !recommendationCount ? `共 ${total} 个可用模型` : `推荐 ${recommendationCount} / 共 ${total} 个模型`;
  summary.textContent = `${scopeText}${filterSuffix}`;

  const details = [];
  const fetchedAt = formatCatalogTime(state.modelCatalog.fetchedAt);
  if (fetchedAt) details.push(`上次刷新：${fetchedAt}`);
  if (state.modelCatalog.cached) details.push("缓存结果");
  if (state.modelCatalog.source) details.push(`来源：${state.modelCatalog.source}`);
  meta.textContent = details.join(" · ");

  const hasSelectedOption = models.some((model) => model.id === selectedModel);
  select.value = hasSelectedOption ? selectedModel : "";
}

function resetModelCatalog() {
  state.modelCatalog = {
    models: [],
    recommendedIds: new Set(),
    fetchedAt: null,
    source: "",
    modelsEndpoint: "",
    cached: false,
    stale: false,
  };
  $("#modelCatalogSearch").value = "";
  renderModelCatalog();
  setModelCatalogStatus("");
}

function markModelCatalogStale() {
  const catalog = state.modelCatalog;
  catalog.stale = true;
  renderModelCatalog();
  setModelCatalogStatus(
    catalog.models.length
      ? "Endpoint、协议或认证信息已变更；模型列表已过期，请刷新。"
      : "当前连接配置已变更；填写完成后可刷新模型列表。",
    "stale",
  );
}

function validateCatalogProfile(profile) {
  try {
    const endpoint = new URL(profile.endpoint);
    if (!/^https?:$/.test(endpoint.protocol)) return "Endpoint 只能使用 HTTP 或 HTTPS。";
  } catch {
    return "刷新模型列表前请填写有效的完整 Endpoint URL。";
  }
  if (profile.authMode !== "none" && !profile.apiKey && !profileHasKey(state.profiles.find((item) => item.id === profile.id))) {
    return "刷新模型列表前请填写 API Key。";
  }
  return null;
}

function catalogPermissionProfile(profile) {
  const stored = state.profiles.find((item) => item.id === (state.editingId || profile.id));
  if (!stored) return profile;
  return {
    ...stored,
    ...profile,
    // A custom catalog endpoint belongs to the saved request endpoint. If the
    // user changes that endpoint, derive a fresh /models URL instead.
    ...(stored.endpoint !== profile.endpoint ? { modelsEndpoint: "" } : {}),
  };
}

function applyCatalogResult(result) {
  const modelsById = new Map();
  const recommendedIds = new Set();
  asArray(result?.models).forEach((value) => {
    const model = normalizeCatalogModel(value);
    if (model) modelsById.set(model.id, model);
  });
  asArray(result?.recommendedModels).forEach((value) => {
    const model = normalizeCatalogModel(value);
    if (!model) return;
    recommendedIds.add(model.id);
    if (!modelsById.has(model.id)) modelsById.set(model.id, model);
  });
  const models = [...modelsById.values()].sort((left, right) => left.id.localeCompare(right.id));
  state.modelCatalog = {
    models,
    recommendedIds,
    fetchedAt: result?.fetchedAt || new Date().toISOString(),
    source: String(result?.source || "").trim(),
    modelsEndpoint: String(result?.modelsEndpoint || "").trim(),
    cached: result?.cached === true,
    stale: false,
  };
  renderModelCatalog();
}

async function refreshModelCatalog() {
  const profile = currentFormProfile();
  const validationError = validateCatalogProfile(profile);
  if (validationError) {
    setModelCatalogStatus(validationError, "error");
    return;
  }
  const button = $("#refreshModelsButton");
  setButtonBusy(button, true, "正在刷新…");
  setModelCatalogStatus("正在从模型服务获取可用模型…");
  try {
    // Request the origin actually used by GET /models while this click still
    // carries a user gesture. The service worker must only verify permission.
    const modelsEndpoint = deriveModelsEndpoint(catalogPermissionProfile(profile));
    const permitted = await requestOriginPermission(modelsEndpoint);
    if (!permitted) {
      throw new Error("未获得模型列表服务的访问权限。请允许浏览器弹出的站点权限请求后重试。");
    }
    const response = await sendMessage("LIST_PROVIDER_MODELS", {
      profile,
      profileId: state.editingId || profile.id,
      includeAll: $("#showAllModels").checked,
    });
    const result = response?.result || response;
    applyCatalogResult(result);
    const count = state.modelCatalog.models.length;
    const suffix = result?.cached ? "（缓存结果）" : "";
    setModelCatalogStatus(
      count
        ? `已获取 ${count} 个可用模型${suffix}。选择后会自动填入模型 ID。`
        : "未获取到可选模型；该服务可能不提供模型列表，仍可手动填写模型 ID。",
      count ? "success" : "",
    );
  } catch (error) {
    state.modelCatalog.stale = true;
    renderModelCatalog();
    setModelCatalogStatus(`无法获取模型列表：${error.message}。仍可手动填写模型 ID。`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateProfileCount() {
  const total = state.profiles.length;
  const enabled = state.profiles.filter((profile) => profile.enabled !== false).length;
  $("#profileCount").textContent = total ? `${enabled} / ${total} 个模型已启用` : "尚未保存模型";
}

function createBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${className}`.trim();
  badge.textContent = text;
  return badge;
}

function renderProfileList() {
  const list = $("#profileList");
  list.replaceChildren();
  updateProfileCount();
  if (!state.profiles.length) {
    const empty = document.createElement("div");
    empty.className = "empty-profiles";
    const title = document.createElement("strong");
    title.textContent = "还没有模型配置";
    const description = document.createElement("p");
    description.textContent = "从右侧添加 OpenAI-compatible 或 Anthropic 模型，然后即可在 Side Panel 中选择。";
    empty.append(title, description);
    list.append(empty);
    return;
  }
  state.profiles.forEach((profile) => {
    const card = document.createElement("article");
    card.className = `profile-card${profile.id === state.editingId ? " is-selected" : ""}${profile.enabled === false ? " is-disabled" : ""}`;
    const head = document.createElement("div");
    head.className = "profile-card-head";
    const titleBlock = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = profile.name || profile.model || "未命名模型";
    const model = document.createElement("p");
    model.textContent = profile.model || "尚未填写模型 ID";
    titleBlock.append(title, model);
    head.append(titleBlock);
    const badges = document.createElement("div");
    badges.className = "profile-badges";
    badges.append(createBadge(protocolLabel(profile.protocol), profile.protocol === "anthropic_messages" ? "anthropic" : ""));
    if (profile.id === state.defaultProfileId) badges.append(createBadge("默认", "default"));
    if (profile.enabled === false) badges.append(createBadge("已禁用"));
    if (!profileHasKey(profile)) badges.append(createBadge("未配置密钥", "missing-key"));
    const actions = document.createElement("div");
    actions.className = "profile-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => startEditing(profile.id));
    const makeDefault = document.createElement("button");
    makeDefault.type = "button";
    makeDefault.textContent = profile.id === state.defaultProfileId ? "当前默认" : "设为默认";
    makeDefault.disabled = profile.id === state.defaultProfileId;
    makeDefault.addEventListener("click", () => makeDefaultProfile(profile.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.className = "danger-action";
    remove.addEventListener("click", () => removeProfile(profile));
    actions.append(edit, makeDefault, remove);
    card.append(head, badges, actions);
    list.append(card);
  });
}

function applyStoredProfiles(settings) {
  state.profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
  state.defaultProfileId = profileId(settings?.defaultProfileId)
    || state.profiles.find((profile) => profile.enabled !== false)?.id
    || null;
  if (state.editingId && !state.profiles.some((profile) => profile.id === state.editingId)) {
    setFormForNewProfile();
    setStatus("正在编辑的模型配置已在其他扩展页面删除。", "error");
    return;
  }
  renderProfileList();
}

function setFormForNewProfile() {
  state.editingId = null;
  $("#profileForm").reset();
  $("#profileId").value = "";
  $("#profileProtocol").value = "openai_chat_completions";
  $("#profileAuthMode").value = "api_key";
  $("#profileEndpoint").value = DEFAULT_ENDPOINTS.openai_chat_completions;
  $("#profileTimeout").value = "30000";
  $("#profileMaxTokens").value = "128";
  $("#profileEnabled").checked = true;
  $("#profileDefault").checked = state.profiles.length === 0;
  $("#profileApiKey").value = "";
  $("#profileApiKey").type = "password";
  $("#toggleKeyButton").textContent = "显示";
  $("#formHeading").textContent = "新建模型配置";
  $("#formKicker").textContent = "NEW PROFILE";
  $("#editingBadge").hidden = true;
  updateProtocolHelp();
  resetModelCatalog();
  setStatus("");
  renderProfileList();
}

function startEditing(id) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return;
  state.editingId = id;
  $("#profileId").value = profile.id;
  $("#profileName").value = profile.name || "";
  $("#profileProtocol").value = profile.protocol || "openai_chat_completions";
  $("#profileAuthMode").value = profile.authMode || "api_key";
  $("#profileModel").value = profile.model || "";
  $("#profileEndpoint").value = profile.endpoint || profile.url || DEFAULT_ENDPOINTS[profile.protocol] || "";
  $("#profileApiKey").value = "";
  $("#profileApiKey").type = "password";
  $("#toggleKeyButton").textContent = "显示";
  $("#profileTimeout").value = Number(profile.timeoutMs ?? profile.timeout_ms ?? 30_000);
  $("#profileMaxTokens").value = Number(profile.maxOutputTokens ?? profile.max_tokens ?? 128);
  $("#profileEnabled").checked = profile.enabled !== false;
  $("#profileDefault").checked = profile.id === state.defaultProfileId;
  $("#formHeading").textContent = "编辑模型配置";
  $("#formKicker").textContent = "EDIT PROFILE";
  $("#editingBadge").hidden = false;
  updateProtocolHelp();
  resetModelCatalog();
  setStatus(profileHasKey(profile) ? "API Key 已保存；留空不会覆盖它。" : "该配置尚未保存 API Key。", "success");
  renderProfileList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateProtocolHelp() {
  const protocol = $("#profileProtocol").value;
  const authMode = $("#profileAuthMode").value;
  $("#endpointHint").textContent = endpointHint(protocol);
  const keyInput = $("#profileApiKey");
  const keyField = $("#apiKeyField");
  if (authMode === "none") {
    $("#apiKeyLabel").textContent = "API Key（当前认证方式不使用密钥）";
    $("#keyHint").textContent = "适合未认证的本地 OpenAI-compatible 服务。已有密钥不会因切换此选项而删除。";
    keyInput.disabled = true;
    keyInput.placeholder = "无需填写";
    keyField.style.opacity = "0.62";
  } else {
    $("#apiKeyLabel").innerHTML = "API Key <em>保存后留空即可保留原密钥</em>";
    $("#keyHint").textContent = protocol === "anthropic_messages"
      ? "会以 x-api-key 发送；保存后留空即可保留原密钥。"
      : "会以 Authorization: Bearer 发送；保存后留空即可保留原密钥。";
    keyInput.disabled = false;
    keyInput.placeholder = "sk-…";
    keyField.style.opacity = "1";
  }
}

function currentFormProfile() {
  const key = $("#profileApiKey").value.trim();
  const profile = {
    id: $("#profileId").value || newId(),
    name: $("#profileName").value.trim(),
    protocol: $("#profileProtocol").value,
    authMode: $("#profileAuthMode").value,
    endpoint: $("#profileEndpoint").value.trim(),
    model: $("#profileModel").value.trim(),
    timeoutMs: Number($("#profileTimeout").value),
    maxOutputTokens: Number($("#profileMaxTokens").value),
    enabled: $("#profileEnabled").checked,
  };
  if (key && profile.authMode !== "none") profile.apiKey = key;
  return profile;
}

function validateProfile(profile, { requireKey = false } = {}) {
  if (!profile.name) return "请填写配置名称。";
  if (!profile.model) return "请填写模型 ID。";
  try {
    const endpoint = new URL(profile.endpoint);
    if (!/^https?:$/.test(endpoint.protocol)) return "Endpoint 只能使用 HTTP 或 HTTPS。";
  } catch {
    return "请填写有效的完整 Endpoint URL。";
  }
  if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 300000) return "超时应在 1000 到 300000 毫秒之间。";
  if (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 16 || profile.maxOutputTokens > 8192) return "最大输出 Token 应在 16 到 8192 之间。";
  if (requireKey && profile.authMode !== "none" && !profile.apiKey && !profileHasKey(state.profiles.find((item) => item.id === profile.id))) return "测试连接前请填写 API Key。";
  return null;
}

async function saveCurrentProfile(event) {
  event.preventDefault();
  const profile = currentFormProfile();
  const validationError = validateProfile(profile);
  if (validationError) return setStatus(validationError, "error");
  if ($("#profileDefault").checked && !profile.enabled) {
    return setStatus("默认模型必须处于启用状态。", "error");
  }
  const button = $("#saveProfileButton");
  setButtonBusy(button, true, "正在保存…");
  try {
    const permitted = await requestOriginPermission(profile.endpoint);
    if (!permitted) {
      throw new Error("未获得该模型 Endpoint 的访问权限。请允许浏览器弹出的站点权限请求后重试。");
    }
    const saved = await saveProfile(profile);
    const actual = saved?.profile || saved || profile;
    const index = state.profiles.findIndex((item) => item.id === actual.id);
    if (index === -1) state.profiles.push(actual);
    else state.profiles[index] = { ...state.profiles[index], ...actual };
    state.editingId = actual.id;
    if ($("#profileDefault").checked || !state.defaultProfileId) {
      await setDefaultProfile(actual.id);
      state.defaultProfileId = actual.id;
    }
    setStatus("配置已保存。", "success");
    renderProfileList();
    showToast("模型配置已保存。");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
    showToast(`保存失败：${error.message}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function testCurrentProfile() {
  const profile = currentFormProfile();
  const validationError = validateProfile(profile, { requireKey: true });
  if (validationError) return setStatus(validationError, "error");
  const button = $("#testProfileButton");
  setButtonBusy(button, true, "正在测试…");
  setStatus("正在向模型服务发送最小测试请求…");
  try {
    const permitted = await requestOriginPermission(profile.endpoint);
    if (!permitted) {
      throw new Error("未获得该模型 Endpoint 的访问权限。请允许浏览器弹出的站点权限请求后重试。");
    }
    const response = await sendMessage("TEST_MODEL_CONNECTION", {
      profile,
      profileId: state.editingId || profile.id,
    });
    const result = response?.result || response;
    if (result?.ok === false) {
      throw new Error(result?.error?.message || "模型服务拒绝了连接测试。");
    }
    const latency = Number(result?.latencyMs ?? result?.latency_ms);
    const model = result?.model || response?.profile?.model || profile.model;
    setStatus(`连接成功 · ${model}${Number.isFinite(latency) ? ` · ${latency} ms` : ""}`, "success");
    showToast("模型连接测试成功。");
  } catch (error) {
    setStatus(`连接失败：${error.message}`, "error");
    showToast(`连接失败：${error.message}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function makeDefaultProfile(id) {
  try {
    await setDefaultProfile(id);
    state.defaultProfileId = id;
    $("#profileDefault").checked = id === state.editingId;
    renderProfileList();
    showToast("已设为默认模型。");
  } catch (error) {
    showToast(`无法设置默认模型：${error.message}`, "error");
  }
}

async function removeProfile(profile) {
  if (!window.confirm(`确定删除“${profile.name || profile.model}”吗？此操作会移除本地保存的配置和密钥。`)) return;
  try {
    const updatedSettings = await deleteProfile(profile.id);
    state.profiles = state.profiles.filter((item) => item.id !== profile.id);
    state.defaultProfileId = profileId(updatedSettings?.defaultProfileId)
      || state.profiles.find((item) => item.enabled !== false)?.id
      || null;
    const wasEditing = state.editingId === profile.id;
    if (wasEditing) setFormForNewProfile();
    else renderProfileList();
    showToast("模型配置已删除。");
  } catch (error) {
    showToast(`删除失败：${error.message}`, "error");
  }
}

function displayOrigin(originPattern) {
  return String(originPattern || "").replace(/\/\*$/, "");
}

function setGrantStatus(message, variant = "") {
  const status = $("#originGrantStatus");
  status.textContent = message;
  status.className = `origin-grant-status${variant ? ` is-${variant}` : ""}`;
}

async function renderOriginList() {
  const list = $("#originList");
  list.replaceChildren();
  let origins;
  try {
    origins = await listGrantedOrigins();
  } catch (error) {
    const failure = document.createElement("p");
    failure.className = "origin-list-message is-error";
    failure.textContent = `无法读取授权列表：${error.message}`;
    list.append(failure);
    return;
  }
  if (!origins.length) {
    const empty = document.createElement("p");
    empty.className = "origin-list-message";
    empty.textContent = "尚无已授权站点。在上方输入网址并点击“添加授权”。";
    list.append(empty);
    return;
  }
  origins.forEach((origin) => {
    const item = document.createElement("div");
    item.className = `origin-item${isRequiredOriginPattern(origin) ? " is-required" : ""}`;
    const label = document.createElement("code");
    label.textContent = displayOrigin(origin);
    const actions = document.createElement("span");
    actions.className = "origin-item-actions";
    if (isRequiredOriginPattern(origin)) {
      const tag = document.createElement("span");
      tag.className = "origin-tag";
      tag.textContent = "内置";
      actions.append(tag);
    } else {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", () => removeOrigin(origin));
      actions.append(remove);
    }
    item.append(label, actions);
    list.append(item);
  });
}

async function grantOrigin(event) {
  event.preventDefault();
  const input = $("#originGrantInput");
  const raw = input.value.trim();
  if (!raw) {
    setGrantStatus("请输入要授权的网址。", "error");
    return;
  }
  let origin;
  try {
    origin = originPermissionPattern(raw);
  } catch {
    setGrantStatus("网址无效：请填写完整的 http(s) 地址，例如 https://example.com。", "error");
    return;
  }
  const button = $("#originGrantButton");
  setButtonBusy(button, true, "正在授权…");
  try {
    // permissions.request() must stay the first asynchronous extension call in
    // this submit handler so Chrome can tie the prompt to the user gesture.
    const granted = await requestOriginPermission(raw);
    if (!granted) {
      setGrantStatus("未完成授权：请在浏览器弹窗中点击“允许”。", "error");
      return;
    }
    setGrantStatus(`已授权 ${displayOrigin(origin)}。`, "success");
    input.value = "";
    await renderOriginList();
  } catch (error) {
    setGrantStatus(`授权失败：${error.message}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function removeOrigin(origin) {
  try {
    const removed = await removeOriginPermission(origin);
    if (!removed) {
      showToast("该权限为扩展内置权限，无法移除。", "error");
      return;
    }
    setGrantStatus(`已移除 ${displayOrigin(origin)} 的授权。`);
    showToast(`已移除 ${displayOrigin(origin)} 的授权。`);
    await renderOriginList();
  } catch (error) {
    showToast(`移除失败：${error.message}`, "error");
  }
}

function maybeUpdateEndpointForProtocolChange() {
  const endpoint = $("#profileEndpoint");
  const newDefault = DEFAULT_ENDPOINTS[$("#profileProtocol").value];
  if (!endpoint.value || Object.values(DEFAULT_ENDPOINTS).includes(endpoint.value)) endpoint.value = newDefault;
  updateProtocolHelp();
  markModelCatalogStale();
}

function bindEvents() {
  $("#newProfileButton").addEventListener("click", setFormForNewProfile);
  $("#profileForm").addEventListener("submit", saveCurrentProfile);
  $("#originGrantForm").addEventListener("submit", grantOrigin);
  $("#testProfileButton").addEventListener("click", testCurrentProfile);
  $("#refreshModelsButton").addEventListener("click", refreshModelCatalog);
  $("#profileProtocol").addEventListener("change", maybeUpdateEndpointForProtocolChange);
  $("#profileAuthMode").addEventListener("change", () => {
    updateProtocolHelp();
    markModelCatalogStale();
  });
  $("#profileEndpoint").addEventListener("input", markModelCatalogStale);
  $("#profileApiKey").addEventListener("input", markModelCatalogStale);
  $("#modelCatalogSearch").addEventListener("input", renderModelCatalog);
  $("#showAllModels").addEventListener("change", renderModelCatalog);
  $("#modelCatalog").addEventListener("change", () => {
    const model = $("#modelCatalog").value;
    if (!model) return;
    $("#profileModel").value = model;
    renderModelCatalog();
    setModelCatalogStatus(`已选择 ${model}；保存配置后生效。`, "success");
  });
  $("#profileModel").addEventListener("input", renderModelCatalog);
  $("#toggleKeyButton").addEventListener("click", () => {
    const input = $("#profileApiKey");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("#toggleKeyButton").textContent = visible ? "显示" : "隐藏";
    $("#toggleKeyButton").setAttribute("aria-label", visible ? "显示 API Key" : "隐藏 API Key");
  });
}

async function init() {
  bindEvents();
  try {
    const settings = await getPublicSettings();
    state.profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
    state.defaultProfileId = profileId(settings?.defaultProfileId);
    setFormForNewProfile();
    renderProfileList();
    await renderOriginList();
    state.unsubscribeSettings = subscribeToSettings((updatedSettings) => {
      applyStoredProfiles(updatedSettings);
    });
  } catch (error) {
    $("#profileCount").textContent = "读取配置失败";
    setStatus(`无法读取本地模型配置：${error.message}`, "error");
    showToast(`无法读取本地模型配置：${error.message}`, "error");
  }
}

window.addEventListener("unload", () => state.unsubscribeSettings?.());

init();
