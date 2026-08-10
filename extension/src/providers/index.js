import { MODEL_PROTOCOLS, normalizeModelProfile, validateModelProfile } from "../shared/model-profile.js";
import { ProviderError, serializeProviderError } from "../shared/provider-error.js";
import { parseAnswerText } from "../shared/answer-parser.js";
import { solveWithOpenAIChat } from "./openai-chat-provider.js";
import { solveWithAnthropicMessages } from "./anthropic-messages-provider.js";

/**
 * Dispatch a solve request based solely on the configured profile protocol.
 * The optional third argument is useful for tests and future secret gateways:
 * `{ apiKey, fetchImpl, signal }`.
 */
export async function solveWithProfile(profile, request = {}, runtime = {}) {
  const normalized = normalizeModelProfile(profile);
  switch (normalized.protocol) {
    case MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS:
      return solveWithOpenAIChat(profile, request, runtime);
    case MODEL_PROTOCOLS.ANTHROPIC_MESSAGES:
      return solveWithAnthropicMessages(profile, request, runtime);
    default:
      throw new ProviderError("Unsupported model protocol.", {
        code: "invalid_profile",
        protocol: normalized.protocol,
      });
  }
}

/**
 * Perform a tiny model call to validate endpoint, authentication, model ID, and
 * response parsing. Errors are returned as data so settings screens can render
 * them without special try/catch handling.
 */
export async function testProfileConnection(profile, runtime = {}) {
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  try {
    const result = await solveWithProfile(profile, {
      systemPrompt: "Reply only with valid JSON. Do not add markdown.",
      userPrompt: "Return exactly {\"answer\":\"A\",\"confidence\":1,\"explanation\":\"connection test\"}.",
      question: {
        type: "single_choice",
        stem: "Connection test",
        options: { A: "A", B: "B" },
      },
    }, runtime);
    return {
      ok: true,
      protocol: result.protocol,
      model: result.model,
      status: result.status,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      parseOk: result.answer !== null,
      answer: result.answer,
      warning: result.parseError || undefined,
    };
  } catch (error) {
    const normalized = serializeProviderError(error);
    const endedAt = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    return {
      ok: false,
      protocol: normalizeModelProfile(profile).protocol || undefined,
      latencyMs: Math.round(endedAt - startedAt),
      error: normalized,
    };
  }
}

export {
  MODEL_PROTOCOLS,
  ProviderError,
  normalizeModelProfile,
  parseAnswerText,
  validateModelProfile,
};
