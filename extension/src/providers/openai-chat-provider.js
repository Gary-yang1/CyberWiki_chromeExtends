import {
  MODEL_PROTOCOLS,
  assertValidModelProfile,
  buildProviderHeaders,
} from "../shared/model-profile.js";
import { ProviderError } from "../shared/provider-error.js";
import { postJsonRequest } from "../shared/json-request.js";
import { prepareSolveRequest } from "../shared/solve-request.js";
import { parseAnswerText } from "../shared/answer-parser.js";

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string"
        ? part
        : typeof part?.text === "string"
          ? part.text
          : typeof part?.content === "string"
            ? part.content
            : "")
      .join("");
  }
  return "";
}

export function extractOpenAIText(payload) {
  const choice = payload?.choices?.[0];
  return contentToText(choice?.message?.content) || contentToText(choice?.text) || "";
}

/**
 * Call any OpenAI-compatible Chat Completions endpoint. It deliberately uses
 * the broadly compatible `max_tokens` field rather than SDK-specific helpers.
 */
export async function solveWithOpenAIChat(profile, request = {}, runtime = {}) {
  const validation = assertValidModelProfile(profile, {
    apiKey: runtime.apiKey,
    requireCredentials: true,
  });
  if (validation.profile.protocol !== MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS) {
    throw new ProviderError("This profile is not an OpenAI Chat Completions profile.", {
      code: "invalid_profile",
      protocol: validation.profile.protocol,
    });
  }

  const prepared = prepareSolveRequest(validation.profile, request);
  const messages = [
    ...(prepared.systemPrompt ? [{ role: "system", content: prepared.systemPrompt }] : []),
    ...prepared.messages,
  ];
  const body = {
    model: validation.profile.model,
    messages,
    max_tokens: prepared.maxOutputTokens,
  };
  if (prepared.temperature !== undefined) {
    body.temperature = prepared.temperature;
  }

  const response = await postJsonRequest({
    url: validation.endpoint,
    headers: buildProviderHeaders(validation.profile, runtime),
    body,
    protocol: MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
    timeoutMs: validation.profile.timeoutMs,
    signal: runtime.signal || request.signal,
    fetchImpl: runtime.fetchImpl,
  });
  const text = extractOpenAIText(response.data);
  if (!text) {
    throw new ProviderError("The OpenAI-compatible endpoint returned no message content.", {
      code: "invalid_response",
      status: response.status,
      protocol: MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
      requestId: response.requestId,
    });
  }

  const parsed = parseAnswerText(text, { question: prepared.question });
  return {
    protocol: MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
    model: response.data.model || validation.profile.model,
    text,
    ...parsed,
    // Keep an explicit alias for callers that want to distinguish parser output
    // from a provider-specific raw answer field. Do not use `||` here: false is
    // a valid true/false answer.
    parsedAnswer: parsed.answer,
    latencyMs: response.latencyMs,
    status: response.status,
    requestId: response.requestId,
    inputTokens: response.data.usage?.prompt_tokens,
    outputTokens: response.data.usage?.completion_tokens,
    finishReason: response.data.choices?.[0]?.finish_reason,
  };
}
