import {
  deleteProfile,
  getDefaultProfile,
  listProfiles,
  requestOriginPermission,
  saveProfile,
  setDefaultProfile,
} from "../src/shared/storage.js";

const DEFAULT_ENDPOINTS = {
  openai_chat_completions: "https://api.openai.com/v1/chat/completions",
  anthropic_messages: "https://api.anthropic.com/v1/messages",
};

const state = {
  profiles: [],
  defaultProfileId: null,
  editingId: null,
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
  const existing = state.profiles.find((profile) => profile.id === state.editingId);
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
  if (key) profile.apiKey = key;
  else if (existing?.apiKey) profile.apiKey = existing.apiKey;
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
    const response = await sendMessage("TEST_MODEL_CONNECTION", { profile });
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

function maybeUpdateEndpointForProtocolChange() {
  const endpoint = $("#profileEndpoint");
  const newDefault = DEFAULT_ENDPOINTS[$("#profileProtocol").value];
  if (!endpoint.value || Object.values(DEFAULT_ENDPOINTS).includes(endpoint.value)) endpoint.value = newDefault;
  updateProtocolHelp();
}

function bindEvents() {
  $("#newProfileButton").addEventListener("click", setFormForNewProfile);
  $("#profileForm").addEventListener("submit", saveCurrentProfile);
  $("#testProfileButton").addEventListener("click", testCurrentProfile);
  $("#profileProtocol").addEventListener("change", maybeUpdateEndpointForProtocolChange);
  $("#profileAuthMode").addEventListener("change", updateProtocolHelp);
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
    const [profiles, defaultProfile] = await Promise.all([listProfiles(), getDefaultProfile()]);
    state.profiles = Array.isArray(profiles) ? profiles : [];
    state.defaultProfileId = profileId(defaultProfile);
    setFormForNewProfile();
    renderProfileList();
  } catch (error) {
    $("#profileCount").textContent = "读取配置失败";
    setStatus(`无法读取本地模型配置：${error.message}`, "error");
    showToast(`无法读取本地模型配置：${error.message}`, "error");
  }
}

init();
