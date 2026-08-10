const state = {
  stats: null,
  testSet: null,
  result: null,
  startedAt: null,
  lastAnswerAt: null,
  timerHandle: null,
  answerLatencies: new Map(),
};

const views = {
  setup: document.querySelector("#setupView"),
  test: document.querySelector("#testView"),
  result: document.querySelector("#resultView"),
};

function showView(name) {
  Object.entries(views).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `请求失败 (${response.status})`);
  return body;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function typeLabel(type) {
  return type === "single_choice" ? "单选题" : "判断题";
}

async function loadStats() {
  const stats = await api("/api/v1/stats");
  state.stats = stats;
  const total = stats.question_count;
  document.querySelector("#totalQuestions").textContent = total.toLocaleString("zh-CN");
  document.querySelector("#singleCount").textContent = `${stats.type_counts.single_choice || 0} 题`;
  document.querySelector("#trueFalseCount").textContent = `${stats.type_counts.true_false || 0} 题`;
  document.querySelector("#singleRatio").textContent = percent((stats.type_counts.single_choice || 0) / total);
  document.querySelector("#trueFalseRatio").textContent = percent((stats.type_counts.true_false || 0) / total);
  document.querySelector("#sourceCount").textContent = Object.keys(stats.source_counts).length;
  document.querySelector("#questionCount").max = total;

  const sourceSelect = document.querySelector("#sourceSelect");
  Object.entries(stats.source_counts).forEach(([source, count]) => {
    const option = document.createElement("option");
    option.value = source;
    option.textContent = `${source}（${count} 题）`;
    sourceSelect.append(option);
  });
  const serviceState = document.querySelector("#serviceState");
  serviceState.classList.add("online");
  serviceState.querySelector("span:last-child").textContent = "题库服务已连接";
}

function renderQuestion(question) {
  const card = document.createElement("article");
  card.className = "question-card";
  card.dataset.questionId = question.id;

  const meta = document.createElement("div");
  meta.className = "question-meta";
  const number = document.createElement("span");
  number.className = "question-number";
  number.textContent = `QUESTION ${String(question.index).padStart(2, "0")}`;
  const badge = document.createElement("span");
  badge.className = "question-type";
  badge.textContent = typeLabel(question.type);
  meta.append(number, badge);

  const stem = document.createElement("pre");
  stem.className = "question-stem";
  stem.textContent = question.stem;

  const optionList = document.createElement("div");
  optionList.className = "option-list";
  const options = question.type === "true_false"
    ? [{ key: "true", text: "正确" }, { key: "false", text: "错误" }]
    : question.options;
  options.forEach((option) => {
    const label = document.createElement("label");
    label.className = "option-label";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `answer-${question.id}`;
    input.value = option.key;
    input.addEventListener("change", () => recordAnswer(question.id));
    const key = document.createElement("span");
    key.className = "option-key";
    key.textContent = question.type === "true_false" ? (option.key === "true" ? "✓" : "×") : option.key;
    const text = document.createElement("span");
    text.className = "option-text";
    text.textContent = option.text;
    label.append(input, key, text);
    optionList.append(label);
  });

  card.append(meta, stem, optionList);
  return card;
}

function renderTest(testSet) {
  state.testSet = testSet;
  state.answerLatencies = new Map();
  document.querySelector("#runId").textContent = `${testSet.id} · seed ${testSet.config.seed}`;
  const list = document.querySelector("#questionList");
  list.replaceChildren(...testSet.questions.map(renderQuestion));
  updateProgress();
  state.startedAt = Date.now();
  state.lastAnswerAt = state.startedAt;
  clearInterval(state.timerHandle);
  state.timerHandle = window.setInterval(() => {
    document.querySelector("#timer").textContent = formatDuration(Date.now() - state.startedAt);
  }, 500);
  showView("test");
}

function recordAnswer(questionId) {
  const now = Date.now();
  if (!state.answerLatencies.has(questionId)) {
    state.answerLatencies.set(questionId, now - state.lastAnswerAt);
  }
  state.lastAnswerAt = now;
  updateProgress();
}

function updateProgress() {
  if (!state.testSet) return;
  const total = state.testSet.questions.length;
  const answered = state.testSet.questions.filter((question) =>
    document.querySelector(`input[name="answer-${question.id}"]:checked`)
  ).length;
  document.querySelector("#progressText").textContent = `${answered} / ${total}`;
  document.querySelector("#progressBar").style.width = `${(answered / total) * 100}%`;
  document.querySelector("#submitProgress").textContent = answered
    ? `已完成 ${answered} / ${total}`
    : "尚未作答";
}

