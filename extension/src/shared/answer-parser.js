function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getQuestionType(question) {
  return asText(question?.type || question?.questionType).toLowerCase();
}

function isTrueFalseQuestion(question) {
  return ["true_false", "true-false", "boolean", "judgment", "judge"].includes(getQuestionType(question));
}

function isMultipleChoiceQuestion(question) {
  return ["multiple_choice", "multiple-choice", "multiple", "multi_choice", "checkbox"].includes(getQuestionType(question));
}

function getOptionKeys(question) {
  const options = question?.options;
  if (Array.isArray(options)) {
    return options
      .map((option) => isObject(option) ? asText(option.key || option.label || option.id || option.value) : "")
      .filter(Boolean);
  }
  if (isObject(options)) {
    return Object.keys(options).map(asText).filter(Boolean);
  }
  return ["A", "B", "C", "D"];
}

function extractBalancedJson(text) {
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(text))) {
    candidates.push(match[1].trim());
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const character = text[end];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quoted = false;
        }
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, end + 1));
          start = end;
          break;
        }
      }
    }
  }
  return candidates;
}

function parseFirstJsonObject(text) {
  for (const candidate of extractBalancedJson(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed)) {
        return parsed;
      }
    } catch {
      // A model may include prose or a malformed object before a valid object.
    }
  }
  return null;
}

function getFirstOwnValue(object, keys) {
  if (!isObject(object)) {
    return undefined;
  }
  const actualKey = Object.keys(object).find((key) => keys.includes(key.toLowerCase()));
  return actualKey === undefined ? undefined : object[actualKey];
}

export function normalizeAnswer(value, question) {
  if (isTrueFalseQuestion(question)) {
    if (typeof value === "boolean") {
      return value;
    }
    const normalized = asText(String(value)).toUpperCase();
    if (["TRUE", "T", "YES", "Y", "1", "正确", "对", "是", "真"].includes(normalized)) {
      return true;
    }
    if (["FALSE", "F", "NO", "N", "0", "错误", "错", "否", "假"].includes(normalized)) {
      return false;
    }
    return null;
  }

  const options = getOptionKeys(question);
  if (isMultipleChoiceQuestion(question)) {
    const values = Array.isArray(value)
      ? value
      : asText(String(value))
        .replace(/^\s*(?:答案|选项|answer|option|choice)\s*[:：是为-]?\s*/i, "")
        .split(/[,，、;；\s]+/)
        .filter(Boolean);
    if (!values.length) return null;
    const normalized = [];
    for (const item of values) {
      const raw = asText(String(item)).replace(/^\(?\s*|\s*[)）.、:：]$/g, "");
      const exact = options.find((key) => key.toUpperCase() === raw.toUpperCase());
      if (!exact) return null;
      if (!normalized.includes(exact)) normalized.push(exact);
    }
    return options.filter((key) => normalized.includes(key));
  }

  const raw = asText(String(value));
  if (!raw) {
    return null;
  }
  const exact = options.find((key) => key.toUpperCase() === raw.toUpperCase());
  if (exact) {
    return exact;
  }

  const compact = raw.replace(/^\s*(?:答案|选项|answer|option|choice)\s*[:：是为-]?\s*/i, "");
  const match = compact.match(/^\(?\s*([A-Za-z0-9]+)\s*[)）.、:：\-\s]/) || compact.match(/^\(?\s*([A-Za-z0-9]+)\s*\)?$/);
  if (!match) {
    return null;
  }
  return options.find((key) => key.toUpperCase() === match[1].toUpperCase()) || null;
}

function normalizeConfidence(value) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) {
    return null;
  }
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const percentage = Number(value.trim().slice(0, -1));
    return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage / 100 : null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric >= 0 && numeric <= 1) {
    return numeric;
  }
  if (numeric > 1 && numeric <= 100) {
    return numeric / 100;
  }
  return null;
}

function plainTextCandidate(text, question) {
  const type = isTrueFalseQuestion(question);
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  if (type) {
    const labeled = trimmed.match(/(?:答案|结论|answer)\s*[:：是为-]?\s*(true|false|正确|错误|对|错|是|否)/i);
    return labeled?.[1] || (firstLine.length <= 16 ? firstLine : undefined);
  }
  const labeled = isMultipleChoiceQuestion(question)
    ? trimmed.match(/(?:答案|选项|answer|option|choice)\s*[:：是为-]?\s*([A-Za-z0-9]+(?:\s*[,，、;；\s]\s*[A-Za-z0-9]+)*)/i)
    : trimmed.match(/(?:答案|选项|answer|option|choice)\s*[:：是为-]?\s*\(?\s*([A-Za-z0-9]+)\s*\)?/i);
  return labeled?.[1] || (firstLine.length <= 16 ? firstLine : undefined);
}

/**
 * Parse the minimal answer contract expected from every supported provider.
 * Parsing is intentionally non-throwing: callers can surface a low-confidence
 * result or invoke a fallback model when a model returns non-conforming text.
 */
export function parseAnswerText(text, options = {}) {
  const rawText = typeof text === "string" ? text.trim() : "";
  const question = options.question;
  if (!rawText) {
    return {
      answer: null,
      confidence: null,
      explanation: null,
      format: "empty",
      parseError: "The model returned no text.",
    };
  }

  const object = parseFirstJsonObject(rawText);
  if (object) {
    const answerValue = getFirstOwnValue(object, ["answer", "final_answer", "finalanswer", "choice", "option", "答案", "选项"]);
    const confidenceValue = getFirstOwnValue(object, ["confidence", "score", "probability", "置信度"]);
    const explanationValue = getFirstOwnValue(object, ["explanation", "reason", "rationale", "analysis", "解析", "理由"]);
    const answer = normalizeAnswer(answerValue, question);
    return {
      answer,
      confidence: normalizeConfidence(confidenceValue),
      explanation: typeof explanationValue === "string" ? explanationValue.trim() || null : null,
      format: "json",
      parseError: answer === null ? "The JSON response did not contain a valid answer for this question." : null,
    };
  }

  const answer = normalizeAnswer(plainTextCandidate(rawText, question), question);
  return {
    answer,
    confidence: null,
    explanation: null,
    format: "text",
    parseError: answer === null ? "Could not find a valid answer in the model response." : null,
  };
}
