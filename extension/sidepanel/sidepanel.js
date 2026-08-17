import {
  getPublicSettings,
  requestOriginPermission,
  requestOriginsPermission,
  saveSettings,
  subscribeToSettings,
} from "../src/shared/storage.js";

const EMPTY_OPTION_VALUE = "";
const DEFAULT_BENCHMARK_URL = "http://127.0.0.1:8765/api/v1";
const state = {
  profiles: [],
  settings: {},
  defaultProfileId: null,
  extractedQuestion: null,
  extractedQuestions: [],
  extractedTabId: null,
  activePageTarget: null,
  solveResult: null,
  benchmarkResult: null,
  benchmarkPollTimer: null,
  unsubscribeSettings: null,
};

const $ = (selector) => document.querySelector(selector);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function profileId(value) {
  return typeof value === "string" ? value : value?.id || null;
}

function profileName(profile) {
  return profile?.name || profile?.model || "未命名模型";
}

function protocolLabel(protocol) {
  return protocol === "anthropic_messages" ? "Anthropic" : "OpenAI-compatible";
}

function formatMilliseconds(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${Math.round(number <= 1 ? number * 100 : number)}%`;
}

function answerLabel(answer, type) {
  if (answer === undefined || answer === null || answer === "") return "未作答";
  if (Array.isArray(answer)) return answer.map((item) => String(item).toUpperCase()).join(", ");
  if (type === "true_false" || typeof answer === "boolean") return answer === true || answer === "true" ? "正确" : "错误";
  return String(answer).toUpperCase();
}

function questionTypeLabel(type, short = false) {
  if (type === "true_false") return short ? "判断" : "判断题";
  if (type === "multiple_choice") return short ? "多选" : "多选题";
  if (type === "choice_unknown") return short ? "选择" : "选择题（类型待确认）";
  return short ? "单选" : "单选题";
}

function showToast(message, variant = "default") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", variant === "error");
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function setConnectionState(kind, text) {
  const node = $("#connectionState");
  node.classList.toggle("is-ready", kind === "ready");
  node.classList.toggle("is-error", kind === "error");
  node.querySelector(".connection-label").textContent = text;
}

function setButtonBusy(button, busy, busyText) {
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent.trim();
  button.disabled = busy;
  if (busy) button.textContent = busyText;
  else button.textContent = button.dataset.originalText;
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("Chrome 扩展运行环境不可用。"));
      return;
    }
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response) {
        reject(new Error("后台服务没有返回响应。"));
        return;
      }
      if (response.ok === false) {
        reject(new Error(response.error?.message || response.error || "后台服务请求失败。"));
        return;
      }
      resolve(response.data ?? response);
    });
  });
}

function setActivePageTarget(tab) {
  try {
    const url = new URL(tab?.url || "");
    if (!tab?.id || !['http:', 'https:'].includes(url.protocol)) {
      state.activePageTarget = null;
      return null;
    }
    state.activePageTarget = {
      tabId: tab.id,
      url: url.href,
      origin: url.origin,
    };
    return state.activePageTarget;
  } catch {
    state.activePageTarget = null;
    return null;
  }
}

async function refreshActivePageTarget() {
  if (!globalThis.chrome?.tabs?.query) return null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return setActivePageTarget(tab);
}

function trackActivePageTarget() {
  if (!globalThis.chrome?.tabs) return;
  chrome.tabs.onActivated?.addListener(() => {
    refreshActivePageTarget().catch(() => undefined);
  });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo, tab) => {
    if (tab?.active && changeInfo.url) setActivePageTarget(tab);
  });
  window.addEventListener("focus", () => {
    refreshActivePageTarget().catch(() => undefined);
  });
}

async function requestCurrentPagePermission() {
  const target = state.activePageTarget;
  if (!target) {
    throw new Error("未识别到可读取的网页标签。请切换到问卷页面，等待片刻后再点击提取。");
  }
  // requestOriginPermission() must be the first asynchronous extension API
  // called from this button flow, so Chrome can associate it with the click.
  const granted = await requestOriginPermission(target.url);
  if (!granted) {
    throw new Error(`未获得 ${target.origin} 的读取权限。请在浏览器弹窗中允许后重试。`);
  }
  return target;
}

function activateTab(tab) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.dataset.panel === tab;
    panel.classList.toggle("is-hidden", !active);
    panel.hidden = !active;
  });
}

function populateProfileSelect(select, { optional = false, selectedId } = {}) {
  const currentId = selectedId ?? select.value;
  select.replaceChildren();
  if (optional) {
    const option = document.createElement("option");
    option.value = EMPTY_OPTION_VALUE;
    option.textContent = "不使用";
    select.append(option);
  }
  const enabledProfiles = state.profiles.filter((profile) => profile.enabled !== false);
  if (!enabledProfiles.length) {
    const option = document.createElement("option");
    option.value = EMPTY_OPTION_VALUE;
    option.textContent = state.profiles.length ? "没有已启用的模型" : "请先添加模型配置";
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  enabledProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profileName(profile)} · ${protocolLabel(profile.protocol)}`;
    select.append(option);
  });
  const availableIds = [...select.options].map((option) => option.value);
  const fallback = optional ? EMPTY_OPTION_VALUE : state.defaultProfileId || state.profiles[0]?.id || EMPTY_OPTION_VALUE;
  select.value = availableIds.includes(currentId) ? currentId : fallback;
}

