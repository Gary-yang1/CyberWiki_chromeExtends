/*
 * Pure question-recognition heuristics shared by the content script and tests.
 * Keep this file dependency-free: chrome.scripting injects it before the DOM
 * extractor, while Node tests can load it directly.
 */
(() => {
  "use strict";

  const GLOBAL_KEY = "__CWKB_QUESTION_HEURISTICS_V1__";
  if (globalThis[GLOBAL_KEY]) return;

  const BOOLEAN_TRUE = new Set([
    "true", "正确", "是", "对", "真", "√", "yes", "y", "t", "1",
  ]);
  const BOOLEAN_FALSE = new Set([
    "false", "错误", "否", "错", "假", "×", "x", "no", "n", "f", "0",
  ]);

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

  function booleanValue(value) {
    const compact = canonicalText(value);
    if (BOOLEAN_TRUE.has(compact)) return true;
    if (BOOLEAN_FALSE.has(compact)) return false;
    return null;
  }

  function parseOptionText(value) {
    const source = normalizeDisplayText(value);
    if (!source) return null;
    const match = source.match(
      /^\s*(?:选项\s*)?(?:[（(\[]\s*)?([A-Ha-h]|[1-9])\s*(?:[）)\]]\s*|[.．、:：\-]\s*|\s+)([\s\S]+)$/i
    );
    if (!match) return null;
    const text = normalizeDisplayText(match[2]);
    return text ? { key: match[1].toUpperCase(), text } : null;
  }

  function optionKeyFromText(value) {
    return parseOptionText(value)?.key || "";
  }

  function stripOptionPrefix(value, expectedKey = "") {
    const parsed = parseOptionText(value);
    if (!parsed) return normalizeDisplayText(value);
    if (expectedKey && parsed.key.toUpperCase() !== String(expectedKey).toUpperCase()) {
      return normalizeDisplayText(value);
    }
    return parsed.text;
  }

  function keySequenceKind(keys) {
    const normalized = keys.map((key) => String(key || "").trim().toUpperCase());
    if (normalized.length < 2 || new Set(normalized).size !== normalized.length) return "";
    if (normalized.every((key) => /^[A-H]$/.test(key))) {
      const codes = normalized.map((key) => key.charCodeAt(0));
      return codes.every((code, index) => code === codes[0] + index) ? "letters" : "";
    }
    if (normalized.every((key) => /^[1-9]$/.test(key))) {
      const numbers = normalized.map(Number);
      return numbers.every((number, index) => number === numbers[0] + index) ? "numbers" : "";
    }
    return "";
  }

  function splitSequentialRuns(options) {
    const runs = [];
    let current = [];
    for (const option of options) {
      const key = String(option?.key || "").toUpperCase();
      const resetsSequence = current.length >= 2 && (
        (key === "A" && current[0]?.key?.toUpperCase() === "A")
        || (key === "1" && String(current[0]?.key) === "1")
        || current.some((item) => String(item?.key || "").toUpperCase() === key)
      );
      if (resetsSequence) {
        runs.push(current);
        current = [];
      }
      current.push(option);
    }
    if (current.length) runs.push(current);
    return runs.filter((run) => run.length >= 2);
  }

  function inferQuestionType({ options = [], controlKinds = [], rootText = "" } = {}) {
    const values = options.map((option) => {
      const textValue = booleanValue(option?.text);
      if (textValue !== null) return textValue;
      const key = canonicalText(option?.key);
      if (key === "true") return true;
      if (key === "false") return false;
      return null;
    });
    const booleanPair = options.length === 2 && values.includes(true) && values.includes(false);
    const compactRoot = canonicalText(rootText);
    const multipleHint = /多选|可多选|多项选择|选择所有|所有正确|selectall|multiplechoice|morethanone/.test(compactRoot);
    const singleHint = /单选|单项选择|只能选择一项|singlechoice/.test(compactRoot);
    const kinds = new Set(controlKinds);

    if (booleanPair && !multipleHint) return "true_false";
    if (kinds.has("checkbox") || kinds.has("aria-checkbox") || multipleHint) return "multiple_choice";
    if (kinds.has("radio") || kinds.has("aria-radio") || singleHint) return "single_choice";
    return "choice_unknown";
  }

  function scoreQuestionCandidate({
    optionCount = 0,
    hasStem = false,
    stemLength = 0,
    sequentialKeys = false,
    explicitOptions = false,
    controlKinds = [],
    explicitRoot = false,
    rootIsDocument = false,
    duplicateKeys = false,
    mixedControlCount = 0,
  } = {}) {
    let score = 0;
    const signals = [];
    const kinds = new Set(controlKinds);
    if (optionCount >= 2 && optionCount <= 10) {
      score += 0.12;
      signals.push("option-count");
    }
    if (hasStem && stemLength >= 2) {
      score += 0.26;
      signals.push("stem");
    }
    if (sequentialKeys) {
      score += 0.24;
      signals.push("sequential-keys");
    }
    if (explicitOptions) {
      score += 0.14;
      signals.push("explicit-options");
    }
    if (kinds.has("radio") || kinds.has("checkbox")) {
      score += 0.34;
      signals.push("native-controls");
    } else if (kinds.has("aria-radio") || kinds.has("aria-checkbox")) {
      score += 0.26;
      signals.push("aria-controls");
    }
    if (explicitRoot) {
      score += 0.14;
      signals.push("question-root");
    }
    if (duplicateKeys) {
      score -= 0.35;
      signals.push("duplicate-keys");
    }
    if (rootIsDocument) {
      score -= 0.45;
      signals.push("document-root");
    }
    if (mixedControlCount > Math.max(optionCount + 1, optionCount * 1.5)) {
      score -= 0.28;
      signals.push("mixed-groups");
    }
    const confidence = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
    return { confidence, accepted: confidence >= 0.52, signals };
  }

  Object.defineProperty(globalThis, GLOBAL_KEY, {
    value: Object.freeze({
      booleanValue,
      canonicalText,
      inferQuestionType,
      keySequenceKind,
      normalizeDisplayText,
      optionKeyFromText,
      parseOptionText,
      scoreQuestionCandidate,
      splitSequentialRuns,
      stripOptionPrefix,
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
