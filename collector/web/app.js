/* CyberWikiBench collector UI — vanilla JS, mobile-first, same-origin API. */
(() => {
  "use strict";

  const PAGE_SIZE = 20;
  const state = {
    tab: "bank",
    offset: 0,
    total: 0,
    items: [],
    extraction: null,
  };

  const $ = (selector) => document.querySelector(selector);

  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
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

  function renderQuestions() {
    const list = $("#questionList");
    list.replaceChildren();
    state.extraction.questions.forEach((question, index) => {
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
    });
    list.querySelectorAll("[data-solve]").forEach((button) => {
      button.addEventListener("click", () => solveIndexes([Number(button.dataset.solve)], button));
    });
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

  async function openDetail(id) {
    try {
      state.extraction = await api(`/api/v1/extractions/${encodeURIComponent(id)}`);
      const source = state.extraction.source || {};
      $("#detailTitle").textContent = source.title || hostOf(source.url);
      $("#detailMeta").textContent = `${formatTime(state.extraction.savedAt)} · ${source.url || ""}`;
      renderQuestions();
      switchView("detail");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function solveIndexes(indexes, button) {
    if (!state.extraction) return;
    const target = button || $("#solveAllButton");
    setButtonBusy(target, true, "解答中…");
    try {
      const outcome = await api("/api/v1/solve", {
        method: "POST",
        body: JSON.stringify({
          extractionId: state.extraction.id,
          // null → server solves every unanswered question; a single index is
          // an explicit per-question request and re-solves (force).
          questionIndexes: indexes,
          force: Array.isArray(indexes) && indexes.length === 1,
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
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setButtonBusy(target, false);
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
    $("#bankView").hidden = view !== "bank";
    $("#detailView").hidden = view !== "detail";
    $("#settingsView").hidden = view !== "settings";
    document.querySelectorAll(".tab-button").forEach((button) => {
      const active = button.dataset.tab === view;
      button.classList.toggle("is-active", active);
    });
    $(".tabbar").classList.toggle("is-hidden", view === "detail");
    if (view === "bank") refreshAll();
    if (view === "settings") loadSettings();
  }

  function bindEvents() {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.tab));
    });
    $("#backButton").addEventListener("click", () => switchView("bank"));
    $("#refreshButton").addEventListener("click", refreshAll);
    $("#loadMoreButton").addEventListener("click", async () => {
      state.offset += PAGE_SIZE;
      await loadList({ append: true });
    });
    $("#solveAllButton").addEventListener("click", () => solveIndexes(null));
    $("#settingsForm").addEventListener("submit", saveSettings);
    $("#testButton").addEventListener("click", testConnection);
  }

  bindEvents();
  refreshAll();
})();
