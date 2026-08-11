import { ProviderError } from "./provider-error.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a careful cybersecurity knowledge question solver.",
  "Return only one JSON object with keys answer, confidence, and explanation.",
  "For single-choice questions answer with the exact option key. For multiple-choice questions answer with an array of exact option keys. For true/false questions answer with true or false.",
  "confidence must be a number from 0 to 1. Keep explanation concise.",
].join(" ");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuestion(question) {
  if (!isObject(question)) {
    return undefined;
  }
  const type = text(question.type || question.questionType).toLowerCase();
  const stem = text(question.stem || question.text || question.question);
  const options = question.options;
  return { ...question, type, stem, options };
}

function optionEntries(options) {
  if (Array.isArray(options)) {
    return options
      .map((option) => {
        if (isObject(option)) {
          return [
            text(option.key || option.label || option.id || option.value),
            text(option.text || option.content || option.value || option.label),
          ];
        }
        return ["", ""];
      })
      .filter(([key]) => key);
  }
  if (isObject(options)) {
    return Object.entries(options).map(([key, value]) => [text(key), text(value)]).filter(([key]) => key);
  }
  return [];
}

export function formatQuestionForModel(question) {
  const normalized = normalizeQuestion(question);
  if (!normalized?.stem) {
    return "";
  }

  const lines = [
    `Question type: ${normalized.type || "single_choice"}`,
    `Question: ${normalized.stem}`,
  ];
  for (const [key, value] of optionEntries(normalized.options)) {
    lines.push(`${key}. ${value}`);
  }
  return lines.join("\n");
}

function normalizeEvidence(context) {
  const entries = Array.isArray(context) ? context : context ? [context] : [];
  const texts = entries.map((entry) => {
    if (typeof entry === "string") {
      return entry.trim();
    }
    if (isObject(entry)) {
      const body = text(entry.text || entry.content || entry.chunk);
      const source = text(entry.source || entry.title);
      return source && body ? `[${source}] ${body}` : body;
    }
    return "";
  }).filter(Boolean);
  return texts.length ? `Reference material:\n${texts.join("\n\n")}` : "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter((message) => isObject(message) && ["user", "assistant"].includes(message.role))
    .map((message) => ({ role: message.role, content: text(message.content) }))
    .filter((message) => message.content);
}

/**
 * Convert the extension's flexible solve request into the text-only message
 * shape shared by OpenAI Chat Completions and Anthropic Messages.
 */
export function prepareSolveRequest(profile, rawRequest = {}) {
  const request = isObject(rawRequest) ? rawRequest : {};
  const question = normalizeQuestion(request.question || request);
  const directPrompt = text(request.userPrompt || request.prompt);
  const questionPrompt = formatQuestionForModel(question);
  const evidencePrompt = normalizeEvidence(request.context || request.evidence || request.retrievedEvidence);
  const userPrompt = [directPrompt || questionPrompt, evidencePrompt].filter(Boolean).join("\n\n");
  const messages = normalizeMessages(request.messages);

  if (!userPrompt && messages.length === 0) {
    throw new ProviderError("A solve request must include question, prompt, userPrompt, or messages.", {
      code: "invalid_request",
    });
  }

  if (userPrompt) {
    messages.push({ role: "user", content: userPrompt });
  }

  const requestedMaxTokens = request.maxOutputTokens;
  const profileMaxTokens = profile?.maxOutputTokens;
  const maxOutputTokens = Number.isInteger(requestedMaxTokens) && requestedMaxTokens > 0
    ? requestedMaxTokens
    : profileMaxTokens;
  const temperature = typeof request.temperature === "number" && Number.isFinite(request.temperature)
    ? request.temperature
    : profile?.temperature;

  return {
    question,
    systemPrompt: text(request.systemPrompt) || text(profile?.systemPrompt) || DEFAULT_SYSTEM_PROMPT,
    messages,
    maxOutputTokens,
    temperature,
  };
}
