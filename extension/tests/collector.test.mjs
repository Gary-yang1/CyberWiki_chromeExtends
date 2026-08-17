import assert from "node:assert/strict";
import test from "node:test";

import { CollectorError, checkCollectorHealth, collectExtraction } from "../src/collector/client.js";

const CONFIG = {
  enabled: true,
  endpoint: "http://127.0.0.1:8790/api/v1/extractions",
  userId: "gary",
  key: "key-gary-123",
  timeoutMs: 2_000,
};

const PAYLOAD = {
  url: "https://quiz.example/page",
  title: "示例",
  extractedAt: "2026-08-17T10:00:00.000Z",
  questions: [{ stem: "1+1=?", options: { A: "1", B: "2" } }],
};

test("posts the extraction as JSON to the configured endpoint", async () => {
  let observed;
  const result = await collectExtraction(CONFIG, PAYLOAD, {
    fetchImpl: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 201,
        json: async () => ({
          saved: true,
          extraction: { id: "20260817T100000Z-abcd1234", questionCount: 1, contentHash: "abcd1234ef567890" },
        }),
      };
    },
  });
  assert.equal(observed.url, CONFIG.endpoint);
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.headers["Content-Type"], "application/json");
  assert.equal(observed.init.headers["X-User-Id"], "gary");
  assert.equal(observed.init.headers["X-Api-Key"], "key-gary-123");
  assert.deepEqual(observed.body.questions, PAYLOAD.questions);
  assert.deepEqual(result, {
    saved: true,
    extraction: { id: "20260817T100000Z-abcd1234", questionCount: 1, contentHash: "abcd1234ef567890" },
  });
});

test("maps provider errors to CollectorError with status and code", async () => {
  await assert.rejects(
    collectExtraction(CONFIG, PAYLOAD, {
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: "invalid_questions", message: "questions 必须是非空数组。" } }),
      }),
    }),
    (error) => error instanceof CollectorError && error.status === 400
      && error.code === "invalid_questions" && /非空数组/.test(error.message),
  );
});

test("rejects an invalid endpoint before any network call", async () => {
  let calls = 0;
  await assert.rejects(
    collectExtraction({ ...CONFIG, endpoint: "ftp://bad" }, PAYLOAD, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("should not be called");
      },
    }),
    (error) => error instanceof CollectorError && error.code === "invalid_endpoint",
  );
  assert.equal(calls, 0);
});

test("surfaces a timeout error when the collector never responds", async () => {
  await assert.rejects(
    collectExtraction({ ...CONFIG, timeoutMs: 500 }, PAYLOAD, {
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
    }),
    (error) => error instanceof CollectorError && error.code === "collector_timeout",
  );
});

test("health check probes the endpoint's origin and reports latency", async () => {
  let observed;
  const result = await checkCollectorHealth(CONFIG, {
    fetchImpl: async (url, init) => {
      observed = { url, method: init.method, headers: init.headers };
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", service: "CyberWikiBench Collector", user: "gary" }),
      };
    },
  });
  assert.equal(observed.url, "http://127.0.0.1:8790/api/v1/health");
  assert.equal(observed.method, "GET");
  assert.equal(observed.headers["X-User-Id"], "gary");
  assert.equal(observed.headers["X-Api-Key"], "key-gary-123");
  assert.equal(result.ok, true);
  assert.equal(result.user, "gary");
  assert.equal(typeof result.latencyMs, "number");
});

test("auth headers are omitted in open mode and 401 maps to a credential error", async () => {
  let observed;
  await checkCollectorHealth({ ...CONFIG, userId: "", key: "" }, {
    fetchImpl: async (url, init) => {
      observed = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", service: "s", user: "default" }),
      };
    },
  });
  assert.equal(observed["X-User-Id"], undefined);
  assert.equal(observed["X-Api-Key"], undefined);

  await assert.rejects(
    checkCollectorHealth(CONFIG, {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "unauthorized", message: "用户 ID 或 Key 不正确。" } }),
      }),
    }),
    (error) => error instanceof CollectorError && error.status === 401
      && error.code === "unauthorized" && /Key/.test(error.message),
  );
});

test("health check maps non-2xx responses to typed errors", async () => {
  await assert.rejects(
    checkCollectorHealth(CONFIG, {
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "not_found", message: "API 路径不存在。" } }),
      }),
    }),
    (error) => error instanceof CollectorError && error.status === 404 && error.code === "not_found",
  );
});
