import {
  MODEL_PROTOCOLS,
  assertValidModelProfile,
  buildProviderHeaders,
} from "../shared/model-profile.js";
import { ProviderError } from "../shared/provider-error.js";
import { postJsonRequest } from "../shared/json-request.js";
import { prepareSolveRequest } from "../shared/solve-request.js";
import { parseAnswerText } from "../shared/answer-parser.js";

export function extractAnthropicText(payload) {
  if (Array.isArray(payload?.content)) {
    return payload.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return typeof payload?.completion === "string" ? payload.completion : "";
}

/** Call Anthropic's Messages API and normalize it to the shared result shape. */
export async function solveWithAnthropicMessages(profile, request = {}, runtime = {}) {
  const validation = assertValidModelProfile(profile, {
    apiKey: runtime.apiKey,
    requireCredentials: true,
  });
  if (validation.profile.protocol !== MODEL_PROTOCOLS.ANTHROPIC_MESSAGES) {
    throw new ProviderError("This profile is not an Anthropic Messages profile.", {
      code: "invalid_profile",
      protocol: validation.profile.protocol,
    });
  }

  const prepared = prepareSolveRequest(validation.profile, request);
  const body = {
    model: validation.profile.model,
    max_tokens: prepared.maxOutputTokens,
    messages: prepared.messages,
  };
  if (prepared.systemPrompt) {
    body.system = prepared.systemPrompt;
  }
  if (prepared.temperature !== undefined) {
    body.temperature = prepared.temperature;
  }

  const response = await postJsonRequest({
    url: validation.endpoint,
    headers: buildProviderHeaders(validation.profile, runtime),
    body,
    protocol: MODEL_PROTOCOLS.ANTHROPIC_MESSAGES,
    timeoutMs: validation.profile.timeoutMs,
    signal: runtime.signal || request.signal,
    fetchImpl: runtime.fetchImpl,
  });
  const text = extractAnthropicText(response.data);
  if (!text) {
    throw new ProviderError("The Anthropic endpoint returned no text content.", {
      code: "invalid_response",
      status: response.status,
      protocol: MODEL_PROTOCOLS.ANTHROPIC_MESSAGES,
      requestId: response.requestId,
    });
  }

  const parsed = parseAnswerText(text, { question: prepared.question });
  return {
    protocol: MODEL_PROTOCOLS.ANTHROPIC_MESSAGES,
    model: response.data.model || validation.profile.model,
    text,
    ...parsed,
    // false is a valid answer, so retain it verbatim instead of truthiness
    // coercion in downstream benchmark code.
    parsedAnswer: parsed.answer,
    latencyMs: response.latencyMs,
    status: response.status,
    requestId: response.requestId,
    inputTokens: response.data.usage?.input_tokens,
    outputTokens: response.data.usage?.output_tokens,
    finishReason: response.data.stop_reason,
  };
}
