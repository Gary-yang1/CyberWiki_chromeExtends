import assert from "node:assert/strict";
import test from "node:test";

import { retrieveContext } from "../src/rag/client.js";

test("retrieves, normalizes, and bounds local RAG context", async () => {
  let observed;
  const result = await retrieveContext({
    enabled: true,
    endpoint: "http://127.0.0.1:8787/retrieve",
    collection: "cyber-wiki",
    topK: 2,
    maxContextCharacters: 45,
  }, {
    stem: "What is the safest choice?",
    options: [{ key: "A", text: "one" }, { key: "B", text: "two" }],
  }, {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return {
        ok: true,
        json: async () => ({
          chunks: [
            { text: "A".repeat(600), source: "guide", score: 0.9 },
            { content: "Second supporting reference.", title: "notes", score: 0.8 },
          ],
        }),
      };
    },
  });

  assert.equal(observed.url, "http://127.0.0.1:8787/retrieve");
  assert.deepEqual(JSON.parse(observed.init.body), {
    query: "What is the safest choice?\nA. one\nB. two",
    top_k: 2,
    collection: "cyber-wiki",
  });
  assert.equal(result.enabled, true);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].source, "guide");
  assert.match(result.context, /来源：guide/);
  assert.ok(result.context.length <= 530);
});

test("does not invoke a retrieval service when RAG is disabled", async () => {
  const result = await retrieveContext({ enabled: false }, { stem: "irrelevant" }, {
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.deepEqual(result, { enabled: false, chunks: [], context: "" });
});