function selectedProfileValues() {
  return {
    assistant: $("#assistantProfileSelect")?.value,
    benchmark: $("#benchmarkProfileSelect")?.value,
    fast: $("#fastProfileSelect")?.value,
    primary: $("#primaryProfileSelect")?.value,
    verifier: $("#verifierProfileSelect")?.value,
    fallback: $("#fallbackProfileSelect")?.value,
  };
}

function renderProfileSelects(selected = {}) {
  const routing = state.settings.routing || state.settings;
  populateProfileSelect($("#assistantProfileSelect"), { selectedId: selected.assistant ?? (routing.primaryProfileId || state.defaultProfileId) });
  populateProfileSelect($("#benchmarkProfileSelect"), { selectedId: selected.benchmark ?? (routing.primaryProfileId || state.defaultProfileId) });
  populateProfileSelect($("#fastProfileSelect"), { optional: true, selectedId: selected.fast ?? routing.fastProfileId });
  populateProfileSelect($("#primaryProfileSelect"), { selectedId: selected.primary ?? (routing.primaryProfileId || state.defaultProfileId) });
  populateProfileSelect($("#verifierProfileSelect"), { optional: true, selectedId: selected.verifier ?? routing.verifierProfileId });
  populateProfileSelect($("#fallbackProfileSelect"), { optional: true, selectedId: selected.fallback ?? routing.fallbackProfileId });
  $("#profileSummary").textContent = state.profiles.length
    ? `已配置 ${state.profiles.length} 个模型${state.defaultProfileId ? "，已选择默认模型" : ""}`
    : "尚未配置模型";
}

function overlayFormSnapshot(overlay) {
  // Only fields rendered in the settings form. Overlay writes that merely
  // persist collapsed/position (e.g. clicking the dot) must not re-render
  // the form, or in-progress slider edits get stomped.
  return JSON.stringify([
    overlay.enabled === true,
    overlay.stealth === true,
    overlay.stealthOpacity,
    overlay.opacity,
    overlay.clickThrough === true,
  ]);
}

function applyStoredSettings(settings, { preserveSelections = true } = {}) {
  const selected = preserveSelections ? selectedProfileValues() : {};
  const previousOverlayForm = overlayFormSnapshot(normalizedOverlaySettings());
  state.settings = settings || {};
  state.profiles = asArray(settings?.profiles);
  state.defaultProfileId = profileId(settings?.defaultProfileId)
    || state.profiles.find((profile) => profile.enabled !== false)?.id
    || null;
  renderProfileSelects(selected);
  if (overlayFormSnapshot(normalizedOverlaySettings()) !== previousOverlayForm) {
    applyOverlaySettingsToForm();
  }
  setConnectionState(state.profiles.length ? "ready" : "error", state.profiles.length ? "模型已就绪" : "未配置模型");
}

function normalizedOverlaySettings() {
  const overlay = state.settings.overlay || {};
  return {
    enabled: overlay.enabled === true,
    stealth: overlay.stealth === true,
    stealthOpacity: Math.min(Math.max(Number(overlay.stealthOpacity) || 0.08, 0.01), 0.3),
    opacity: Math.min(Math.max(Number(overlay.opacity) || 0.68, 0.3), 1),
    clickThrough: overlay.clickThrough === true,
    collapsed: overlay.collapsed !== false,
    position: {
      right: Number(overlay.position?.right) || 18,
      bottom: Number(overlay.position?.bottom) || 18,
    },
  };
}