function collectAnswers() {
  return state.testSet.questions.flatMap((question) => {
    const selected = document.querySelector(`input[name="answer-${question.id}"]:checked`);
    if (!selected) return [];
    const answer = question.type === "true_false" ? selected.value === "true" : selected.value;
    return [{
      question_id: question.id,
      answer,
      latency_ms: state.answerLatencies.get(question.id) ?? null,
    }];
  });
}

function renderResults(result) {
  state.result = result;
  document.querySelector("#resultId").textContent = `${result.id} · ${result.test_set_id}`;
  const summary = result.summary;
  const metrics = [
    ["准确率", percent(summary.accuracy)],
    ["答对", `${summary.correct} / ${summary.total}`],
    ["总用时", formatDuration(summary.total_latency_ms || 0)],
    ["单题 P95", summary.latency.p95_ms == null ? "—" : `${Math.round(summary.latency.p95_ms)} ms`],
  ];
  const scoreCards = document.querySelector("#scoreCards");
  scoreCards.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "score-card";
    const name = document.createElement("span");
    name.textContent = label;
    const score = document.createElement("strong");
    score.textContent = value;
    card.append(name, score);
    return card;
  }));
  renderResultList("all");
  showView("result");
}

function displayAnswer(answer, type) {
  if (answer == null) return "未作答";
  if (type === "true_false") return answer ? "正确" : "错误";
  return answer;
}

function renderResultList(filter) {
  const details = state.result.details.filter((detail) => filter !== "wrong" || !detail.is_correct);
  const nodes = details.map((detail) => {
    const item = document.createElement("article");
    item.className = `result-item ${detail.is_correct ? "correct" : "wrong"}`;
    const head = document.createElement("div");
    head.className = "result-item-head";
    const number = document.createElement("strong");
    number.textContent = `第 ${detail.index} 题 · ${typeLabel(detail.type)}`;
    const status = document.createElement("span");
    status.className = "result-status";
    status.textContent = detail.is_correct ? "回答正确" : "回答错误";
    head.append(number, status);
    const stem = document.createElement("p");
    stem.textContent = detail.stem;
    const comparison = document.createElement("div");
    comparison.className = "answer-comparison";
    const yours = document.createElement("span");
    const correct = document.createElement("span");
    yours.append("你的答案：", Object.assign(document.createElement("strong"), { textContent: displayAnswer(detail.submitted_answer, detail.type) }));
    correct.append("标准答案：", Object.assign(document.createElement("strong"), { textContent: displayAnswer(detail.correct_answer, detail.type) }));
    comparison.append(yours, correct);
    item.append(head, stem, comparison);
    return item;
  });
  const list = document.querySelector("#resultList");
  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.textContent = "没有符合当前筛选条件的题目。";
    empty.style.color = "var(--muted)";
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...nodes);
  }
}

document.querySelector("#testConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector("button[type=submit]");
  const types = [
    document.querySelector("#typeSingle").checked ? "single_choice" : null,
    document.querySelector("#typeTrueFalse").checked ? "true_false" : null,
  ].filter(Boolean);
  if (!types.length) return showToast("请至少选择一种题型");
  const source = document.querySelector("#sourceSelect").value;
  const seed = document.querySelector("#seed").value;
  const payload = {
    types,
    count: Number(document.querySelector("#questionCount").value),
    sources: source ? [source] : [],
    ...(seed ? { seed: Number(seed) } : {}),
  };
  submitButton.disabled = true;
  try {
    renderTest(await api("/api/v1/test-sets", { method: "POST", body: JSON.stringify(payload) }));
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#answerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector("button[type=submit]");
  submitButton.disabled = true;
  clearInterval(state.timerHandle);
  const totalLatency = Date.now() - state.startedAt;
  try {
    const result = await api("/api/v1/submissions", {
      method: "POST",
      body: JSON.stringify({
        test_set_id: state.testSet.id,
        answers: collectAnswers(),
        total_latency_ms: totalLatency,
        client: { kind: "web-ui", name: "CyberWikiBench GUI" },
      }),
    });
    renderResults(result);
  } catch (error) {
    showToast(error.message);
    state.timerHandle = window.setInterval(() => {
      document.querySelector("#timer").textContent = formatDuration(Date.now() - state.startedAt);
    }, 500);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#newRunButton").addEventListener("click", () => {
  state.testSet = null;
  state.result = null;
  showView("setup");
});

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter-button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderResultList(button.dataset.filter);
  });
});

loadStats().catch((error) => {
  document.querySelector("#serviceState span:last-child").textContent = "题库服务连接失败";
  showToast(error.message);
});
