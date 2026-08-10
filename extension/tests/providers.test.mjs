import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderError,
  parseAnswerText,
  solveWithProfile,
  testProfileConnection,
  validateModelProfile,
} from "../src/providers/index.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const target = name.toLowerCase();
        const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
        return key ? headers[key] : null;
      },
    },
    text: async () => JSON.stringify(payload),
  };
}

const choiceQuestion = {
  type: "single_choice",
  stem: "Which option is correct?",
  options: { A: "first", B: "second" },
};

test("parses JSON and plain true/false outputs without coercing false", () => {
  assert.deepEqual(parseAnswerText('{"answer":"B","confidence":"92%","explanation":"ok"}', {
    question: choiceQuestion,
  }), {
    answer: "B",
    confidence: 0.92,
    explanation: "ok",
    format: "json",
    parseError: null,
  });

  const judgment = parseAnswerText("答案：错误", {
    question: { type: "true_false", stem: "A statement" },
  });
  assert.equal(judgment.answer, false);
  assert.equal(judgment.parseError, null);

  assert.equal(parseAnswerText('{"answer":"A","confidence":null}', {
    question: choiceQuestion,
  }).confidence, null);
});

test("validates an absolute endpoint and rejects reserved custom headers", () => {
  const valid = validateModelProfile({
    protocol: "openai_chat_completions",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "local-model",
    authMode: "none",
  });
  assert.equal(valid.valid, true);

  const storageCompatible = validateModelProfile({
    protocol: "anthropic_messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-test",
    apiKey: "key",
    authMode: "api_key",
  }, { requireCredentials: true });
  assert.equal(storageCompatible.valid, true);
  assert.equal(storageCompatible.profile.authMode, "x-api-key");

  const invalid = validateModelProfile({
    protocol: "openai_chat_completions",
    endpoint: "https://example.test/v1/chat/completions",
    model: "model",
    apiKey: "secret",
    customHeaders: { Authorization: "should-not-overwrite" },
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /reserved header/i);
});

test("sends an OpenAI-compatible Chat Completions request and normalizes an answer", async () => {
  let observed;
  const result = await solveWithProfile({
    protocol: "openai_chat_completions",
    endpoint: "https://model.example/v1/chat/completions",
    model: "test-model",
    apiKey: "test-key",
    timeoutMs: 1000,
    maxOutputTokens: 64,
  }, {
    question: choiceQuestion,
  }, {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return jsonResponse({
        id: "chatcmpl-test",
        model: "test-model",
        choices: [{ message: { content: '{"answer":"B","confidence":0.75}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }, 200, { "x-request-id": "req-openai" });
    },
  });

  assert.equal(observed.url, "https://model.example/v1/chat/completions");
  assert.equal(observed.init.headers.authorization, "Bearer test-key");
  const requestBody = JSON.parse(observed.init.body);
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.max_tokens, 64);
  assert.equal(result.answer, "B");
  assert.equal(result.parsedAnswer, "B");
  assert.equal(result.confidence, 0.75);
  assert.equal(result.requestId, "req-openai");
});

test("omits API-key headers for an explicitly unauthenticated local profile", async () => {
  let headers;
  await solveWithProfile({
    protocol: "openai_chat_completions",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "local-model",
    authMode: "none",
    timeoutMs: 1000,
  }, { question: choiceQuestion }, {
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return jsonResponse({
        choices: [{ message: { content: '{"answer":"A"}' } }],
      });
    },
  });
  assert.equal(Object.hasOwn(headers, "authorization"), false);
  assert.equal(Object.hasOwn(headers, "x-api-key"), false);
});

test("sends an Anthropic Messages request and preserves a false answer", async () => {
  let observed;
  const result = await solveWithProfile({
    protocol: "anthropic_messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-test",
    apiKey: "anthropic-key",
    timeoutMs: 1000,
    maxOutputTokens: 64,
  }, {
    question: { type: "true_false", stem: "The statement is false." },
  }, {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return jsonResponse({
        id: "msg-test",
        model: "claude-test",
        content: [{ type: "text", text: '{"answer":false,"confidence":0.9}' }],
        usage: { input_tokens: 11, output_tokens: 8 },
        stop_reason: "end_turn",
      }, 200, { "request-id": "req-anthropic" });
    },
  });

  assert.equal(observed.url, "https://api.anthropic.com/v1/messages");
  assert.equal(observed.init.headers["x-api-key"], "anthropic-key");
  assert.equal(observed.init.headers["anthropic-version"], "2023-06-01");
  const requestBody = JSON.parse(observed.init.body);
  assert.equal(requestBody.system.includes("careful cybersecurity"), true);
  assert.equal(result.answer, false);
  assert.equal(result.parsedAnswer, false);
  assert.equal(result.requestId, "req-anthropic");
});

test("converts a timed-out request to ProviderError and connection tests return errors as data", async () => {
  const hangingFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const profile = {
    protocol: "openai_chat_completions",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "local-model",
    authMode: "none",
    timeoutMs: 10,
  };

  await assert.rejects(
    solveWithProfile(profile, { question: choiceQuestion }, { fetchImpl: hangingFetch }),
    (error) => error instanceof ProviderError && error.code === "timeout",
  );

  const connection = await testProfileConnection(profile, { fetchImpl: hangingFetch });
  assert.equal(connection.ok, false);
  assert.equal(connection.error.code, "timeout");
});