function applyOverlaySettingsToForm() {
  const overlay = normalizedOverlaySettings();
  $("#overlayEnabled").checked = overlay.enabled;
  $("#overlayOpacity").value = String(Math.round(overlay.opacity * 100));
  $("#overlayClickThrough").checked = overlay.clickThrough;
  $("#overlayStealth").checked = overlay.stealth;
  $("#overlayStealthOpacity").value = String(Math.round(overlay.stealthOpacity * 100));
  $("#overlayOpacityValue").value = `${Math.round(overlay.opacity * 100)}%`;
  $("#overlayStealthOpacityValue").value = `${Math.round(overlay.stealthOpacity * 100)}%`;
}

function applySettingsToForm() {
  const routing = state.settings.routing || state.settings;
  const rag = state.settings.rag || {};
  const collector = state.settings.collector || {};
  $("#routingMode").value = routing.mode || routing.routingMode || "balanced";
  $("#benchmarkApiUrl").value = state.settings.benchmarkApiBaseUrl || state.settings.benchmarkApiUrl || DEFAULT_BENCHMARK_URL;
  $("#ragEnabled").checked = rag.enabled === true;
  $("#benchmarkUseRag").checked = rag.enabled === true;
  $("#ragEndpoint").value = rag.endpoint || "http://127.0.0.1:8787/retrieve";
  $("#ragCollection").value = rag.collection || "";
  $("#ragTopK").value = String(rag.topK || 3);
  $("#collectorEnabled").checked = collector.enabled === true;
  $("#collectorEndpoint").value = collector.endpoint || "http://127.0.0.1:8790/api/v1/extractions";
  $("#collectorUserId").value = collector.userId || "";
  $("#collectorKey").value = collector.key || "";
  applyOverlaySettingsToForm();
}

function overlaySettingsFromForm() {
  const previous = normalizedOverlaySettings();
  return {
    ...previous,
    enabled: $("#overlayEnabled").checked,
    stealth: $("#overlayStealth").checked,
    stealthOpacity: Math.min(Math.max(Number($("#overlayStealthOpacity").value) / 100, 0.01), 0.3),
    opacity: Math.min(Math.max(Number($("#overlayOpacity").value) / 100, 0.3), 1),
    clickThrough: $("#overlayClickThrough").checked,
  };
}

function setOverlayStatus(message, variant = "") {
  const node = $("#overlayStatus");
  node.textContent = message;
  node.className = `settings-help overlay-status${variant ? ` is-${variant}` : ""}`;
}

