/* CyberWikiBench collector UI — vanilla JS, mobile-first, same-origin API. */
(() => {
  "use strict";

  const PAGE_SIZE = 20;
  const QUESTIONS_PER_PAGE = 20;
  const AUTH_STORAGE_KEY = "cwkb_collector_auth";
  const state = {
    tab: "bank",
    offset: 0,
    total: 0,
    items: [],
    extraction: null,
    auth: null,
    page: 1,
    stopSolving: false,
    solvingAll: false,
    deleteArmed: false,
    deleteTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);

  function loadAuth() {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
      if (raw && raw.userId && raw.key) return raw;
    } catch {
      /* corrupted entry falls through to login */
    }
    return null;
  }

  async function api(path, init = {}) {
    const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
    if (state.auth) {
      headers["X-User-Id"] = state.auth.userId;
      headers["X-Api-Key"] = state.auth.key;
    }
    const response = await fetch(path, { ...init, headers });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）。`);
    }
    return payload;
  }

  function showToast(message, variant = "default") {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("is-error", variant === "error");
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.label;
  }

  const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url || "未知来源";
    }
  }

  function answerText(answer) {
    if (Array.isArray(answer)) return answer.join(", ").toUpperCase();
    if (answer === true || answer === "true") return "正确";
    if (answer === false || answer === "false") return "错误";
    if (answer === undefined || answer === null || answer === "") return "未解";
    return String(answer).toUpperCase();
  }

  // ── bank list ────────────────────────────────────────────

  async function loadStats() {
    try {
      const stats = await api("/api/v1/stats");
      $("#statsRow").innerHTML = `
        <div class="stat"><strong>${stats.extractions}</strong><span>次提取</span></div>
        <div class="stat"><strong>${stats.questions}</strong><span>道题目</span></div>
        <div class="stat"><strong>${stats.solved}</strong><span>已解答</span></div>`;
    } catch {
      $("#statsRow").replaceChildren();
    }
  }

  function renderList() {
    const list = $("#extractionList");
    list.replaceChildren();
    if (!state.items.length) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.innerHTML = "<strong>还没有采集记录</strong>在插件里开启「题库采集」，到题目页面按 Alt / ⌥ + Shift + C 即可一键入库。";
      list.append(note);
    } else {
      state.items.forEach((item) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "extraction-card";
        card.innerHTML = `
          <span class="source">${escapeHtml(item.source?.title || hostOf(item.source?.url))}</span>
          <span class="host">${escapeHtml(formatTime(item.savedAt))} · ${escapeHtml(hostOf(item.source?.url))}</span>
          <span class="meta-row">
            <span class="chip">${item.questionCount} 题</span>
            <span class="chip ${item.solvedCount ? "is-solved" : ""}">已解 ${item.solvedCount}/${item.questionCount}</span>
          </span>`;
        card.addEventListener("click", () => openDetail(item.id));
        list.append(card);
      });
    }
    const more = $("#loadMoreButton");
    more.hidden = state.offset + state.items.length >= state.total;
  }

  async function loadList({ append = false } = {}) {
    if (!append) {
      state.offset = 0;
      state.items = [];
    }
    try {
      const data = await api(`/api/v1/extractions?limit=${PAGE_SIZE}&offset=${state.offset}`);
      state.total = data.total;
      state.items = append ? state.items.concat(data.items) : data.items;
      renderList();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function refreshAll() {
    await Promise.all([loadStats(), loadList()]);
  }

  // ── detail ───────────────────────────────────────────────

  function optionList(question) {
    const options = question.options;
    let entries = [];
    if (Array.isArray(options)) {
      entries = options.map((option, index) => [
        option?.key || option?.label || String.fromCharCode(65 + index),
        option?.text ?? option?.value ?? "",
      ]);
    } else if (options && typeof options === "object") {
      entries = Object.entries(options);
    }
    if (!entries.length) return "";
    return `<ul class="options">${entries
      .map(([key, text]) => `<li><strong>${escapeHtml(key)}</strong>. ${escapeHtml(text)}</li>`)
      .join("")}</ul>`;
  }

  function totalPages() {
    const count = state.extraction?.questions?.length || 0;
    return Math.max(1, Math.ceil(count / QUESTIONS_PER_PAGE));
  }

  function pageQuestionIndexes(page = state.page) {
    const count = state.extraction?.questions?.length || 0;
    const start = (page - 1) * QUESTIONS_PER_PAGE;
    const indexes = [];
    for (let index = start; index < Math.min(start + QUESTIONS_PER_PAGE, count); index += 1) {
      indexes.push(index);
    }
    return indexes;
  }

  function renderPagination() {
    const bar = $("#paginationBar");
    const pages = totalPages();
    bar.hidden = pages <= 1;
    const count = state.extraction?.questions?.length || 0;
    const start = (state.page - 1) * QUESTIONS_PER_PAGE + 1;
    const end = Math.min(state.page * QUESTIONS_PER_PAGE, count);
    $("#pageInfo").textContent = `第 ${state.page}/${pages} 页 · ${count ? `${start}–${end} 题` : "无题目"} · 共 ${count} 题`;
    $("#prevPageButton").disabled = state.page <= 1;
    $("#nextPageButton").disabled = state.page >= pages;
  }

  function renderQuestions() {
    const list = $("#questionList");
    list.replaceChildren();
    for (const index of pageQuestionIndexes()) {
      const question = state.extraction.questions[index];
      const card = document.createElement("article");
      card.className = "question-card";
      card.dataset.index = String(index);
      card.innerHTML = `
        <div class="question-head">
          <span class="question-index">第 ${index + 1} 题</span>
          <p class="question-stem">${escapeHtml(question.stem)}</p>
        </div>
        ${optionList(question)}
        ${answerBox(question)}
        <div class="question-actions">
          <button class="button button-secondary button-small" data-solve="${index}" type="button">
            ${question.answer === null ? "AI 解答" : "重新解答"}
          </button>
        </div>`;
      list.append(card);
    }
    list.querySelectorAll("[data-solve]").forEach((button) => {
      button.addEventListener("click", () => solveIndexes([Number(button.dataset.solve)], button));
    });
    renderPagination();
  }

  function goToPage(page, focusIndex = -1) {
    state.page = Math.min(Math.max(1, page), totalPages());
    renderQuestions();
    const top = $("#paginationBar");
    top.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focusIndex >= 0) {
      const card = document.querySelector(`.question-card[data-index="${focusIndex}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("is-located");
        window.setTimeout(() => card.classList.remove("is-located"), 2400);
      }
    }
  }

  function jumpToQuestion(event) {
    event.preventDefault();
    const number = Number($("#jumpInput").value);
    const count = state.extraction?.questions?.length || 0;
    if (!Number.isInteger(number) || number < 1 || number > count) {
      showToast(`请输入 1–${count} 之间的题号。`, "error");
      return;
    }
    const index = number - 1;
    goToPage(Math.floor(index / QUESTIONS_PER_PAGE) + 1, index);
    $("#jumpInput").value = "";
  }

  function answerBox(question) {
    if (question.answer === null || question.answer === undefined) {
      const raw = question.rawText
        ? `<p class="raw-text">模型原文：${escapeHtml(question.rawText)}</p>`
        : "";
      return `<div class="answer-box is-empty"><span class="answer-value">未解</span></div>${raw}`;
    }
    const confidence = Number.isFinite(Number(question.confidence))
      ? `${Math.round(Number(question.confidence) * 100)}%`
      : "";
    const meta = [
      confidence,
      question.model,
      question.latencyMs != null ? (question.latencyMs < 1000 ? `${Math.round(question.latencyMs)} ms` : `${(question.latencyMs / 1000).toFixed(1)} s`) : "",
      formatTime(question.solvedAt),
    ].filter(Boolean).join(" · ");
    return `
      <div class="answer-box">
        <span class="answer-value">${escapeHtml(answerText(question.answer))}</span>
        <span class="answer-meta">${escapeHtml(meta)}</span>
      </div>
      ${question.rawText ? `<p class="raw-text">模型原文：${escapeHtml(question.rawText)}</p>` : ""}`;
  }

  async function openDetail(id, focusIndex = -1) {
    try {
      state.extraction = await api(`/api/v1/extractions/${encodeURIComponent(id)}`);
      const source = state.extraction.source || {};
      $("#detailTitle").textContent = source.title || hostOf(source.url);
      $("#detailMeta").textContent = `${formatTime(state.extraction.savedAt)} · ${source.url || ""}`;
      disarmDelete();
      switchView("detail");
      if (focusIndex >= 0) {
        goToPage(Math.floor(focusIndex / QUESTIONS_PER_PAGE) + 1, focusIndex);
      } else {
        state.page = 1;
        renderQuestions();
        window.scrollTo({ top: 0 });
      }
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  // ── search ───────────────────────────────────────────────

  async function runSearch(event) {
    event.preventDefault();
    const query = $("#searchInput").value.trim();
    if (!query) {
      loadList();
      return;
    }
    try {
      const data = await api(`/api/v1/search?q=${encodeURIComponent(query)}`);
      const list = $("#extractionList");
      list.replaceChildren();
      $("#loadMoreButton").hidden = true;
      $("#statsRow").replaceChildren();
      if (!data.hits.length) {
        const note = document.createElement("p");
        note.className = "empty-note";
        note.innerHTML = `<strong>没有匹配「${escapeHtml(query)}」的题目</strong>清空搜索框可返回题库列表。`;
        list.append(note);
        return;
      }
      data.hits.forEach((hit) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "extraction-card search-hit";
        const answer = hit.answer === null || hit.answer === undefined
          ? ""
          : ` · 答案 ${escapeHtml(answerText(hit.answer))}`;
        card.innerHTML = `
          <span class="source">${escapeHtml(hit.stem)}</span>
          <span class="host">${escapeHtml(formatTime(hit.savedAt))} · 第 ${hit.questionIndex + 1} 题${answer}</span>`;
        card.addEventListener("click", () => openDetail(hit.extractionId, hit.questionIndex));
        list.append(card);
      });
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function solveIndexes(indexes, button) {
    if (!state.extraction || !indexes?.length) return;
    const target = button;
    if (target) setButtonBusy(target, true, "解答中…");
    try {
      const outcome = await api("/api/v1/solve", {
        method: "POST",
        body: JSON.stringify({
          extractionId: state.extraction.id,
          questionIndexes: indexes,
          // A single index is an explicit per-question request and re-solves;
          // page batches skip questions that already have answers.
          force: indexes.length === 1,
        }),
      });
      state.extraction = await api(
        `/api/v1/extractions/${encodeURIComponent(state.extraction.id)}`
      );
      renderQuestions();
      if (outcome.solved) {
        showToast(`已解答 ${outcome.solved} 题。`);
      } else {
        showToast("这些题已有答案，未重复调用。");
      }
      return outcome;
    } catch (error) {
      showToast(error.message, "error");
      return null;
    } finally {
      if (target) setButtonBusy(target, false);
    }
  }

  async function solveCurrentPage() {
    if (state.solvingAll) return;
    await solveIndexes(pageQuestionIndexes(), $("#solvePageButton"));
  }

  // Auto-solving is tasked page by page: one short request per page instead of
  // a single long-running call, with progress on the button and a stop toggle.
  async function solveAllPages() {
    if (!state.extraction) return;
    if (state.solvingAll) {
      state.stopSolving = true;
      $("#solveAllButton").textContent = "正在停止…";
      return;
    }
    state.solvingAll = true;
    state.stopSolving = false;
    const button = $("#solveAllButton");
    button.disabled = false;
    try {
      let solvedTotal = 0;
      for (let page = 1; page <= totalPages(); page += 1) {
        if (state.stopSolving) break;
        button.textContent = `停止 · ${page}/${totalPages()} 页`;
        const outcome = await api("/api/v1/solve", {
          method: "POST",
          body: JSON.stringify({
            extractionId: state.extraction.id,
            questionIndexes: pageQuestionIndexes(page),
            force: false,
          }),
        });
        solvedTotal += outcome.solved || 0;
        state.extraction = await api(
          `/api/v1/extractions/${encodeURIComponent(state.extraction.id)}`
        );
        state.page = page;
        renderQuestions();
      }
      showToast(state.stopSolving
        ? `已停止，本次共解答 ${solvedTotal} 题。`
        : `逐页解答完成，共 ${solvedTotal} 题。`);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      state.solvingAll = false;
      state.stopSolving = false;
      button.textContent = "全部解答 · 逐页";
    }
  }

  // ── delete (two-step confirm) ─────────────────────────────

  function disarmDelete() {
    state.deleteArmed = false;
    window.clearTimeout(state.deleteTimer);
    const button = $("#deleteButton");
    button.textContent = "删除";
    button.classList.remove("is-armed");
  }

  async function deleteExtraction() {
    if (!state.extraction) return;
    const button = $("#deleteButton");
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      button.textContent = "确认删除？";
      button.classList.add("is-armed");
      state.deleteTimer = window.setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    setButtonBusy(button, true, "删除中…");
    try {
      await api(`/api/v1/extractions/${encodeURIComponent(state.extraction.id)}`, {
        method: "DELETE",
      });
      showToast("提取记录已删除。");
      state.extraction = null;
      switchView("bank");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  // ── settings ─────────────────────────────────────────────

  async function loadSettings() {
    try {
      const config = await api("/api/v1/model-config");
      $("#endpointInput").value = config.endpoint || "";
      $("#modelInput").value = config.model || "";
      $("#maxTokensInput").value = config.maxOutputTokens ?? 512;
      $("#timeoutInput").value = config.timeoutMs ?? 60000;
      $("#apiKeyInput").value = "";
      $("#apiKeyHint").textContent = config.hasApiKey
        ? `（已保存 ····${config.apiKeyTail || ""}，留空即保留）`
        : "";
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function setStatus(message, variant = "") {
    const node = $("#settingsStatus");
    node.textContent = message;
    node.className = `settings-status${variant ? ` is-${variant}` : ""}`;
  }

  function settingsPayload() {
    return {
      endpoint: $("#endpointInput").value.trim(),
      apiKey: $("#apiKeyInput").value.trim(),
      model: $("#modelInput").value.trim(),
      maxOutputTokens: Number($("#maxTokensInput").value) || 512,
      timeoutMs: Number($("#timeoutInput").value) || 60000,
    };
  }

  async function saveSettings(event) {
    event.preventDefault();
    const payload = settingsPayload();
    if (!payload.endpoint || !payload.model) {
      setStatus("请填写接口地址和模型 ID。", "error");
      return;
    }
    const button = $("#saveButton");
    setButtonBusy(button, true, "保存中…");
    try {
      await api("/api/v1/model-config", { method: "PUT", body: JSON.stringify(payload) });
      setStatus("设置已保存。", "success");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function testConnection() {
    const payload = settingsPayload();
    if (!payload.endpoint || !payload.model) {
      setStatus("请先填写接口地址和模型 ID。", "error");
      return;
    }
    const button = $("#testButton");
    setButtonBusy(button, true, "测试中…");
    try {
      // The test must run against persisted credentials: save first (an empty
      // key keeps the stored one), then test.
      await api("/api/v1/model-config", { method: "PUT", body: JSON.stringify(payload) });
      const outcome = await api("/api/v1/model-config/test", { method: "POST", body: "{}" });
      setStatus(`连接成功 · ${outcome.latencyMs} ms · 模型回复「${outcome.reply}」。`, "success");
      await loadSettings();
    } catch (error) {
      setStatus(`连接失败：${error.message}`, "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  // ── view switching ───────────────────────────────────────

  function switchView(view) {
    state.tab = view;
    $("#loginView").hidden = view !== "login";
    $("#bankView").hidden = view !== "bank";
    $("#detailView").hidden = view !== "detail";
    $("#settingsView").hidden = view !== "settings";
    document.querySelectorAll(".tab-button").forEach((button) => {
      const active = button.dataset.tab === view;
      button.classList.toggle("is-active", active);
    });
    $(".tabbar").classList.toggle("is-hidden", view === "detail" || view === "login");
    if (view === "bank") refreshAll();
    if (view === "settings") loadSettings();
  }

  // ── auth ─────────────────────────────────────────────────

  async function login(event) {
    event.preventDefault();
    const userId = $("#loginUserId").value.trim();
    const key = $("#loginKey").value.trim();
    const status = $("#loginStatus");
    if (!userId || !key) {
      status.textContent = "请填写 User ID 和 Key。";
      status.className = "settings-status is-error";
      return;
    }
    status.textContent = "正在验证…";
    status.className = "settings-status";
    const previous = state.auth;
    state.auth = { userId, key };
    try {
      const health = await api("/api/v1/health");
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state.auth));
      status.textContent = "";
      showToast(`已登录：${health.user || userId}`);
      $("#logoutButton").hidden = false;
      switchView("bank");
    } catch (error) {
      state.auth = previous;
      status.textContent = `登录失败：${error.message}`;
      status.className = "settings-status is-error";
    }
  }

  function logout() {
    state.auth = null;
    localStorage.removeItem(AUTH_STORAGE_KEY);
    $("#logoutButton").hidden = true;
    switchView("login");
  }

  async function detectAuthMode() {
    // Open mode (no users configured) enters straight into the bank.
    try {
      await api("/api/v1/health");
      $("#logoutButton").hidden = !state.auth;
      switchView("bank");
    } catch (error) {
      if (state.auth || String(error.message).includes("用户") || String(error.message).includes("X-Api-Key")) {
        switchView("login");
        $("#loginStatus").textContent = state.auth ? "凭据已失效，请重新登录。" : "";
        state.auth = null;
        localStorage.removeItem(AUTH_STORAGE_KEY);
        return;
      }
      showToast(error.message, "error");
      switchView("bank");
    }
  }

  function bindEvents() {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.tab));
    });
    $("#backButton").addEventListener("click", () => {
      state.stopSolving = true;
      disarmDelete();
      switchView("bank");
    });
    $("#refreshButton").addEventListener("click", refreshAll);
    $("#loadMoreButton").addEventListener("click", async () => {
      state.offset += PAGE_SIZE;
      await loadList({ append: true });
    });
    $("#solvePageButton").addEventListener("click", solveCurrentPage);
    $("#solveAllButton").addEventListener("click", solveAllPages);
    $("#deleteButton").addEventListener("click", deleteExtraction);
    $("#prevPageButton").addEventListener("click", () => goToPage(state.page - 1));
    $("#nextPageButton").addEventListener("click", () => goToPage(state.page + 1));
    $("#jumpForm").addEventListener("submit", jumpToQuestion);
    $("#settingsForm").addEventListener("submit", saveSettings);
    $("#testButton").addEventListener("click", testConnection);
    $("#searchForm").addEventListener("submit", runSearch);
    $("#searchInput").addEventListener("input", (event) => {
      if (!event.target.value.trim()) loadList();
    });
    $("#loginForm").addEventListener("submit", login);
    $("#logoutButton").addEventListener("click", logout);
  }

  bindEvents();
  state.auth = loadAuth();
  detectAuthMode();
})();
