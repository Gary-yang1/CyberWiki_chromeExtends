import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelsRequestHeaders,
  deriveModelsEndpoint,
  listProviderModels,
  normalizeModelCatalog,
} from "../src/providers/model-catalog.js";
import { ProviderError } from "../src/shared/provider-error.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
      },
    },
    text: async () => JSON.stringify(payload),
  };
}

const openAIProfile = {
  protocol: "openai_chat_completions",
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "test-key",
  timeoutMs: 1_000,
};

test("derives a models endpoint and accepts explicit overrides", () => {
  assert.equal(
    deriveModelsEndpoint(openAIProfile),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    deriveModelsEndpoint({
      ...openAIProfile,
      endpoint: "https://gateway.example/prefix/v1/chat/completions",
    }),
    "https://gateway.example/prefix/v1/models",
  );
  assert.equal(
    deriveModelsEndpoint({ ...openAIProfile, modelsEndpoint: "/catalog/models" }),
    "https://api.openai.com/catalog/models",
  );
});

test("sends both auth styles for catalog discovery and accepts unauthenticated local services", () => {
  assert.deepEqual(buildModelsRequestHeaders(openAIProfile), {
    "content-type": "application/json",
    authorization: "Bearer test-key",
    "x-api-key": "test-key",
  });
  const local = buildModelsRequestHeaders({
    protocol: "openai_chat_completions",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    authMode: "none",
  });
  assert.equal(Object.hasOwn(local, "authorization"), false);
  assert.equal(Object.hasOwn(local, "x-api-key"), false);
});

test("normalizes compatible list shapes and keeps only chat candidates in the recommended subset", () => {
  const catalog = normalizeModelCatalog({
    models: [
      { id: "text-embedding-3-small", owned_by: "openai" },
      { id: "gpt-5.6-terra", owned_by: "openai", created: 12 },
      { id: "gpt-5.6-terra", owned_by: "" },
      "local-chat-model",
    ],
  });
  assert.deepEqual(catalog.models.map((model) => model.id), [
    "gpt-5.6-terra",
    "local-chat-model",
    "text-embedding-3-small",
  ]);
  assert.deepEqual(catalog.recommendedModels.map((model) => model.id), [
    "gpt-5.6-terra",
    "local-chat-model",
  ]);
});

test("fetches the provider catalog and keeps API keys out of errors", async () => {
  let observed;
  const result = await listProviderModels(openAIProfile, {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return jsonResponse({ data: [{ id: "gpt-5.6-terra", owned_by: "openai" }] });
    },
  });
  assert.equal(observed.url, "https://api.openai.com/v1/models");
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.headers.authorization, "Bearer test-key");
  assert.deepEqual(result.models.map((model) => model.id), ["gpt-5.6-terra"]);

  await assert.rejects(
    listProviderModels(openAIProfile, {
      fetchImpl: async () => jsonResponse({ error: { message: "Invalid key" } }, 401),
    }),
    (error) => error instanceof ProviderError
      && error.code === "model_catalog_http_error"
      && !error.message.includes("test-key"),
  );
});

test("uses Anthropic's own endpoint and authentication scheme for its catalog", () => {
  const profile = {
    protocol: "anthropic_messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiKey: "anthropic-test-key",
  };
  assert.equal(deriveModelsEndpoint(profile), "https://api.anthropic.com/v1/models");
  const headers = buildModelsRequestHeaders(profile);
  assert.equal(headers["x-api-key"], "anthropic-test-key");
  assert.equal(headers.authorization, "Bearer anthropic-test-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("discovers the catalog through same-origin fallbacks when the derived path 404s", async () => {
  const deepseekAnthropic = {
    protocol: "anthropic_messages",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    apiKey: "deepseek-test-key",
  };
  const requested = [];
  const result = await listProviderModels(deepseekAnthropic, {
    fetchImpl: async (url) => {
      requested.push(url);
      return url === "https://api.deepseek.com/v1/models"
        ? jsonResponse({ data: [{ id: "deepseek-chat" }] })
        : jsonResponse({ error: { message: "Not Found" } }, 404);
    },
  });
  assert.deepEqual(requested, [
    "https://api.deepseek.com/anthropic/v1/models",
    "https://api.deepseek.com/v1/models",
  ]);
  assert.equal(result.modelsEndpoint, "https://api.deepseek.com/v1/models");
  assert.deepEqual(result.models.map((model) => model.id), ["deepseek-chat"]);
});

test("never falls back from an explicitly configured models endpoint", async () => {
  const profile = {
    protocol: "openai_chat_completions",
    endpoint: "https://gateway.example/v1/chat/completions",
    modelsEndpoint: "https://gateway.example/custom/models",
    apiKey: "test-key",
  };
  let requests = 0;
  await assert.rejects(
    listProviderModels(profile, {
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ error: { message: "Not Found" } }, 404);
      },
    }),
    (error) => error instanceof ProviderError && error.status === 404,
  );
  assert.equal(requests, 1);
});

test("surfaces auth failures immediately instead of trying fallbacks", async () => {
  const profile = {
    protocol: "anthropic_messages",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    apiKey: "deepseek-test-key",
  };
  let requests = 0;
  await assert.rejects(
    listProviderModels(profile, {
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ error: { message: "Invalid key" } }, 401);
      },
    }),
    (error) => error instanceof ProviderError && error.status === 401,
  );
  assert.equal(requests, 1);
});

test("lets an Anthropic profile list models from a separately configured endpoint", () => {
  // DeepSeek's Anthropic-compatible layer: calls go to /anthropic/v1/messages
  // but the model list only exists on the OpenAI-style /v1/models.
  const profile = {
    protocol: "anthropic_messages",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    modelsEndpoint: "https://api.deepseek.com/v1/models",
    apiKey: "deepseek-test-key",
  };
  assert.equal(deriveModelsEndpoint(profile), "https://api.deepseek.com/v1/models");
  const headers = buildModelsRequestHeaders(profile);
  assert.equal(headers["x-api-key"], "deepseek-test-key");
  assert.equal(headers.authorization, "Bearer deepseek-test-key");
});