async function applyOverlayToCurrentPage() {
  const overlay = overlaySettingsFromForm();
  const button = $("#overlayApplyButton");
  setButtonBusy(button, true, overlay.enabled ? "正在挂载…" : "正在关闭…");
  try {
    let target = state.activePageTarget;
    if (overlay.enabled) {
      if (!target) {
        throw new Error("未识别到可注入的普通网页。请切换到目标网页后重试。");
      }
      // Permission request must remain the first asynchronous extension call
      // in this user-gesture flow.
      const granted = await requestOriginPermission(target.url);
      if (!granted) {
        throw new Error(`未获得 ${target.origin} 的页面权限。`);
      }
    }
    const saved = await saveSettings({ overlay });
    state.settings = { ...state.settings, ...saved, overlay: saved.overlay };
    if (!overlay.enabled) target = null;
    const result = await sendMessage("APPLY_LOW_INTERFERENCE_OVERLAY", {
      ...(target ? { tabId: target.tabId, expectedOrigin: target.origin } : {}),
    });
    setOverlayStatus(
      result?.visible
        ? overlay.stealth
          ? "低调模式已开启。浮窗自动隐藏，鼠标靠近或 Alt / ⌥ + Shift + X 唤醒。"
          : "浮窗已显示。展开后点“收起”可恢复小白点，悬停不会改变透明度。"
        : "低干扰浮窗模式已关闭。",
      "success",
    );
  } catch (error) {
    const persisted = normalizedOverlaySettings();
    $("#overlayEnabled").checked = persisted.enabled;
    setOverlayStatus(error?.message || "无法更新浮窗。", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function setCollectorStatus(message, variant = "") {
  const node = $("#collectorStatus");
  node.textContent = message;
  node.className = `settings-help${variant ? ` is-${variant}` : ""}`;
}

async function testCollectorConnection() {
  const button = $("#collectorTestButton");
  const endpoint = $("#collectorEndpoint").value.trim() || "http://127.0.0.1:8790/api/v1/extractions";
  if (!/^https?:\/\//i.test(endpoint)) {
    setCollectorStatus("采集服务 Endpoint 必须以 http(s):// 开头。", "error");
    return;
  }
  setButtonBusy(button, true, "测试中…");
  setCollectorStatus(`正在连接 ${new URL(endpoint).origin} …`);
  try {
    // Test against the form values, without persisting them first.
    const result = await sendMessage("GET_COLLECTOR_HEALTH", {
      endpoint,
      userId: $("#collectorUserId").value.trim(),
      key: $("#collectorKey").value.trim(),
    });
    const userNote = result?.user ? ` · 用户 ${result.user}` : "";
    setCollectorStatus(
      `连接成功 · ${result?.latencyMs ?? "?"} ms${result?.service ? ` · ${result.service}` : ""}${userNote}。`,
      "success",
    );
  } catch (error) {
    setCollectorStatus(`连接失败：${error?.message || "未知错误"}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function normalizeQuestion(data) {
  const question = data?.question || data?.extractedQuestion || data;
  if (!question?.stem) throw new Error("没有从当前页面识别到有效题干。");
  const rawOptions = question.options || [];
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((item, index) => ({ key: item.key || item.label || String.fromCharCode(65 + index), text: item.text ?? item.value ?? String(item) }))
    : Object.entries(rawOptions).map(([key, text]) => ({ key, text }));
  return { ...question, options };
}

function resetSolveResult() {
  state.solveResult = null;
  $("#fillAnswerButton").disabled = true;
  $("#solveResultCard").classList.add("is-empty");
  $("#answerRoute").textContent = "等待作答";
  const solveRoot = $("#solveResult");
  solveRoot.className = "answer-result empty-state";
  solveRoot.replaceChildren();
  const emptyHint = document.createElement("p");
  emptyHint.textContent = "请先解答当前选中的题目。";
  solveRoot.append(emptyHint);
}

function questionPickerText(question, index) {
  const type = questionTypeLabel(question.type, true);
  const stem = String(question.stem || "").replace(/\s+/g, " ").trim();
  const preview = stem.length > 46 ? `${stem.slice(0, 46)}…` : stem;
  return `第 ${index + 1} 题 · ${type} · ${preview || "未识别题干"}`;
}

function renderQuestionPicker(selectedId = state.extractedQuestion?.id) {
  const field = $("#questionPickerField");
  const select = $("#questionSelect");
  const label = $("#questionPickerLabel");
  select.replaceChildren();
  const questions = state.extractedQuestions;
  if (!questions.length) {
    field.hidden = true;
    select.disabled = true;
    return;
  }
  questions.forEach((question, index) => {
    const option = document.createElement("option");
    option.value = question.id;
    option.textContent = questionPickerText(question, index);
    select.append(option);
  });
  field.hidden = false;
  select.disabled = questions.length < 2;
  label.textContent = `已识别 ${questions.length} 道题目，选择要解答的题`;
  select.value = questions.some((question) => question.id === selectedId)
    ? selectedId
    : questions[0].id;
}

function selectExtractedQuestion(questionId) {
  const question = state.extractedQuestions.find((item) => item.id === questionId);
  if (!question) {
    showToast("未找到所选题目，请重新提取页面题目。", "error");
    return;
  }
  state.extractedQuestion = question;
  resetSolveResult();
  renderQuestionPicker(question.id);
  renderQuestion(question);
}

function renderQuestion(question) {
  const preview = $("#questionPreview");
  preview.classList.remove("empty-state");
  preview.replaceChildren();
  const meta = document.createElement("div");
  meta.className = "question-meta";
  const type = document.createElement("span");
  type.className = "mini-badge";
  type.textContent = questionTypeLabel(question.type);
  if (question.sourceUrl) {
    const source = document.createElement("span");
    source.className = "mini-badge";
    source.textContent = "当前网页";
    meta.append(type, source);
  } else meta.append(type);
  const stem = document.createElement("p");
  stem.className = "question-stem";
  stem.textContent = question.stem;
  const options = document.createElement("ol");
  options.className = "question-options";
  question.options.forEach((option) => {
    const item = document.createElement("li");
    const key = document.createElement("b");
    key.textContent = `${option.key}.`;
    const content = document.createElement("span");
    content.textContent = option.text;
    item.append(key, content);
    options.append(item);
  });
  preview.append(meta, stem, options);
  $("#copyQuestionButton").disabled = false;
}

function renderSolveResult(result, question = state.extractedQuestion) {
  const card = $("#solveResultCard");
  const root = $("#solveResult");
  const route = result.route || result.provider || "模型作答";
  const answer = result.answer ?? result.parsedAnswer;
  const confidence = Number(result.confidence);
  const latency = result.latencyMs ?? result.latency_ms;

  card.classList.remove("is-empty");
  $("#answerRoute").textContent = route;
  $("#fillAnswerButton").disabled = !question?.id
    || answer === undefined
    || answer === null
    || answer === ""
    || (Array.isArray(answer) && !answer.length);
  root.className = "answer-result is-result";
  root.replaceChildren();

  const topline = document.createElement("div");
  topline.className = "answer-topline";
  const answerBlock = document.createElement("div");
  const answerValue = document.createElement("strong");
  answerValue.className = "answer-value";
  answerValue.textContent = answerLabel(answer, question?.type);
  const answerCaption = document.createElement("p");
  answerCaption.className = "answer-caption";
  answerCaption.textContent = `由 ${result.profileName || profileName(state.profiles.find((profile) => profile.id === (result.profileId || $("#assistantProfileSelect").value)))} 给出`;
  answerBlock.append(answerValue, answerCaption);

  const metrics = document.createElement("div");
  metrics.className = "metric-stack";
  const confidenceMetric = document.createElement("div");
  confidenceMetric.innerHTML = `<span>置信度</span><strong>${formatPercent(confidence)}</strong>`;
  const latencyMetric = document.createElement("div");
  latencyMetric.innerHTML = `<span>耗时</span><strong>${formatMilliseconds(latency)}</strong>`;
  metrics.append(confidenceMetric, latencyMetric);
  topline.append(answerBlock, metrics);
  root.append(topline);

  if (Number.isFinite(confidence)) {
    const track = document.createElement("div");
    track.className = "confidence-track";
    const bar = document.createElement("span");
    bar.style.width = `${Math.max(0, Math.min(100, confidence <= 1 ? confidence * 100 : confidence))}%`;
    track.append(bar);
    root.append(track);
  }
  if (result.explanation || result.reasoning) {
    const explanation = document.createElement("p");
    explanation.className = "explanation";
    explanation.textContent = result.explanation || result.reasoning;
    root.append(explanation);
  }
  const evidence = asArray(result.evidence || result.sources || result.context);
  if (evidence.length) {
    const list = document.createElement("ul");
    list.className = "evidence-list";
    evidence.slice(0, 3).forEach((item) => {
      const node = document.createElement("li");
      node.textContent = typeof item === "string" ? item : item.text || item.content || item.title || JSON.stringify(item);
      list.append(node);
    });
    root.append(list);
  }
}

function questionAsText(question) {
  if (!question) return "";
  return [
    question.stem,
    ...question.options.map((option) => `${option.key}. ${option.text}`),
  ].join("\n");
}

async function extractQuestion() {
  const button = $("#extractButton");
  setButtonBusy(button, true, "正在提取…");
  try {
    const target = await requestCurrentPagePermission();
    const response = await sendMessage("EXTRACT_CURRENT_QUESTION", {
      tabId: target.tabId,
      expectedOrigin: target.origin,
    });
    const allQuestions = asArray(response?.questions).map(normalizeQuestion);
    const currentQuestion = response?.question ? normalizeQuestion(response.question) : allQuestions[0];
    state.extractedQuestions = allQuestions.length ? allQuestions : (currentQuestion ? [currentQuestion] : []);
    if (!currentQuestion) throw new Error("当前页面没有可识别的题目。");
    state.extractedQuestion = state.extractedQuestions.find((question) => question.id === currentQuestion.id) || currentQuestion;
    state.extractedTabId = response?.tabId ?? null;
    resetSolveResult();
    renderQuestionPicker(state.extractedQuestion.id);
    renderQuestion(state.extractedQuestion);
    showToast(`已识别 ${state.extractedQuestions.length} 道题目。`);
    return state.extractedQuestion;
  } catch (error) {
    showToast(error.message, "error");
    throw error;
  } finally {
    setButtonBusy(button, false);
  }
}

async function solveQuestion() {
  const profileId = $("#assistantProfileSelect").value;
  if (!profileId) {
    showToast("请先在模型设置中添加并选择一个模型。", "error");
    activateTab("settings");
    return;
  }
  const button = $("#solveButton");
  setButtonBusy(button, true, "正在解答…");
  try {
    const question = state.extractedQuestion || await extractQuestion();
    const response = await sendMessage("SOLVE_CURRENT_QUESTION", {
      question,
      profileId,
      mode: $("#routingMode").value || "balanced",
    });
    state.solveResult = {
      ...(response?.result || response),
      evidence: response?.result?.evidence || response?.rag?.chunks || response?.evidence,
      profileId: response?.profile?.id || response?.result?.profileId || profileId,
      profileName: response?.profile?.name || response?.profile?.model || undefined,
      tabId: response?.tabId ?? state.extractedTabId,
    };
    state.extractedTabId = state.solveResult.tabId ?? state.extractedTabId;
    renderSolveResult(state.solveResult, question);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function setBenchmarkProgress(data = {}) {
  const status = data?.status && typeof data.status === "object" ? data.status : data;
  const card = $("#benchmarkProgressCard");
  const current = Number(status.current ?? status.completed ?? 0);
  const total = Number(status.total ?? status.count ?? 0);
  const fraction = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
  card.hidden = false;
  card.classList.remove("is-hidden");
  $("#benchmarkProgressTitle").textContent = status.title || (status.state === "scoring" ? "正在自动评分" : "正在运行模型测评");
  $("#benchmarkProgressText").textContent = total ? `${current} / ${total}` : "准备中";
  $("#benchmarkProgressBar").style.width = `${fraction}%`;
  $("#benchmarkProgressNote").textContent = status.note || "模型输出将被规范化后再提交自动评分。";
}

function resultSummary(data) {
  return data?.summary || data?.submission?.summary || data?.result?.summary || data?.score || data?.result || {};
}

function resultDetails(data) {
  return asArray(data?.details || data?.submission?.details || data?.result?.details || data?.questions || data?.items);
}

function renderBenchmarkResult(data) {
  const root = $("#benchmarkResult");
  const card = $("#benchmarkResultCard");
  const summary = resultSummary(data);
  const details = resultDetails(data);
  const total = summary.total ?? summary.question_count ?? summary.total_questions ?? details.length;
  const correct = summary.correct ?? summary.correct_count ?? summary.correct_answers;
  const accuracy = summary.accuracy ?? (Number.isFinite(Number(correct)) && total ? Number(correct) / total : null);
  const latency = summary.total_latency_ms ?? summary.totalLatencyMs ?? summary.wall_time_ms;
  const p95 = summary.latency?.p95_ms ?? summary.p95_latency_ms ?? summary.p95Ms;
  card.classList.remove("is-empty");
  root.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "result-metric-grid";
  const metrics = [
    ["准确率", formatPercent(accuracy)],
    ["答对", total ? `${correct ?? "—"} / ${total}` : "—"],
    ["总耗时", formatMilliseconds(latency)],
    ["单题 P95", formatMilliseconds(p95)],
  ];
  metrics.forEach(([label, value]) => {
    const metric = document.createElement("div");
    metric.className = "result-metric";
    const name = document.createElement("span");
    name.textContent = label;
    const score = document.createElement("strong");
    score.textContent = value;
    metric.append(name, score);
    grid.append(metric);
  });
  root.append(grid);
  const wrong = details.filter((detail) => detail.is_correct === false || detail.correct === false);
  const sample = wrong.length ? wrong.slice(0, 3) : details.slice(0, 3);
  if (sample.length) {
    const list = document.createElement("div");
    list.className = "benchmark-detail-list";
    sample.forEach((detail, index) => {
      const item = document.createElement("div");
      const isWrong = detail.is_correct === false || detail.correct === false;
      item.className = `benchmark-detail${isWrong ? " is-wrong" : ""}`;
      const label = document.createElement("span");
      label.textContent = detail.id || detail.question_id || `题目 ${detail.index ?? index + 1}`;
      const status = document.createElement("strong");
      status.textContent = isWrong
        ? `答 ${answerLabel(detail.submitted_answer ?? detail.answer, detail.type)} · 标准 ${answerLabel(detail.correct_answer, detail.type)}`
        : "回答正确";
      item.append(label, status);
      list.append(item);
    });
    root.append(list);
  }
  $("#copyBenchmarkButton").disabled = false;
}

function isBenchmarkComplete(data) {
  return Boolean(
    data?.summary
    || data?.submission?.summary
    || data?.result?.summary
    || data?.state === "completed"
    || data?.state === "complete"
    || data?.status === "completed"
    || data?.status === "complete"
    || data?.status?.state === "completed"
    || data?.status?.state === "complete"
  );
}

async function pollBenchmark(runId) {
  window.clearInterval(state.benchmarkPollTimer);
  state.benchmarkPollTimer = window.setInterval(async () => {
    try {
      const data = await sendMessage("GET_BENCHMARK_STATUS", { runId });
      setBenchmarkProgress(data);
      if (isBenchmarkComplete(data)) {
        window.clearInterval(state.benchmarkPollTimer);
        state.benchmarkResult = data;
        renderBenchmarkResult(data);
        $("#benchmarkRunButton").disabled = false;
        showToast("Benchmark 测试已完成。");
      }
    } catch (error) {
      window.clearInterval(state.benchmarkPollTimer);
      $("#benchmarkRunButton").disabled = false;
      showToast(`读取测试状态失败：${error.message}`, "error");
    }
  }, 800);
}

async function runBenchmark(event) {
  event.preventDefault();
  const types = [
    $("#benchmarkSingleChoice").checked ? "single_choice" : null,
    $("#benchmarkTrueFalse").checked ? "true_false" : null,
  ].filter(Boolean);
  const count = Number($("#benchmarkCount").value);
  const profileId = $("#benchmarkProfileSelect").value;
  if (!profileId) return showToast("请先选择一个测试模型。", "error");
  if (!types.length) return showToast("请至少选择一种题型。", "error");
  if (!Number.isInteger(count) || count < 1 || count > 200) return showToast("题目数量必须是 1 到 200 的整数。", "error");

  const button = $("#benchmarkRunButton");
  setButtonBusy(button, true, "测试运行中…");
  setBenchmarkProgress({ total: count, note: "正在创建固定测试集…" });
  try {
    const seedInput = $("#benchmarkSeed").value.trim();
    const data = await sendMessage("RUN_BENCHMARK", {
      profileId,
      types,
      count,
      seed: seedInput ? Number(seedInput) : undefined,
      label: $("#benchmarkLabel").value.trim() || undefined,
      baseUrl: $("#benchmarkApiUrl").value.trim() || DEFAULT_BENCHMARK_URL,
      useRag: $("#benchmarkUseRag").checked,
    });
    setBenchmarkProgress(data);
    if (isBenchmarkComplete(data)) {
      state.benchmarkResult = data;
      renderBenchmarkResult(data);
      showToast("Benchmark 测试已完成。");
      setButtonBusy(button, false);
      return;
    }
    const runId = data.runId || data.id || data.run_id;
    if (!runId) throw new Error("后台服务未返回测试结果或运行 ID。");
    await pollBenchmark(runId);
  } catch (error) {
    setButtonBusy(button, false);
    showToast(error.message, "error");
  }
}

async function saveRouting(event) {
  event.preventDefault();
  const ragEnabled = $("#ragEnabled").checked;
  const ragEndpoint = $("#ragEndpoint").value.trim() || "http://127.0.0.1:8787/retrieve";
  if (ragEnabled) {
    try {
      const url = new URL(ragEndpoint);
      if (!/^https?:$/.test(url.protocol)) throw new Error("invalid protocol");
    } catch {
      showToast("启用 RAG 时，请填写有效的 HTTP(S) 检索 Endpoint。", "error");
      return;
    }
  }
  const routing = {
    mode: $("#routingMode").value,
    fastProfileId: $("#fastProfileSelect").value || null,
    primaryProfileId: $("#primaryProfileSelect").value || null,
    verifierProfileId: $("#verifierProfileSelect").value || null,
    fallbackProfileId: $("#fallbackProfileSelect").value || null,
  };
  const collectorEndpoint = $("#collectorEndpoint").value.trim();
  if (collectorEndpoint && !/^https?:\/\//i.test(collectorEndpoint)) {
    showToast("题库采集 Endpoint 必须以 http(s):// 开头。", "error");
    return;
  }
  const patch = {
    routing,
    benchmarkApiBaseUrl: $("#benchmarkApiUrl").value.trim() || DEFAULT_BENCHMARK_URL,
    rag: {
      enabled: ragEnabled,
      endpoint: ragEndpoint,
      collection: $("#ragCollection").value.trim(),
      topK: Number($("#ragTopK").value) || 3,
    },
    collector: {
      enabled: $("#collectorEnabled").checked,
      endpoint: collectorEndpoint || "http://127.0.0.1:8790/api/v1/extractions",
      userId: $("#collectorUserId").value.trim(),
      key: $("#collectorKey").value.trim(),
    },
    // The overlay fieldset lives in this same form; persist what it shows so
    // the post-save refresh does not revert unsaved overlay edits.
    overlay: overlaySettingsFromForm(),
  };
  const button = event.currentTarget.querySelector("button[type=submit]");
  setButtonBusy(button, true, "正在保存…");
  try {
    // Ask for every required origin in one call. A second request after an
    // awaited permission dialog would no longer be associated with this submit.
    const endpoints = [
      patch.benchmarkApiBaseUrl,
      ...(patch.rag.enabled ? [patch.rag.endpoint] : []),
    ];
    const granted = await requestOriginsPermission(endpoints);
    if (!granted) {
      throw new Error("未获得 Benchmark 或 RAG 服务的访问权限。请允许浏览器弹出的站点权限请求后重试。");
    }
    await saveSettings(patch);
    state.settings = {
      ...state.settings,
      ...patch,
      routing: { ...(state.settings.routing || {}), ...patch.routing },
      rag: { ...(state.settings.rag || {}), ...patch.rag },
    };
    showToast("答题设置已保存。");
  } catch (error) {
    showToast(`保存失败：${error.message}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    showToast("复制失败，请检查浏览器剪贴板权限。", "error");
  }
}

async function fillAnswerOnPage() {
  const answer = state.solveResult?.answer ?? state.solveResult?.parsedAnswer;
  const questionId = state.extractedQuestion?.id;
  if (!questionId || answer === undefined || answer === null || answer === "") {
    showToast("请先成功解答当前网页中的题目。", "error");
    return;
  }
  const button = $("#fillAnswerButton");
  setButtonBusy(button, true, "正在填入…");
  try {
    const tabId = state.solveResult?.tabId ?? state.extractedTabId;
    const result = await sendMessage("FILL_ANSWER", {
      questionId,
      answer,
      ...(tabId ? { tabId } : {}),
    });
    if (result?.submitted === true) throw new Error("安全保护：页面不应被自动提交。");
    showToast(result?.filled === false ? "未能确认选项状态，请检查当前页面。" : "答案已填入网页，尚未提交。", result?.filled === false ? "error" : "default");
  } catch (error) {
    showToast(`填入答案失败：${error.message}`, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  $("#extractButton").addEventListener("click", () => extractQuestion().catch(() => undefined));
  $("#questionSelect").addEventListener("change", (event) => selectExtractedQuestion(event.currentTarget.value));
  $("#solveButton").addEventListener("click", solveQuestion);
  $("#fillAnswerButton").addEventListener("click", fillAnswerOnPage);
  $("#copyQuestionButton").addEventListener("click", () => copyText(questionAsText(state.extractedQuestion), "题目已复制。"));
  $("#benchmarkForm").addEventListener("submit", runBenchmark);
  $("#copyBenchmarkButton").addEventListener("click", () => copyText(JSON.stringify(state.benchmarkResult, null, 2), "测试结果 JSON 已复制。"));
  $("#routingForm").addEventListener("submit", saveRouting);
  $("#overlayEnabled").addEventListener("change", applyOverlayToCurrentPage);
  $("#overlayClickThrough").addEventListener("change", () => {
    if ($("#overlayEnabled").checked) applyOverlayToCurrentPage();
  });
  $("#overlayOpacity").addEventListener("input", (event) => {
    $("#overlayOpacityValue").value = `${event.currentTarget.value}%`;
  });
  $("#overlayOpacity").addEventListener("change", () => {
    if ($("#overlayEnabled").checked) applyOverlayToCurrentPage();
  });
  $("#overlayApplyButton").addEventListener("click", applyOverlayToCurrentPage);
  $("#collectorTestButton").addEventListener("click", testCollectorConnection);
  $("#openOptionsButton").addEventListener("click", () => {
    if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
    else showToast("无法打开设置页面。", "error");
  });
}

async function init() {
  bindEvents();
  trackActivePageTarget();
  refreshActivePageTarget().catch(() => undefined);
  try {
    const settings = await getPublicSettings();
    state.settings = settings || {};
    state.profiles = asArray(settings?.profiles);
    state.defaultProfileId = profileId(settings?.defaultProfileId)
      || state.profiles.find((profile) => profile.enabled !== false)?.id
      || null;
    applySettingsToForm();
    renderProfileSelects();
    setConnectionState(state.profiles.length ? "ready" : "error", state.profiles.length ? "模型已就绪" : "未配置模型");
    state.unsubscribeSettings = subscribeToSettings((updatedSettings) => {
      applyStoredSettings(updatedSettings, { preserveSelections: true });
    });
  } catch (error) {
    setConnectionState("error", "加载失败");
    showToast(`无法读取插件设置：${error.message}`, "error");
  }
}

window.addEventListener("unload", () => state.unsubscribeSettings?.());

init();
