/*
 * CyberWikiBench content script.
 *
 * This file deliberately has no imports or build-time dependencies.  It can be
 * declared in the manifest and it can also be injected with chrome.scripting.
 * The global guard below makes a second injection a no-op instead of installing
 * duplicate message and DOM listeners.
 */
(() => {
  "use strict";

  const GLOBAL_KEY = "__CWKB_CONTENT_SCRIPT_V1__";
  if (globalThis[GLOBAL_KEY]) {
    return;
  }

  const state = {
    installed: false,
    lastHoveredRoot: null,
    lastExtraction: new Map(),
    generatedId: 0,
  };

  Object.defineProperty(globalThis, GLOBAL_KEY, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const QUESTION_ROOT_SELECTOR = [
    "[data-question-id]",
    "[data-questionid]",
    "[data-quiz-question]",
    "[data-question]",
    ".question-card",
    ".question",
    "[class*='question-card']",
    "[data-testid*='question']",
    "fieldset",
  ].join(",");

  const OPTION_SELECTOR = [
    "[data-option-key]",
    "[data-option]",
    "[data-answer]",
    ".option-label",
    ".option",
    "[class*='option-label']",
    "[role='radio']",
    "label",
  ].join(",");

  const STEM_SELECTOR = [
    "[data-question-stem]",
    "[data-stem]",
    ".question-stem",
    ".question-text",
    ".question-title",
    ".question-content",
    ".stem",
    ".prompt",
    ".problem",
    "[class*='question-stem']",
    "[data-testid*='stem']",
  ].join(",");

  const ANSWER_ATTRIBUTE_NAMES = [
    "data-option-key",
    "data-key",
    "data-value",
    "data-answer",
    "data-option",
  ];

  const BOOLEAN_TRUE = new Set([
    "true", "正确", "是", "对", "√", "yes", "y", "t", "1",
  ]);
  const BOOLEAN_FALSE = new Set([
    "false", "错误", "否", "错", "×", "x", "no", "n", "f", "0",
  ]);

  /**
   * Preserve meaningful visual line breaks, especially in <pre> command
   * output, while removing indentation introduced only by HTML formatting.
   */
  function textWithLineBreaks(element) {
    if (!element) return "";
    const raw = typeof element.innerText === "string"
      ? element.innerText
      : element.textContent || "";
    return normalizeDisplayText(raw);
  }

  function normalizeDisplayText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function canonicalText(value) {
    return normalizeDisplayText(value)
      .toLocaleLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[()（）\[\]【】.．、:：;；,，'"`~!！?？]/g, "");
  }

  function canonicalAnswer(value) {
    if (typeof value === "boolean") return value ? "true" : "false";
    const compact = canonicalText(value);
    if (BOOLEAN_TRUE.has(compact)) return "true";
    if (BOOLEAN_FALSE.has(compact)) return "false";
    return compact.toUpperCase();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    // Do not depend on getClientRects(): it is zero in some otherwise valid
    // offscreen/test DOMs, while the question may still be the one the user
    // asked the extension to solve.  Ancestor styles reliably exclude truly
    // hidden template content.
    for (let current = element; current instanceof Element; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
    }
    return true;
  }

  function attrValue(element, names) {
    for (const name of names) {
      const value = element?.getAttribute?.(name);
      if (value && value.trim()) return value.trim();
    }
    return "";
  }

  function getQuestionDomId(root) {
    return attrValue(root, [
      "data-question-id",
      "data-questionid",
      "data-quiz-question",
      "data-question",
      "data-id",
      "id",
    ]);
  }

  function getOptionElement(input) {
    if (!input) return null;
    const closestLabel = input.closest("label");
    if (closestLabel) return closestLabel;
    if (input.labels?.length) return input.labels[0];

    if (input.id) {
      for (const label of document.querySelectorAll("label[for]")) {
        if (label.htmlFor === input.id) return label;
      }
    }

    return input.closest("[role='radio'], [data-option-key], [data-option], .option, .option-label, [class*='option'], li") || input;
  }

  function optionKeyFromText(text) {
    const match = normalizeDisplayText(text).match(
      /^\s*(?:[（(]\s*)?([A-Ha-h]|[1-9])(?:\s*[）).．、:：\-]|\s*\n|\s{2,})/
    );
    return match ? match[1].toUpperCase() : "";
  }

  function stripOptionPrefix(text, key) {
    const source = normalizeDisplayText(text);
    if (!key) return source;

    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = new RegExp(
      `^\\s*(?:[（(]\\s*)?${escaped}(?:\\s*[）).．、:：\\-]\\s*|\\s+|\\n+)`,
      "i"
    );
    const stripped = source.replace(prefix, "");
    return stripped || source;
  }

  function normalizeOptionKey(rawKey, fallbackIndex) {
    const key = String(rawKey || "").trim();
    const compact = canonicalAnswer(key);
    if (compact === "true" || compact === "false") return compact;

    const letter = key.match(/^\s*[（(]?\s*([A-Ha-h])\s*[）).．、:]?\s*$/);
    if (letter) return letter[1].toUpperCase();

    const number = key.match(/^\s*([1-9])\s*[）).．、:]?\s*$/);
    if (number) return number[1];

    if (key && key.toLowerCase() !== "on") return key;
    return String.fromCharCode(65 + fallbackIndex);
  }

  function booleanValue(value) {
    const compact = canonicalText(value);
    if (BOOLEAN_TRUE.has(compact)) return true;
    if (BOOLEAN_FALSE.has(compact)) return false;
    return null;
  }

  function elementOptionKey(element, input, text, index) {
    const elementKey = attrValue(element, ANSWER_ATTRIBUTE_NAMES);
    const inputKey = attrValue(input, ANSWER_ATTRIBUTE_NAMES);
    const explicit = elementKey || inputKey || input?.value || "";
    return normalizeOptionKey(explicit || optionKeyFromText(text), index);
  }

  function textForOptionElement(element, input) {
    if (!element || element === input) {
      return normalizeDisplayText(input?.getAttribute("aria-label") || input?.value || "");
    }

    const textNode = element.querySelector?.(
      "[data-option-text], .option-text, [class*='option-text'], [class*='answer-text']"
    );
    if (textNode) return textWithLineBreaks(textNode);
    return textWithLineBreaks(element);
  }

  function extractOption(input, index) {
    const element = getOptionElement(input);
    const rawText = textForOptionElement(element, input);
    const key = elementOptionKey(element, input, rawText, index);
    const text = stripOptionPrefix(rawText, key);
    return {
      key,
      text,
      _element: element,
      _input: input,
      _rawKey: key,
    };
  }

  function makeUniqueOptionKeys(options) {
    const used = new Set();
    return options.map((option, index) => {
      let key = String(option.key || "");
      if (!key || used.has(key)) {
        let candidate = String.fromCharCode(65 + index);
        let suffix = 2;
        while (used.has(candidate)) candidate = `${String.fromCharCode(65 + index)}-${suffix++}`;
        key = candidate;
      }
      used.add(key);
      return { ...option, key };
    });
  }

  function inferQuestionType(options) {
    if (options.length !== 2) return "single_choice";
    const values = options.map((option) => {
      const keyValue = booleanValue(option.key);
      return keyValue === null ? booleanValue(option.text) : keyValue;
    });
    return values.includes(true) && values.includes(false) ? "true_false" : "single_choice";
  }

  function normalizeBooleanOptions(options) {
    const seen = new Set();
    return options.map((option) => {
      const fromKey = booleanValue(option.key);
      const fromText = booleanValue(option.text);
      const value = fromKey === null ? fromText : fromKey;
      let key = value === true ? "true" : value === false ? "false" : option.key;
      if (seen.has(key)) key = option.key;
      seen.add(key);
      return { ...option, key };
    });
  }

  function groupRadioInputs() {
    const groups = new Map();
    const formIds = new WeakMap();
    const rootIds = new WeakMap();
    let formIndex = 0;
    let rootIndex = 0;

    for (const input of document.querySelectorAll("input[type='radio']")) {
      // Design systems commonly hide the native radio and render its <label>
      // as the visible choice.  Do not discard those usable controls merely
      // because the input itself is visually hidden.
      if (input.disabled || (!isVisible(input) && !isVisible(getOptionElement(input)))) continue;
      const form = input.form || input.closest("form");
      if (form && !formIds.has(form)) formIds.set(form, ++formIndex);
      const root = input.closest(QUESTION_ROOT_SELECTOR);
      if (root && !rootIds.has(root)) rootIds.set(root, ++rootIndex);
      // Names are the normal grouping mechanism.  Scope them to a question
      // container when available because some poorly-authored quiz pages reuse
      // the same name for every question.
      const rootHint = root ? `root-${rootIds.get(root)}` : "page";
      const groupName = input.name || "unnamed";
      const key = `${form ? formIds.get(form) : "page"}::${rootHint}::${groupName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(input);
    }

    return [...groups.values()].filter((inputs) => inputs.length >= 2);
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    let candidate = elements[0];
    while (candidate && !elements.every((element) => candidate.contains(element))) {
      candidate = candidate.parentElement;
    }
    return candidate || document.body;
  }

  function questionContainerForInputs(inputs) {
    const explicit = inputs[0]?.closest(QUESTION_ROOT_SELECTOR);
    if (explicit && inputs.every((input) => explicit.contains(input))) return explicit;

    const common = lowestCommonAncestor(inputs);
    const semantic = common?.closest("fieldset, li, article, section, [role='group'], div");
    return semantic || common || document.body;
  }

  function getStemElement(root) {
    if (!root?.querySelector) return null;
    const candidates = [...root.querySelectorAll(STEM_SELECTOR)];
    return candidates.find((candidate) => isVisible(candidate) && textWithLineBreaks(candidate)) || null;
  }

  function stemWithoutOptions(root, optionElements) {
    if (!root) return "";
    const clone = root.cloneNode(true);
    const removable = new Set();

    for (const element of optionElements) {
      if (!element) continue;
      const path = [];
      let current = element;
      while (current && current !== root) {
        path.push(current);
        current = current.parentElement;
      }
      const original = path[path.length - 1] || element;
      if (original && original !== root) removable.add(original);
    }

    // Remove known option/control elements.  The clone avoids mutating the page.
    for (const selector of ["input", "label", "[role='radio']", ".option", ".option-label", "[class*='option']"]) {
      for (const element of clone.querySelectorAll(selector)) removable.add(element);
    }
    for (const element of removable) {
      // An element cloned above can be unrelated to the cloned root; guard it.
      if (element instanceof Element && clone.contains(element)) element.remove();
    }
    return textWithLineBreaks(clone);
  }

  function stemForQuestion(root, options) {
    const directStem = getStemElement(root);
    if (directStem) return textWithLineBreaks(directStem);
    const stem = stemWithoutOptions(root, options.map((option) => option._element));
    return stem.replace(/^\s*(?:question|题目)\s*\d+\s*[:：#.-]?\s*/i, "").trim();
  }

  function makeQuestionId(root, inputs, index) {
    const fromRoot = getQuestionDomId(root);
    if (fromRoot) return fromRoot;
    const fromInput = inputs[0]?.getAttribute("data-question-id") || inputs[0]?.name;
    if (fromInput) return fromInput;
    state.generatedId += 1;
    return `page-question-${index + 1}-${state.generatedId}`;
  }

  function publicQuestion(question) {
    return {
      id: question.id,
      type: question.type,
      stem: question.stem,
      options: question.options.map(({ key, text }) => ({ key, text })),
      sourceUrl: location.href,
      pageAdapter: "generic-choice",
    };
  }

  function questionFromRadioGroup(inputs, index) {
    const root = questionContainerForInputs(inputs);
    let options = makeUniqueOptionKeys(inputs.map((input, optionIndex) => extractOption(input, optionIndex)));
    if (options.some((option) => !option.text)) return null;
    const type = inferQuestionType(options);
    if (type === "true_false") options = normalizeBooleanOptions(options);

    const stem = stemForQuestion(root, options);
    if (!stem) return null;
    return {
      id: makeQuestionId(root, inputs, index),
      type,
      stem,
      options,
      _root: root,
    };
  }

  function candidateOptions(root) {
    const candidates = [];
    for (const element of root.querySelectorAll(OPTION_SELECTOR)) {
      if (!isVisible(element)) continue;
      if (element.matches("label") && element.querySelector("input[type='radio']")) continue;
      const text = textWithLineBreaks(element);
      if (!text) continue;
      const hasExplicitKey = Boolean(attrValue(element, ANSWER_ATTRIBUTE_NAMES));
      const hasLeadingKey = Boolean(optionKeyFromText(text));
      if (!hasExplicitKey && !hasLeadingKey && !element.matches(".option-label, .option, [role='radio']")) continue;
      candidates.push(element);
    }

    const filtered = candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
    return filtered.map((element, index) => {
      const text = textForOptionElement(element, null);
      const key = elementOptionKey(element, null, text, index);
      return { key, text: stripOptionPrefix(text, key), _element: element, _input: null };
    });
  }

  function questionFromCard(root, index) {
    // Native radios are handled by groupRadioInputs(), which retains the link
    // needed for safe filling.  This fallback is only for custom labelled
    // option buttons without a native input.
    if (root.querySelector("input[type='radio']")) return null;
    const options = makeUniqueOptionKeys(candidateOptions(root));
    if (options.length < 2) return null;
    const type = inferQuestionType(options);
    const normalizedOptions = type === "true_false" ? normalizeBooleanOptions(options) : options;
    const stem = stemForQuestion(root, normalizedOptions);
    if (!stem) return null;
    return {
      id: makeQuestionId(root, [], index),
      type,
      stem,
      options: normalizedOptions,
      _root: root,
    };
  }

  function sameRadioSet(left, right) {
    const leftInputs = new Set(left.options.map((option) => option._input).filter(Boolean));
    const rightInputs = new Set(right.options.map((option) => option._input).filter(Boolean));
    if (!leftInputs.size || leftInputs.size !== rightInputs.size) return false;
    return [...leftInputs].every((input) => rightInputs.has(input));
  }

  function extractAllQuestions() {
    const extracted = [];
    const radioGroups = groupRadioInputs();
    radioGroups.forEach((inputs, index) => {
      const question = questionFromRadioGroup(inputs, index);
      if (question) extracted.push(question);
    });

    // Support pages that render labelled option buttons without native radios.
    let cardIndex = extracted.length;
    for (const root of document.querySelectorAll(QUESTION_ROOT_SELECTOR)) {
      if (!isVisible(root)) continue;
      const question = questionFromCard(root, cardIndex++);
      if (!question) continue;
      if (extracted.some((existing) => existing.id === question.id || sameRadioSet(existing, question))) continue;
      extracted.push(question);
    }

    // IDs are normally supplied by data-question-id.  Make generated/duplicate
    // IDs stable and unambiguous within this extraction response.
    const occurrences = new Map();
    for (const question of extracted) {
      const count = occurrences.get(question.id) || 0;
      occurrences.set(question.id, count + 1);
      if (count) question.id = `${question.id}-${count + 1}`;
    }

    state.lastExtraction.clear();
    for (const question of extracted) state.lastExtraction.set(question.id, question);
    return extracted;
  }

  function activeQuestion(questions, requestedId) {
    if (requestedId) {
      const id = String(requestedId);
      const exact = questions.find((question) => question.id === id);
      if (exact) return exact;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof Element) {
      const focused = questions.find((question) => question._root?.contains(activeElement));
      if (focused) return focused;
    }

    if (state.lastHoveredRoot) {
      const hovered = questions.find((question) => question._root === state.lastHoveredRoot || question._root?.contains(state.lastHoveredRoot));
      if (hovered) return hovered;
    }

    const visible = [...questions]
      .filter((question) => question._root?.getBoundingClientRect)
      .sort((left, right) => {
        const leftDistance = Math.abs(left._root.getBoundingClientRect().top);
        const rightDistance = Math.abs(right._root.getBoundingClientRect().top);
        return leftDistance - rightDistance;
      });
    return visible[0] || questions[0] || null;
  }

  function pageResult(payload = {}) {
    const questions = extractAllQuestions();
    const current = activeQuestion(questions, payload.questionId || payload.id);
    return {
      questions: questions.map(publicQuestion),
      question: current ? publicQuestion(current) : null,
      count: questions.length,
      url: location.href,
      title: document.title,
    };
  }

  function descriptorForQuestion(questionId) {
    if (questionId && state.lastExtraction.has(String(questionId))) {
      return state.lastExtraction.get(String(questionId));
    }
    const questions = extractAllQuestions();
    return activeQuestion(questions, questionId);
  }

  function nativeSetChecked(input, checked) {
    const prototype = input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(prototype, "checked")?.set;
    if (setter) setter.call(input, checked);
    else input.checked = checked;
  }

  function dispatchValueEvents(input) {
    // Setting a radio directly does not notify React/Vue or ordinary page code.
    // These events are deliberately limited to the input; this script never
    // clicks a submit control or invokes form.submit()/requestSubmit().
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillAnswer(payload = {}) {
    const answer = payload.answer ?? payload.value ?? payload.optionKey;
    if (answer === undefined || answer === null || answer === "") {
      throw new Error("FILL_ANSWER requires payload.answer.");
    }

    const question = descriptorForQuestion(payload.questionId || payload.id);
    if (!question) throw new Error("Question not found on the current page.");

    const wanted = canonicalAnswer(answer);
    const option = question.options.find((candidate) =>
      canonicalAnswer(candidate.key) === wanted ||
      canonicalAnswer(candidate.text) === wanted
    );
    if (!option) {
      throw new Error(`Answer '${String(answer)}' is not one of the extracted options.`);
    }

    const input = option._input || option._element?.querySelector?.("input[type='radio'], input[type='checkbox']");
    if (!input) {
      throw new Error("The selected option has no native input to fill safely.");
    }
    if (input.disabled) throw new Error("The selected option is disabled.");

    const form = input.form || input.closest("form");
    const preventSyntheticSubmit = (event) => {
      if (!event.isTrusted) event.preventDefault();
    };
    form?.addEventListener("submit", preventSyntheticSubmit, true);
    try {
      nativeSetChecked(input, true);
      dispatchValueEvents(input);
    } finally {
      form?.removeEventListener("submit", preventSyntheticSubmit, true);
    }

    return {
      questionId: question.id,
      answer: option.key,
      type: question.type,
      filled: Boolean(input.checked),
      submitted: false,
    };
  }

  function messageType(message) {
    return String(message?.type || "").trim();
  }

  function respond(sendResponse, callback) {
    try {
      sendResponse({ ok: true, data: callback() });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = messageType(message);
    const payload = message?.payload || {};

    if (type === "EXTRACT_CURRENT_QUESTION") {
      respond(sendResponse, () => pageResult(payload));
      return false;
    }
    if (type === "CWKB_EXTRACT_PAGE") {
      respond(sendResponse, () => pageResult(payload));
      return false;
    }
    if (type === "FILL_ANSWER" || type === "CWKB_FILL_ANSWER") {
      respond(sendResponse, () => fillAnswer(payload));
      return false;
    }
    return undefined;
  });

  document.addEventListener("mouseover", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(QUESTION_ROOT_SELECTOR);
    if (root) state.lastHoveredRoot = root;
  }, true);

  state.installed = true;
})();
