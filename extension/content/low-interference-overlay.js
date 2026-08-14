/*
 * Low-interference page overlay.
 *
 * The UI lives in a Shadow DOM so page styles cannot reshape it. It receives
 * only public question/result data; provider credentials stay in the service
 * worker. The overlay is deliberately identifiable and always has an exit.
 */
(() => {
  "use strict";

  const GLOBAL_KEY = "__CWKB_LOW_INTERFERENCE_OVERLAY_V1__";
  if (globalThis[GLOBAL_KEY]) return;

  const state = {
    host: null,
    shadow: null,
    panel: null,
    config: null,
    question: null,
    questions: [],
    result: null,
    busy: false,
    collapsed: true,
    drag: null,
    suppressHeaderClick: false,
    userHidden: false,
    // Stealth mode: overlay auto-hides when mouse is far away.
    stealth: false,
    stealthVisible: false,
    stealthTimer: null,
    stealthProximity: 80,  // px radius to detect mouse proximity
    stealthAutoHideMs: 2000, // ms before auto-hiding after mouse leaves
    stealthPinned: false,  // pinned open via keyboard shortcut
  };

  Object.defineProperty(globalThis, GLOBAL_KEY, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const clamp = (value, minimum, maximum) => Math.min(Math.max(Number(value) || 0, minimum), maximum);

  function normalizeConfig(value = {}) {
    return {
      enabled: value.enabled === true,
      stealth: value.stealth === true,
      stealthOpacity: clamp(value.stealthOpacity ?? 0.08, 0.01, 0.3),
      opacity: clamp(value.opacity || 0.68, 0.3, 1),
      clickThrough: value.clickThrough === true,
      collapsed: value.collapsed !== false,
      position: {
        right: clamp(value.position?.right || 18, 8, 10_000),
        bottom: clamp(value.position?.bottom || 18, 8, 10_000),
      },
    };
  }

  function runtimeMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response) {
          reject(new Error("插件后台没有返回响应。"));
          return;
        }
        if (response.ok === false) {
          reject(new Error(response.error?.message || response.error || "浮窗操作失败。"));
          return;
        }
        resolve(response.data ?? response);
      });
    });
  }

  function styles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button { font: inherit; }
      .panel {
        --opacity: .68;
        width: min(296px, calc(100vw - 24px));
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, .76);
        border-radius: 18px;
        background: rgba(244, 247, 245, .94);
        color: #17211d;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, .9),
          0 18px 46px rgba(12, 18, 15, .22),
          0 2px 8px rgba(12, 18, 15, .1);
        opacity: var(--opacity);
        backdrop-filter: blur(18px) saturate(120%);
        -webkit-backdrop-filter: blur(18px) saturate(120%);
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        transition: border-radius 140ms ease, box-shadow 140ms ease, opacity 130ms ease, transform 140ms ease;
        user-select: none;
      }
      .panel.is-collapsed {
        width: 54px;
        height: 54px;
        border-color: rgba(255, 255, 255, .52);
        border-radius: 18px;
        background: rgba(38, 41, 40, .82);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, .2),
          inset 0 0 0 1px rgba(255, 255, 255, .06),
          0 10px 26px rgba(8, 12, 10, .3);
        cursor: pointer;
      }
      .panel.is-collapsed:hover {
        transform: scale(1.08);
        border-color: rgba(255, 255, 255, .7);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, .24),
          inset 0 0 0 1px rgba(255, 255, 255, .1),
          0 16px 34px rgba(8, 12, 10, .38);
      }
      .panel.is-collapsed:hover .mark {
        transform: scale(1.05);
      }
      .panel.is-collapsed .mark {
        transition: transform 140ms ease;
      }
      .panel.is-collapsed .header {
        width: 54px;
        height: 54px;
        min-height: 54px;
        justify-content: center;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: grab;
      }
      .panel.is-collapsed .header:focus-visible {
        outline: 2px solid rgba(255, 255, 255, .9);
        outline-offset: 3px;
        border-radius: 16px;
      }
      .panel.is-collapsed .brand-copy,
      .panel.is-collapsed .header-actions,
      .panel.is-collapsed .body { display: none; }
      .panel.is-collapsed .mark {
        width: 29px;
        height: 29px;
        flex-basis: 29px;
        overflow: hidden;
        border-radius: 50%;
        background: rgba(255, 255, 255, .96);
        color: transparent;
        box-shadow:
          inset 0 0 0 5px rgba(38, 41, 40, .14),
          0 1px 4px rgba(0, 0, 0, .22);
      }
      .panel.is-collapsed .mark::after {
        content: "";
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: rgba(38, 41, 40, .36);
      }
      .panel.is-pass-through .body { pointer-events: none; }
      .header {
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 54px;
        padding: 9px 9px 9px 11px;
        border-bottom: 1px solid rgba(34, 52, 44, .1);
        background: rgba(255, 255, 255, .62);
        cursor: grab;
        touch-action: none;
      }
      .header:active { cursor: grabbing; }
      .mark {
        display: grid;
        width: 30px;
        height: 30px;
        flex: 0 0 30px;
        place-items: center;
        border-radius: 10px;
        background: #252c29;
        color: transparent;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12);
      }
      .mark::after {
        content: "";
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: rgba(255, 255, 255, .94);
      }
      .brand-copy { min-width: 0; flex: 1; }
      .brand-copy strong { display: block; font-size: 12px; font-weight: 720; line-height: 1.2; letter-spacing: -.01em; }
      .header-actions { display: inline-flex; gap: 4px; }
      .icon-button {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 9px;
        background: transparent;
        color: #56605c;
        cursor: pointer;
      }
      .icon-button:hover { background: rgba(30, 48, 40, .08); color: #17211d; }
      .collapse-button {
        width: auto;
        min-width: 44px;
        padding: 0 9px;
        background: rgba(30, 48, 40, .07);
        font-size: 10px;
        font-weight: 700;
      }
      .icon-button:focus-visible, .button:focus-visible {
        outline: 2px solid rgba(20, 118, 83, .4);
        outline-offset: 2px;
      }
      .body { padding: 10px; user-select: text; }
      .picker { margin-bottom: 8px; }
      .picker select {
        width: 100%;
        height: 30px;
        border: 1px solid rgba(35, 52, 44, .16);
        border-radius: 9px;
        background: rgba(255, 255, 255, .8);
        color: #25312c;
        font-size: 11px;
        font-weight: 650;
        padding: 0 8px;
      }
      .question {
        max-height: 92px;
        overflow: auto;
        margin: 0;
        padding: 9px 10px;
        border: 1px solid rgba(35, 52, 44, .12);
        border-radius: 10px;
        background: rgba(255, 255, 255, .74);
        color: #25312c;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 11px;
        font-weight: 650;
        line-height: 1.5;
      }
      .question.is-empty { color: #79867f; font-weight: 500; }
      .result {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 44px;
        margin-top: 8px;
        padding: 9px 11px;
        border-radius: 10px;
        background: #213129;
        color: #f6faf8;
      }
      .result strong { font-size: 22px; line-height: 1.1; letter-spacing: -.03em; }
      .result-meta { max-width: 128px; color: #c8d6cf; text-align: right; font-size: 10px; }
      .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 9px; }
      .button {
        min-height: 34px;
        border: 1px solid rgba(32, 51, 42, .18);
        border-radius: 9px;
        background: rgba(255, 255, 255, .85);
        color: #26332d;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .button:hover:not(:disabled) { border-color: rgba(32, 51, 42, .45); background: #fff; }
      .button:disabled { cursor: wait; opacity: .48; }
      .status {
        min-height: 14px;
        margin: 7px 1px 0;
        padding: 3px 6px;
        color: #58635e;
        font-size: 10px;
        line-height: 1.45;
      }
      .status.is-error {
        color: #8f2c27;
        background: rgba(163, 55, 49, .1);
      }
      @media (prefers-reduced-transparency: reduce) {
        .panel { background: #f4f7f5; backdrop-filter: none; -webkit-backdrop-filter: none; }
        .panel.is-collapsed { background: #262928; }
      }
      @media (prefers-reduced-motion: reduce) {
        .panel { transition: none; }
        .panel.is-collapsed:hover { transform: none; }
        .panel.is-collapsed:hover .mark { transform: none; }
      }
      /* Stealth mode: fade indicator */
      .stealth-indicator {
        position: absolute;
        top: -6px;
        right: -6px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(255, 200, 0, .85);
        box-shadow: 0 0 4px rgba(255, 200, 0, .5);
        pointer-events: none;
        opacity: 0;
        transition: opacity 200ms ease;
      }
      .stealth-indicator.is-active { opacity: 1; }
    `;
  }

  function createElement() {
    const host = document.createElement("div");
    host.id = "cwkb-low-interference-overlay";
    host.style.cssText = [
      "position:fixed",
      "z-index:2147483000",
      "right:18px",
      "bottom:18px",
      "width:auto",
      "height:auto",
      "margin:0",
      "padding:0",
      "border:0",
      "background:transparent",
      "pointer-events:auto",
    ].join(";");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles();

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("aria-label", "CyberWikiBench 低干扰浮窗");
    panel.innerHTML = `
      <header class="header" data-drag-handle title="拖动小白点；点击展开">
        <span class="mark" aria-hidden="true"></span>
        <span class="brand-copy">
          <strong>题目助手</strong>
        </span>
        <span class="header-actions">
          <button class="icon-button collapse-button" data-action="collapse" type="button" title="收起为小白点" aria-label="收起为小白点">—</button>
          <button class="icon-button" data-action="close" type="button" title="关闭浮窗模式" aria-label="关闭浮窗模式">×</button>
        </span>
      </header>
      <div class="body">
        <div class="picker" data-role="picker" hidden>
          <select data-role="question-select" aria-label="选择题号"></select>
        </div>
        <p class="question is-empty" data-role="question">点「提取」识别当前题目</p>
        <div class="result" data-role="result" hidden>
          <strong data-role="answer">-</strong>
          <span class="result-meta" data-role="result-meta"></span>
        </div>
        <div class="actions">
          <button class="button" data-action="extract" type="button">提取</button>
          <button class="button" data-action="solve" type="button">解答</button>
          <button class="button" data-action="fill" type="button" disabled>填入</button>
        </div>
        <p class="status" data-role="status" aria-live="polite"></p>
      </div>
    `;

    // Stealth indicator — tiny yellow dot shown when stealth mode is active
    const indicator = document.createElement("span");
    indicator.className = "stealth-indicator";
    indicator.setAttribute("aria-hidden", "true");
    panel.style.position = "relative";
    panel.append(indicator);

    shadow.append(style, panel);
    (document.documentElement || document.body).append(host);
    state.host = host;
    state.shadow = shadow;
    state.panel = panel;
    bindEvents();
    bindStealthEvents();
    return host;
  }

  function role(name) {
    return state.shadow?.querySelector(`[data-role="${name}"]`) || null;
  }

  function action(name) {
    return state.shadow?.querySelector(`[data-action="${name}"]`) || null;
  }

  function setStatus(message, error = false) {
    const node = role("status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", error);
  }

  function answerLabel(answer) {
    if (Array.isArray(answer)) return answer.map(String).join(", ").toUpperCase();
    if (answer === true || answer === "true") return "正确";
    if (answer === false || answer === "false") return "错误";
    return answer === undefined || answer === null || answer === "" ? "-" : String(answer).toUpperCase();
  }

  function hasFillableAnswer() {
    const answer = state.result?.answer ?? state.result?.parsedAnswer;
    return Boolean(state.question?.id)
      && answer !== undefined
      && answer !== null
      && answer !== ""
      && (!Array.isArray(answer) || answer.length > 0);
  }

  function questionFromResponse(response) {
    return response?.question || response?.extractedQuestion || null;
  }

  function questionTypeShort(question) {
    if (question?.type === "multiple_choice") return "多选";
    if (question?.type === "true_false") return "判断";
    if (question?.type === "choice_unknown") return "选择";
    return "单选";
  }

  function absorbQuestions(response) {
    const questions = Array.isArray(response?.questions) ? response.questions : [];
    if (!questions.length) return;
    state.questions = questions;
    renderQuestionPicker();
  }

  /** Show the question picker only when the page actually has several questions. */
  function renderQuestionPicker() {
    const picker = role("picker");
    const select = role("question-select");
    if (!picker || !select) return;
    if (state.questions.length < 2) {
      picker.hidden = true;
      return;
    }
    picker.hidden = false;
    select.replaceChildren(...state.questions.map((question, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `第 ${index + 1} 题 · ${questionTypeShort(question)}`;
      return option;
    }));
    const selected = state.questions.findIndex((question) => question.id === state.question?.id);
    select.value = String(selected >= 0 ? selected : 0);
  }

  function selectQuestionByIndex(index) {
    const question = state.questions[index];
    if (!question || question.id === state.question?.id) return;
    renderQuestion(question);
  }

  function renderQuestion(question) {
    state.question = question || null;
    state.result = null;
    const node = role("question");
    const result = role("result");
    const fill = action("fill");
    if (result) result.hidden = true;
    if (fill) fill.disabled = true;
    if (!node) return;
    node.classList.toggle("is-empty", !question?.stem);
    node.textContent = question?.stem || "当前页面没有可识别的题目。";
  }

  function renderResult(response) {
    const result = response?.result || response;
    const question = questionFromResponse(response) || state.question;
    if (question) state.question = question;
    state.result = result;
    const answer = result?.answer ?? result?.parsedAnswer;
    const resultNode = role("result");
    if (resultNode) resultNode.hidden = false;
    const answerNode = role("answer");
    if (answerNode) answerNode.textContent = answerLabel(answer);
    const confidence = Number(result?.confidence);
    const latency = Number(result?.latencyMs ?? result?.latency_ms);
    const details = [];
    if (Number.isFinite(confidence)) details.push(`置信度 ${Math.round((confidence <= 1 ? confidence * 100 : confidence))}%`);
    if (Number.isFinite(latency)) details.push(latency < 1000 ? `${Math.round(latency)} ms` : `${(latency / 1000).toFixed(1)} s`);
    const meta = role("result-meta");
    if (meta) meta.textContent = details.join(" · ") || result?.route || "模型作答";
    const fill = action("fill");
    if (fill) fill.disabled = !hasFillableAnswer();
  }

  function setBusy(busy, currentAction = "") {
    state.busy = busy;
    for (const name of ["extract", "solve", "fill"]) {
      const button = action(name);
      if (!button) continue;
      button.disabled = busy || (name === "fill" && !hasFillableAnswer());
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.textContent = busy && name === currentAction
        ? (name === "extract" ? "提取中…" : name === "solve" ? "解答中…" : "填入中…")
        : button.dataset.label;
    }
  }

  async function runAction(name) {
    if (state.busy) return;
    // In stealth mode, show the overlay during the action
    if (state.stealth) setStealthVisible(true);
    setBusy(true, name);
    setStatus(name === "solve" ? "正在调用已配置的模型…" : "正在处理当前页面…");
    try {
      if (name === "extract") {
        const response = await runtimeMessage("CWKB_OVERLAY_ACTION", { action: "extract" });
        absorbQuestions(response);
        renderQuestion(questionFromResponse(response));
        setStatus(`识别到 ${state.questions.length || 1} 题。`);
      } else if (name === "solve") {
        // Content scripts cannot request host permissions, so check readiness
        // up front and surface a clear, actionable message instead of failing
        // mid-solve with a cryptic permission error.
        const readiness = await runtimeMessage("CWKB_OVERLAY_READINESS");
        if (!readiness?.ready) {
          setStatus(readiness?.message || "无法解答：请先在侧边栏配置并授权模型。", true);
          return;
        }
        const response = await runtimeMessage("CWKB_OVERLAY_ACTION", {
          action: "solve",
          questionId: state.question?.id,
        });
        const question = questionFromResponse(response);
        if (question) renderQuestion(question);
        absorbQuestions(response);
        renderResult(response);
        setStatus("答案仅供核对。");
      } else if (name === "fill") {
        const answer = state.result?.answer ?? state.result?.parsedAnswer;
        const response = await runtimeMessage("CWKB_OVERLAY_ACTION", {
          action: "fill",
          questionId: state.question?.id,
          answer,
        });
        setStatus(response?.filled === false ? "未能确认填入状态。" : "已填入，未提交。", response?.filled === false);
      }
    } catch (error) {
      setStatus(error?.message || "浮窗操作失败。", true);
    } finally {
      setBusy(false);
      // In stealth mode, schedule auto-hide after action completes
      if (state.stealth && state.stealthVisible) scheduleStealthHide();
    }
  }

  function setCollapsed(collapsed, { persist = false } = {}) {
    state.collapsed = Boolean(collapsed);
    state.panel?.classList.toggle("is-collapsed", state.collapsed);
    const handle = state.shadow?.querySelector("[data-drag-handle]");
    if (handle) {
      if (state.collapsed) {
        handle.setAttribute("role", "button");
        handle.setAttribute("tabindex", "0");
        handle.setAttribute("aria-label", "展开 CyberWikiBench 低干扰浮窗");
        handle.title = "点击展开 · 按住拖动";
      } else {
        handle.removeAttribute("role");
        handle.removeAttribute("tabindex");
        handle.removeAttribute("aria-label");
        handle.title = "按住拖动 · 点击收起";
      }
    }
    const button = action("collapse");
    if (button) {
      button.setAttribute("aria-label", "收起为小白点");
      button.setAttribute("aria-expanded", String(!state.collapsed));
    }
    state.panel?.setAttribute("aria-expanded", String(!state.collapsed));
    // Stealth semantics: an expanded panel is "in use" — pin it visible so a
    // stray mousemove cannot fade it out mid-interaction; collapsing the dot
    // returns to the low-opacity stealth state immediately.
    if (state.stealth) {
      if (state.collapsed) setStealthVisible(false);
      else setStealthVisible(true, { pin: true });
    }
    clampToViewport();
    if (persist) {
      runtimeMessage("CWKB_OVERLAY_COLLAPSED", { collapsed: state.collapsed }).catch(() => undefined);
    }
  }

  function clampToViewport() {
    if (!state.host) return;
    const rect = state.host.getBoundingClientRect();
    const right = clamp(window.innerWidth - rect.right, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const bottom = clamp(window.innerHeight - rect.bottom, 8, Math.max(8, window.innerHeight - rect.height - 8));
    state.host.style.left = "auto";
    state.host.style.top = "auto";
    state.host.style.right = `${right}px`;
    state.host.style.bottom = `${bottom}px`;
  }

  function anchorToLeftTop(left, top) {
    state.host.style.right = "auto";
    state.host.style.bottom = "auto";
    state.host.style.left = `${left}px`;
    state.host.style.top = `${top}px`;
  }

  function anchorToRightBottom() {
    const rect = state.host.getBoundingClientRect();
    const right = clamp(window.innerWidth - rect.right, 8, 10_000);
    const bottom = clamp(window.innerHeight - rect.bottom, 8, 10_000);
    state.host.style.left = "auto";
    state.host.style.top = "auto";
    state.host.style.right = `${right}px`;
    state.host.style.bottom = `${bottom}px`;
    return { right, bottom };
  }

  function beginDrag(event) {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    const rect = state.host.getBoundingClientRect();
    state.suppressHeaderClick = false;
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      anchored: false,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    const deltaX = event.clientX - state.drag.startX;
    const deltaY = event.clientY - state.drag.startY;
    // Anchor to left/top at the exact current pixel position on the first
    // move, so the panel never jumps when the drag threshold is crossed.
    if (!state.drag.anchored) {
      anchorToLeftTop(state.drag.left, state.drag.top);
      state.drag.anchored = true;
    }
    if (Math.hypot(deltaX, deltaY) < 4 && !state.drag.moved) return;
    state.drag.moved = true;
    const width = state.host.offsetWidth;
    const height = state.host.offsetHeight;
    const left = clamp(state.drag.left + deltaX, 8, Math.max(8, window.innerWidth - width - 8));
    const top = clamp(state.drag.top + deltaY, 8, Math.max(8, window.innerHeight - height - 8));
    state.host.style.left = `${left}px`;
    state.host.style.top = `${top}px`;
  }

  function endDrag(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    const { moved, anchored } = state.drag;
    state.drag = null;
    state.suppressHeaderClick = moved;
    if (moved) {
      window.setTimeout(() => {
        state.suppressHeaderClick = false;
      }, 0);
      const { right, bottom } = anchorToRightBottom();
      runtimeMessage("CWKB_OVERLAY_POSITION", { right, bottom }).catch(() => undefined);
    } else if (anchored) {
      // A tremor that never crossed the drag threshold: restore right/bottom
      // anchoring without moving or persisting anything.
      anchorToRightBottom();
    }
  }

  function activateCollapsedHandle() {
    if (!state.collapsed) return;
    setCollapsed(false, { persist: true });
  }

  function handleHeaderClick(event) {
    if (event.target?.closest?.("button")) return;
    if (state.suppressHeaderClick) {
      state.suppressHeaderClick = false;
      return;
    }
    setCollapsed(!state.collapsed, { persist: true });
  }

  function handleHeaderKeydown(event) {
    if (!state.collapsed || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    activateCollapsedHandle();
  }

  function bindEvents() {
    action("collapse")?.addEventListener("click", (event) => {
      event.stopPropagation();
      setCollapsed(true, { persist: true });
    });
    action("close")?.addEventListener("click", () => {
      // Hide on this tab only. The overlay stays enabled globally; refresh the
      // page or re-apply from the side panel to bring it back this session.
      state.userHidden = true;
      hide();
    });
    for (const name of ["extract", "solve", "fill"]) {
      action(name)?.addEventListener("click", () => runAction(name));
    }
    role("question-select")?.addEventListener("change", (event) => {
      selectQuestionByIndex(Number(event.target.value));
    });
    const handle = state.shadow.querySelector("[data-drag-handle]");
    handle?.addEventListener("click", handleHeaderClick);
    handle?.addEventListener("keydown", handleHeaderKeydown);
    handle?.addEventListener("pointerdown", beginDrag);
    handle?.addEventListener("pointermove", moveDrag);
    handle?.addEventListener("pointerup", endDrag);
    handle?.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", clampToViewport);
  }

  // ─── Stealth mode: proximity detection + keyboard shortcut ────────

  function isMouseNearOverlay(event) {
    if (!state.host || state.host.hidden) return false;
    const rect = state.host.getBoundingClientRect();
    const pad = state.stealthProximity;
    return (
      event.clientX >= rect.left - pad &&
      event.clientX <= rect.right + pad &&
      event.clientY >= rect.top - pad &&
      event.clientY <= rect.bottom + pad
    );
  }

  function setStealthVisible(visible, { pin = false } = {}) {
    if (pin) state.stealthPinned = true;
    // Always apply the styles: an early return on equal state would leave a
    // freshly mounted overlay without its stealth styles until first toggle.
    state.stealthVisible = visible;
    if (state.host) {
      const hiddenOpacity = String(state.config?.stealthOpacity ?? 0.08);
      state.host.style.transition = "opacity 300ms ease";
      state.host.style.opacity = visible ? "1" : hiddenOpacity;
      state.host.style.pointerEvents = visible ? "auto" : "none";
      if (!visible) state.stealthPinned = false;
    }
    // Show/hide the small stealth indicator
    const indicator = state.shadow?.querySelector(".stealth-indicator");
    if (indicator) indicator.classList.toggle("is-active", !visible && state.stealth);
  }

  function scheduleStealthHide() {
    if (state.stealthTimer) clearTimeout(state.stealthTimer);
    state.stealthTimer = setTimeout(() => {
      state.stealthTimer = null;
      // Don't hide while an action is running, mid-drag, or if pinned open.
      if (state.busy || state.drag || state.stealthPinned) return;
      setStealthVisible(false);
    }, state.stealthAutoHideMs);
  }

  function handleStealthMouseMove(event) {
    if (!state.stealth || state.host?.hidden) return;
    if (isMouseNearOverlay(event)) {
      if (state.stealthTimer) {
        clearTimeout(state.stealthTimer);
        state.stealthTimer = null;
      }
      if (!state.stealthPinned) setStealthVisible(true);
    } else if (state.stealthVisible && !state.busy && !state.drag && !state.stealthPinned) {
      // Mouse left proximity — start auto-hide timer
      scheduleStealthHide();
    }
  }

  function handleStealthKeydown(event) {
    // Alt+Shift+X (Option+Shift+X on macOS): toggle stealth visibility.
    // Guard first so the page keeps
    // the combo when stealth is off or the overlay is not on this tab.
    if (!event.altKey || !event.shiftKey || event.code !== "KeyX") return;
    if (!state.stealth || state.host?.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.stealthVisible) {
      if (state.stealthTimer) { clearTimeout(state.stealthTimer); state.stealthTimer = null; }
      setStealthVisible(false);
    } else {
      setStealthVisible(true, { pin: true });
      scheduleStealthHide();
    }
  }

  function bindStealthEvents() {
    document.addEventListener("mousemove", handleStealthMouseMove, { passive: true });
    document.addEventListener("keydown", handleStealthKeydown, { capture: true });
  }

  function applyStealthMode(enabled) {
    const previouslyEnabled = state.stealth;
    state.stealth = enabled;
    const indicator = state.shadow?.querySelector(".stealth-indicator");
    if (enabled) {
      // Only drop into the hidden state when stealth is newly enabled or the
      // overlay just mounted. Settings re-syncs — e.g. persisting the
      // collapse toggle round-trips through applyConfig — must not hide (and
      // pointer-events:none) an overlay the user is actively interacting with.
      if (!previouslyEnabled || !state.host?.isConnected) {
        setStealthVisible(false);
        indicator?.classList.add("is-active");
      }
    } else {
      // Exiting stealth — ensure fully visible and interactive.
      if (state.stealthTimer) { clearTimeout(state.stealthTimer); state.stealthTimer = null; }
      state.stealthPinned = false;
      setStealthVisible(true);
      indicator?.classList.remove("is-active");
    }
  }

  function applyConfig(value) {
    const force = value?.force === true;
    const config = normalizeConfig(value);
    const firstMount = !state.host?.isConnected;
    state.config = config;
    if (!config.enabled) {
      hide();
      return { visible: false };
    }
    // An explicit "show" from the side panel overrides a per-tab hide (×).
    // Background-driven syncs never set force, so a hidden tab stays hidden.
    if (force) state.userHidden = false;
    if (state.userHidden) {
      hide();
      return { visible: false };
    }
    if (firstMount) createElement();
    state.host.hidden = false;
    state.host.style.right = `${config.position.right}px`;
    state.host.style.bottom = `${config.position.bottom}px`;
    state.host.style.left = "auto";
    state.host.style.top = "auto";
    state.panel.style.setProperty("--opacity", String(config.opacity));
    state.panel.classList.toggle("is-pass-through", config.clickThrough);
    // applyStealthMode must run BEFORE setCollapsed: on a fresh mount with a
    // persisted expanded state, hiding first and letting setCollapsed's
    // stealth semantics settle the final state avoids an expanded panel stuck
    // at pointer-events:none (every button dead until the mouse comes near).
    applyStealthMode(config.stealth);
    setCollapsed(firstMount ? config.collapsed : state.collapsed);
    return { visible: true };
  }

  function hide() {
    if (state.stealthTimer) { clearTimeout(state.stealthTimer); state.stealthTimer = null; }
    if (state.host) state.host.hidden = true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CWKB_OVERLAY_CONFIG") {
      try {
        sendResponse({ ok: true, data: applyConfig(message.payload || {}) });
      } catch (error) {
        sendResponse({ ok: false, error: { message: error?.message || String(error) } });
      }
      return false;
    }
    if (message?.type === "CWKB_OVERLAY_HIDE") {
      hide();
      sendResponse({ ok: true, data: { visible: false } });
      return false;
    }
    return undefined;
  });
})();
