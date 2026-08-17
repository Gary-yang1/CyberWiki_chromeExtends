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
  };

  Object.defineProperty(globalThis, GLOBAL_KEY, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const heuristics = globalThis.__CWKB_QUESTION_HEURISTICS_V1__;
  if (!heuristics) {
    throw new Error("Question heuristics must be injected before the content script.");
  }

  const QUESTION_ROOT_SELECTOR = [
    "[data-question-id]",
    "[data-questionid]",
    "[data-quiz-question]",
    "[data-question]",
    ".question-card",
    ".question",
    "[class*='question-card']",
    "[data-testid*='question']",
    // 问卷星的题目通常是 #divQuestion 下带 field / ui-field-contain 的卡片。
    // 保持容器范围，避免把其他网页普通表单的 .field 当作题目。
    "#divQuestion .field.ui-field-contain",
    "#divQuestion [topic][type]",
    "fieldset",
  ].join(",");

  const CONTROL_SELECTOR = [
    "input[type='radio']",
    "input[type='checkbox']",
    "[role='radio']",
    "[role='checkbox']",
  ].join(",");

  const TEXT_OPTION_CANDIDATE_SELECTOR = [
    "[data-option-key]",
    "[data-option]",
    "[data-answer]",
    ".option-label",
    ".option",
    ".answer-option",
    "[class*='option-label']",
    "[class*='answer-option']",
    "[role='option']",
    "label",
    "li",
    "button",
    "p",
    "div",
  ].join(",");

  const STEM_SELECTOR = [
    "[data-question-stem]",
    "[data-stem]",
    ".question-stem",
    ".question-text",
    ".question-title",
    ".question-content",
    ".field-label",
    ".topichtml",
    ".topictext",
    ".topic_title",
    ".topic-title",
    "[id^='divTitle']",
    "[class*='topic-text']",
    "[class*='topic-title']",
    ".stem",
    ".prompt",
    ".problem",
    "legend",
    "[role='heading']",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
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
    return heuristics.normalizeDisplayText(value);
  }

  function canonicalText(value) {
    return heuristics.canonicalText(value);
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
    for (let current = element; current instanceof Element; current = composedParent(current)) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
    }
    return true;
  }

  function composedParent(element) {
    if (!(element instanceof Element)) return null;
    return element.parentElement || element.getRootNode?.()?.host || null;
  }

  function closestComposed(element, selector) {
    for (let current = element; current instanceof Element; current = composedParent(current)) {
      if (current.matches(selector)) return current;
    }
    return null;
  }

  function composedContains(container, element) {
    for (let current = element; current instanceof Element; current = composedParent(current)) {
      if (current === container) return true;
    }
    return false;
  }

  function searchRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && element.shadowRoot.mode === "open") roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function queryAll(selector) {
    const seen = new Set();
    const matches = [];
    for (const root of searchRoots()) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        matches.push(element);
      }
    }
    return matches;
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
    const closestLabel = closestComposed(input, "label");
    if (closestLabel) return closestLabel;
    if (input.labels?.length) return input.labels[0];

    if (input.id) {
      for (const label of queryAll("label[for]")) {
        if (label.htmlFor === input.id) return label;
      }
    }

    return closestComposed(input, "[role='radio'], [role='checkbox'], [data-option-key], [data-option], .option, .option-label, [class*='option'], li") || input;
  }

  function optionKeyFromText(text) {
    return heuristics.optionKeyFromText(text);
  }

  function stripOptionPrefix(text, key) {
    return heuristics.stripOptionPrefix(text, key);
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
    return heuristics.booleanValue(value);
  }

  function elementOptionKey(element, input, text, index) {
    const elementKey = attrValue(element, ANSWER_ATTRIBUTE_NAMES);
    const inputKey = attrValue(input, ANSWER_ATTRIBUTE_NAMES);
    const explicit = elementKey || inputKey || optionKeyFromText(text) || input?.value || "";
    return normalizeOptionKey(explicit, index);
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
      _controlKind: input.type === "checkbox" ? "checkbox" : "radio",
      _explicitOption: true,
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

  function inferQuestionType(options, group, root) {
    return heuristics.inferQuestionType({
      options,
      controlKinds: group.controlKinds,
      rootText: textWithLineBreaks(root),
    });
  }

  function normalizeBooleanOptions(options) {
    const seen = new Set();
    return options.map((option) => {
      const fromText = booleanValue(option.text);
      const fromKey = booleanValue(option.key);
      const value = fromText === null ? fromKey : fromText;
      let key = value === true ? "true" : value === false ? "false" : option.key;
      if (seen.has(key)) key = option.key;
      seen.add(key);
      return { ...option, key };
    });
  }

  const nodeIds = new WeakMap();
  let nextNodeId = 0;

  function nodeId(node) {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return "none";
    if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId);
    return String(nodeIds.get(node));
  }

  function explicitQuestionRoot(element) {
    return closestComposed(element, QUESTION_ROOT_SELECTOR);
  }

  function nearestChoiceContainer(element) {
    return closestComposed(element, [
      "fieldset",
      "[role='radiogroup']",
      "[role='group']",
      ".options",
      ".answers",
      ".choices",
      ".ui-controlgroup",
      "ul",
      "ol",
    ].join(",")) || composedParent(getOptionElement(element) || element);
  }

  function discoverNativeGroups() {
    const records = queryAll("input[type='radio'], input[type='checkbox']")
      .filter((input) => !input.disabled && (isVisible(input) || isVisible(getOptionElement(input))))
      .map((input) => {
        const root = explicitQuestionRoot(input);
        const form = input.form || closestComposed(input, "form");
        const choiceContainer = nearestChoiceContainer(input);
        const container = root || choiceContainer || form || composedParent(input);
        const scope = root || form || container;
        const kind = input.type === "checkbox" ? "checkbox" : "radio";
        const name = String(input.name || "").trim();
        return { input, root, form, container, choiceContainer, scope, kind, name };
      });
    const nameCounts = new Map();
    for (const record of records) {
      if (!record.name) continue;
      const key = `${nodeId(record.scope)}::${record.kind}::${record.name}`;
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    const groups = new Map();
    for (const record of records) {
      const namedKey = `${nodeId(record.scope)}::${record.kind}::${record.name}`;
      const useName = record.name && (nameCounts.get(namedKey) || 0) >= 2;
      const key = useName
        ? `native-name::${namedKey}`
        : `native-container::${nodeId(record.container)}::${record.kind}`;
      if (!groups.has(key)) {
        groups.set(key, {
          source: "native",
          elements: [],
          inputs: [],
          controlKinds: [record.kind],
          explicitRoot: record.root,
          optionContainer: record.choiceContainer || record.root || record.container,
          explicitOptions: true,
        });
      }
      const group = groups.get(key);
      group.elements.push(record.input);
      group.inputs.push(record.input);
    }
    return [...groups.values()].filter((group) => group.elements.length >= 2 && group.elements.length <= 20);
  }

  function smallestContainerWithPeers(element, peers) {
    for (let current = composedParent(element), depth = 0;
      current instanceof Element && depth < 7;
      current = composedParent(current), depth += 1) {
      const contained = peers.filter((peer) => composedContains(current, peer));
      if (contained.length >= 2 && contained.length <= 12) return current;
    }
    return null;
  }

  function discoverAriaGroups() {
    const controls = queryAll("[role='radio'], [role='checkbox']")
      .filter((element) => isVisible(element) && !element.matches("input"))
      .filter((element) => !element.querySelector("input[type='radio'], input[type='checkbox']"));
    const groups = new Map();
    for (const element of controls) {
      const kind = element.getAttribute("role") === "checkbox" ? "aria-checkbox" : "aria-radio";
      const sameKind = controls.filter((peer) => peer.getAttribute("role") === element.getAttribute("role"));
      const root = explicitQuestionRoot(element);
      const choiceContainer = closestComposed(element, "[role='radiogroup'], [role='group'], fieldset, ul, ol")
        || smallestContainerWithPeers(element, sameKind);
      const container = root || choiceContainer;
      if (!container) continue;
      const key = `aria::${nodeId(container)}::${kind}`;
      if (!groups.has(key)) {
        groups.set(key, {
          source: "aria",
          elements: [],
          inputs: [],
          controlKinds: [kind],
          explicitRoot: root,
          optionContainer: choiceContainer || root,
          explicitOptions: true,
        });
      }
      groups.get(key).elements.push(element);
    }
    return [...groups.values()].filter((group) => group.elements.length >= 2 && group.elements.length <= 12);
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    for (let candidate = elements[0]; candidate instanceof Element; candidate = composedParent(candidate)) {
      if (elements.every((element) => composedContains(candidate, element))) return candidate;
    }
    return null;
  }

  function optionFromElement(element, index, controlKind = "text") {
    const rawText = textForOptionElement(element, null);
    const parsed = heuristics.parseOptionText(rawText);
    const explicit = attrValue(element, ANSWER_ATTRIBUTE_NAMES);
    const boolean = booleanValue(rawText);
    const rawKey = explicit || parsed?.key || (boolean === true ? "true" : boolean === false ? "false" : "");
    const key = normalizeOptionKey(rawKey, index);
    return {
      key,
      text: parsed?.text || stripOptionPrefix(rawText, key),
      _element: element,
      _input: null,
      _rawKey: rawKey,
      _controlKind: controlKind,
      _explicitOption: Boolean(explicit || element.matches(".option, .option-label, .answer-option, [role='option'], [data-option], [data-answer]")),
    };
  }

  function discoverTextCandidates() {
    const candidates = [];
    for (const element of queryAll(TEXT_OPTION_CANDIDATE_SELECTOR)) {
      if (!isVisible(element) || element.matches("[role='radio'], [role='checkbox']")) continue;
      if (element.matches("div") && element.children.length > 8) continue;
      if (element.querySelector(CONTROL_SELECTOR)) continue;
      if (element.matches("label") && element.control?.matches?.("input[type='radio'], input[type='checkbox']")) continue;
      const rawText = textWithLineBreaks(element);
      if (!rawText || rawText.length > 600) continue;
      const parsed = heuristics.parseOptionText(rawText);
      const explicit = Boolean(attrValue(element, ANSWER_ATTRIBUTE_NAMES))
        || element.matches(".option, .option-label, .answer-option, [role='option'], [data-option], [data-answer]");
      if (!parsed && !explicit) continue;
      const option = optionFromElement(element, candidates.length, "text");
      if (!option.text || option.text.length > 500) continue;
      candidates.push({ element, option, explicit });
    }

    return candidates.filter((candidate) => !candidates.some((other) => {
      if (candidate === other || !composedContains(candidate.element, other.element)) return false;
      return !candidate.explicit || other.explicit;
    }));
  }

  function sortInDocumentOrder(items) {
    return [...items].sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition?.(right) || 0;
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function discoverTextGroups() {
    const candidates = discoverTextCandidates();
    const groups = new Map();
    for (const candidate of candidates) {
      const root = explicitQuestionRoot(candidate.element);
      const optionContainer = smallestContainerWithPeers(candidate.element, candidates.map((item) => item.element));
      const container = root || optionContainer;
      if (!container) continue;
      const key = `text::${nodeId(container)}`;
      if (!groups.has(key)) groups.set(key, { container, root, optionContainer, candidates: [] });
      groups.get(key).candidates.push(candidate);
    }

    const results = [];
    for (const { container, root, optionContainer, candidates: grouped } of groups.values()) {
      const orderedElements = sortInDocumentOrder(grouped.map((item) => item.element));
      const ordered = orderedElements.map((element) => grouped.find((item) => item.element === element));
      const rawOptions = ordered.map((item, index) => ({ ...item.option, key: normalizeOptionKey(item.option._rawKey, index) }));
      const sequential = Boolean(heuristics.keySequenceKind(rawOptions.map((option) => option.key)));
      const runs = sequential || grouped.every((item) => item.explicit)
        ? [rawOptions]
        : heuristics.splitSequentialRuns(rawOptions);
      for (const options of runs) {
        if (options.length < 2 || options.length > 12) continue;
        results.push({
          source: "text",
          elements: options.map((option) => option._element),
          inputs: [],
          options,
          controlKinds: ["text"],
          explicitRoot: root,
          optionContainer: optionContainer || container,
          explicitOptions: options.some((option) => option._explicitOption),
        });
      }
    }
    return results;
  }

  function cleanStemText(value) {
    return normalizeDisplayText(value)
      .replace(/^\s*(?:question|题目)\s*\d+\s*[:：#.-]?\s*/i, "")
      .replace(/^\s*\d{1,4}\s*[.．、:：]\s*/, "")
      .replace(/^\s*(?:\[|【|\()?\s*(?:单选题|多选题|判断题)\s*(?:\]|】|\))?\s*/i, "")
      .trim();
  }

  function stemCandidateScore(element, text) {
    const cleaned = cleanStemText(text);
    if (!cleaned || /^[\d\s.．、:：*＊（()）-]+$/.test(cleaned)) return Number.NEGATIVE_INFINITY;
    let score = Math.min(cleaned.length, 500) / 25;
    const semanticHint = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    if (/stem|question|title|topic|prompt|problem|field-label|topichtml/i.test(semanticHint)) score += 8;
    if (element.matches("legend, [role='heading'], h1, h2, h3, h4, h5, h6")) score += 6;
    if (element.querySelector(CONTROL_SELECTOR)) score -= 12;
    if (heuristics.parseOptionText(cleaned)) score -= 10;
    return score;
  }

  function stemElementCandidates(root, optionElements = []) {
    if (!root?.querySelector) return [];
    return [...root.querySelectorAll(STEM_SELECTOR)]
      .filter((candidate) => isVisible(candidate)
        && textWithLineBreaks(candidate)
        && !optionElements.some((option) => composedContains(option, candidate) || candidate === option))
      .map((element) => ({ element, score: stemCandidateScore(element, textWithLineBreaks(element)) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score)
      .map((candidate) => candidate.element);
  }

  function precedingStemText(root, optionContainer, optionElements) {
    if (!(root instanceof Element) || !(optionContainer instanceof Element)) return "";
    for (let current = optionContainer, depth = 0;
      current instanceof Element && current !== root && depth < 5;
      current = composedParent(current), depth += 1) {
      const fragments = [];
      let sibling = current.previousElementSibling;
      for (let scanned = 0; sibling && scanned < 4; sibling = sibling.previousElementSibling, scanned += 1) {
        if (!isVisible(sibling)) continue;
        if (sibling.matches(CONTROL_SELECTOR) || sibling.querySelector(CONTROL_SELECTOR)) break;
        if (optionElements.some((option) => composedContains(sibling, option))) break;
        const text = cleanStemText(textWithLineBreaks(sibling));
        if (!text || heuristics.parseOptionText(text) || /^[*＊\d\s.．、:：-]+$/.test(text)) continue;
        fragments.unshift(text);
      }
      if (fragments.length) return fragments.join("\n");
    }
    return "";
  }

  function relativeChildPath(root, element) {
    const path = [];
    let current = element;
    while (current instanceof Element && current !== root) {
      const parent = current.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, current));
      current = parent;
    }
    return current === root ? path : null;
  }

  function resolveChildPath(root, path) {
    let current = root;
    for (const index of path || []) {
      current = current?.children?.[index];
      if (!current) return null;
    }
    return current;
  }

  function stemWithoutOptions(root, optionElements) {
    if (!root) return "";
    const clone = root.cloneNode(true);
    const paths = [];
    for (const element of optionElements) {
      if (!element) continue;
      const path = relativeChildPath(root, element);
      if (path) paths.push(path);
    }
    const clonedOptionElements = paths.map((path) => resolveChildPath(clone, path)).filter(Boolean);
    for (const element of clonedOptionElements) element.remove();
    for (const selector of [
      "input",
      "label",
      "[role='radio']",
      "[role='checkbox']",
      "[role='option']",
      ".option",
      ".option-label",
      ".answer-option",
      "[class*='option-label']",
      "[class*='answer-option']",
    ]) {
      for (const element of clone.querySelectorAll(selector)) element.remove();
    }
    return textWithLineBreaks(clone);
  }

  function isUsableStem(value, options) {
    const stem = cleanStemText(value);
    if (!stem || stem.length < 2) return false;
    const optionKeys = new Set(options.map((option) => canonicalAnswer(option.key)));
    const optionTexts = new Set(options.map((option) => canonicalText(option.text)).filter(Boolean));
    const lines = stem.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const lineIsOption = (line) => {
      const parsed = heuristics.parseOptionText(line);
      if (parsed && optionKeys.has(canonicalAnswer(parsed.key)) && optionTexts.has(canonicalText(parsed.text))) return true;
      return optionTexts.has(canonicalText(line));
    };
    if (lines.length && lines.every(lineIsOption)) return false;

    // Some layouts collapse all option rows onto one visual line. Remove the
    // known option texts; if only their short keys remain, this is not a stem.
    let residual = canonicalText(stem);
    let matchedOptionTexts = 0;
    for (const optionText of optionTexts) {
      if (optionText.length < 2 || !residual.includes(optionText)) continue;
      residual = residual.split(optionText).join("");
      matchedOptionTexts += 1;
    }
    if (matchedOptionTexts >= 2) {
      const keyCharacters = new Set([...optionKeys].join("").toLocaleLowerCase());
      const meaningfulResidual = [...residual].filter((character) => !keyCharacters.has(character)).join("");
      if (meaningfulResidual.length < 2) return false;
    }
    return true;
  }

  function stemForQuestion(root, options, optionContainer) {
    const optionElements = options.map((option) => option._element).filter(Boolean);
    for (const candidate of stemElementCandidates(root, optionElements)) {
      const text = cleanStemText(textWithLineBreaks(candidate));
      if (isUsableStem(text, options)) return { text, source: "semantic-element" };
    }
    const preceding = precedingStemText(root, optionContainer, optionElements);
    if (isUsableStem(preceding, options)) return { text: preceding, source: "preceding-structure" };
    const residual = cleanStemText(stemWithoutOptions(root, optionElements));
    if (isUsableStem(residual, options)) return { text: residual, source: "container-minus-options" };
    return { text: "", source: "none" };
  }

  function rootCandidatesForGroup(group) {
    const candidates = [];
    const explicit = group.explicitRoot;
    if (explicit && group.elements.every((element) => composedContains(explicit, element))) candidates.push(explicit);
    const common = lowestCommonAncestor(group.elements) || group.optionContainer;
    for (let current = common, depth = 0;
      current instanceof Element && depth < 8;
      current = composedParent(current), depth += 1) {
      if (!candidates.includes(current)) candidates.push(current);
      if (current === document.body || current === document.documentElement) break;
    }
    return candidates;
  }

  function locateQuestionRoot(group, options) {
    let best = null;
    const optionCount = options.length;
    for (const [depth, root] of rootCandidatesForGroup(group).entries()) {
      const stemResult = stemForQuestion(root, options, group.optionContainer);
      const stem = stemResult.text;
      const controlCount = root.querySelectorAll?.(CONTROL_SELECTOR).length || 0;
      const rootIsDocument = root === document.body || root === document.documentElement;
      const explicit = root.matches?.(QUESTION_ROOT_SELECTOR) || false;
      const semantic = root.matches?.("fieldset, article, section, li, [role='group'], [role='radiogroup']")
        || /question|quiz|problem|topic|prompt|exercise|field/i.test(String(root.className || ""));
      let score = stem ? 5 : -4;
      if (explicit) score += 5;
      if (semantic) score += 2;
      if (controlCount > Math.max(optionCount + 1, optionCount * 1.5)) score -= 4;
      if (stem.length > 4000) score -= 3;
      if (rootIsDocument) score -= 10;
      score -= depth * 0.08;
      if (!best || score > best.score) {
        best = { root, stem, stemSource: stemResult.source, score, controlCount, explicit, rootIsDocument };
      }
    }
    return best;
  }

  function makeQuestionId(root, inputs, index, stem = "") {
    const fromRoot = getQuestionDomId(root);
    if (fromRoot) return fromRoot;
    const fromInput = inputs[0]?.getAttribute("data-question-id") || inputs[0]?.name;
    if (fromInput) return fromInput;
    let hash = 2166136261;
    for (const character of stem.slice(0, 300)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `page-question-${index + 1}-${(hash >>> 0).toString(36)}`;
  }

  function publicQuestion(question) {
    return {
      id: question.id,
      type: question.type,
      stem: question.stem,
      options: question.options.map(({ key, text }) => ({ key, text })),
      sourceUrl: location.href,
      pageAdapter: "generic-semantic-choice",
      confidence: question.confidence,
      recognition: question.recognition,
    };
  }

  function questionFromGroup(group, index) {
    const rawOptions = group.options
      || group.elements.map((element, optionIndex) => group.source === "native"
        ? extractOption(element, optionIndex)
        : optionFromElement(element, optionIndex, group.controlKinds[0]));
    const duplicateKeys = new Set(rawOptions.map((option) => String(option.key))).size !== rawOptions.length;
    let options = makeUniqueOptionKeys(rawOptions);
    if (options.length < 2 || options.length > 12 || options.some((option) => !option.text)) return null;
    const located = locateQuestionRoot(group, options);
    if (!located?.root || !located.stem) return null;
    const type = inferQuestionType(options, group, located.root);
    if (type === "true_false") options = normalizeBooleanOptions(options);
    const sequenceKind = heuristics.keySequenceKind(options.map((option) => option.key));
    const assessment = heuristics.scoreQuestionCandidate({
      optionCount: options.length,
      hasStem: Boolean(located.stem),
      stemLength: located.stem.length,
      sequentialKeys: Boolean(sequenceKind),
      explicitOptions: group.explicitOptions,
      controlKinds: group.controlKinds,
      explicitRoot: located.explicit,
      rootIsDocument: located.rootIsDocument,
      duplicateKeys,
      mixedControlCount: located.controlCount,
    });
    if (!assessment.accepted) return null;
    return {
      id: makeQuestionId(located.root, group.inputs, index, located.stem),
      type,
      stem: located.stem,
      options,
      confidence: assessment.confidence,
      recognition: {
        source: group.source,
        stemSource: located.stemSource,
        sequence: sequenceKind || undefined,
        signals: assessment.signals,
      },
      _root: located.root,
      _groupElements: group.elements,
    };
  }

  function sameChoiceSet(left, right) {
    const leftElements = new Set(left._groupElements || []);
    const rightElements = new Set(right._groupElements || []);
    if (!leftElements.size || leftElements.size !== rightElements.size) return false;
    return [...leftElements].every((element) => rightElements.has(element));
  }

  function extractAllQuestions() {
    const extracted = [];
    const groups = [
      ...discoverNativeGroups(),
      ...discoverAriaGroups(),
      ...discoverTextGroups(),
    ];
    groups.forEach((group, index) => {
      const question = questionFromGroup(group, index);
      if (!question) return;
      if (extracted.some((existing) => sameChoiceSet(existing, question))) return;
      extracted.push(question);
    });

    extracted.sort((left, right) => {
      if (left._root === right._root) return 0;
      const position = left._root?.compareDocumentPosition?.(right._root) || 0;
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

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
    if (answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && !answer.length)) {
      throw new Error("FILL_ANSWER requires payload.answer.");
    }

    const question = descriptorForQuestion(payload.questionId || payload.id);
    if (!question) throw new Error("Question not found on the current page.");

    const rawAnswers = Array.isArray(answer)
      ? answer
      : question.type === "multiple_choice"
        ? String(answer).split(/[,，、;；\s]+/).filter(Boolean)
        : [answer];
    const wanted = new Set(rawAnswers.map(canonicalAnswer));
    const selectedOptions = question.options.filter((candidate) =>
      wanted.has(canonicalAnswer(candidate.key)) || wanted.has(canonicalAnswer(candidate.text))
    );
    if (selectedOptions.length !== wanted.size) {
      throw new Error(`Answer '${rawAnswers.join(",")}' is not one of the extracted options.`);
    }
    if (question.type !== "multiple_choice" && selectedOptions.length !== 1) {
      throw new Error("Single-choice questions require exactly one answer.");
    }

    const fillTargets = question.type === "multiple_choice" ? question.options : selectedOptions;
    const controls = fillTargets.map((option) => ({
      option,
      input: option._input || option._element?.querySelector?.("input[type='radio'], input[type='checkbox']"),
      checked: selectedOptions.includes(option),
    }));
    if (controls.some(({ input }) => !input)) {
      throw new Error("The selected option group has no native inputs to fill safely.");
    }
    if (controls.some(({ input }) => input.disabled)) throw new Error("The selected option is disabled.");

    const form = controls[0].input.form || closestComposed(controls[0].input, "form");
    const preventSyntheticSubmit = (event) => {
      if (!event.isTrusted) event.preventDefault();
    };
    form?.addEventListener("submit", preventSyntheticSubmit, true);
    try {
      for (const { input, checked } of controls) {
        if (Boolean(input.checked) === checked) continue;
        nativeSetChecked(input, checked);
        dispatchValueEvents(input);
      }
    } finally {
      form?.removeEventListener("submit", preventSyntheticSubmit, true);
    }

    return {
      questionId: question.id,
      answer: question.type === "multiple_choice"
        ? selectedOptions.map((option) => option.key)
        : selectedOptions[0].key,
      type: question.type,
      filled: controls.every(({ input, checked }) => Boolean(input.checked) === checked),
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

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")
    );
  }

  // Alt/Option + Shift + E: extract this page and send it to the collector
  // server. Feedback is the service-worker badge, so the handler stays silent;
  // guards run first so pages keep the combo when collection is off.
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.code !== "KeyE") return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: "COLLECT_CURRENT_PAGE" }, () => {
        // Swallow chrome.runtime.lastError: the badge already reports outcome.
        void chrome.runtime.lastError;
      });
    } catch {
      // The extension context may be gone (update/reload); nothing to do.
    }
  }, true);

  document.addEventListener("mouseover", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(QUESTION_ROOT_SELECTOR);
    if (root) state.lastHoveredRoot = root;
  }, true);

  state.installed = true;
})();
