import assert from "node:assert/strict";
import test from "node:test";

const localState = {};
const storageListeners = new Set();

globalThis.chrome = {
  runtime: { lastError: null },
  permissions: {
    contains(_request, callback) { callback(true); },
    request(_request, callback) { callback(true); },
  },
  storage: {
    local: {
      get(key, callback) {
        callback({ [key]: localState[key] });
      },
      set(values, callback) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = localState[key];
          localState[key] = value;
          changes[key] = { oldValue, newValue: value };
        }
        callback();
        storageListeners.forEach((listener) => listener(changes, "local"));
      },
    },
    onChanged: {
      addListener(listener) { storageListeners.add(listener); },
      removeListener(listener) { storageListeners.delete(listener); },
    },
  },
};

const {
  STORAGE_KEY,
  getSettings,
  hasOriginPermission,
  listProfiles,
  originPermissionPattern,
  requestOriginPermission,
  requestOriginsPermission,
  saveProfile,
  subscribeToSettings,
} = await import("../src/shared/storage.js");

function resetSettings() {
  localState[STORAGE_KEY] = {
    profiles: [{
      id: "existing",
      name: "Existing model",
      protocol: "openai_chat_completions",
      endpoint: "https://api.openai.com/v1/chat/completions",
      modelsEndpoint: "/v1/models",
      model: "gpt-test",
      apiKey: "saved-secret",
      authMode: "api_key",
      enabled: true,
    }],
    defaultProfileId: "existing",
  };
}

test("preserves an existing key for sanitized profile updates and hides it from UI snapshots", async () => {
  resetSettings();
  const saved = await saveProfile({
    id: "existing",
    name: "Renamed model",
    protocol: "openai_chat_completions",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelsEndpoint: "/v1/models",
    model: "gpt-test",
    authMode: "api_key",
    enabled: true,
  });

  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.hasApiKey, true);
  const raw = await getSettings();
  assert.equal(raw.profiles[0].apiKey, "saved-secret");
  assert.equal(raw.profiles[0].modelsEndpoint, "/v1/models");
  const publicProfiles = await listProfiles();
  assert.equal(publicProfiles[0].apiKey, undefined);
  assert.equal(publicProfiles[0].hasApiKey, true);
});

test("notifies subscribers with normalized secret-free snapshots and can unsubscribe", () => {
  resetSettings();
  const received = [];
  const unsubscribe = subscribeToSettings((settings) => received.push(settings));
  storageListeners.forEach((listener) => listener({
    [STORAGE_KEY]: { newValue: localState[STORAGE_KEY] },
  }, "local"));

  assert.equal(received.length, 1);
  assert.equal(received[0].profiles[0].apiKey, undefined);
  assert.equal(received[0].profiles[0].hasApiKey, true);
  unsubscribe();
  storageListeners.forEach((listener) => listener({
    [STORAGE_KEY]: { newValue: localState[STORAGE_KEY] },
  }, "local"));
  assert.equal(received.length, 1);
});

test("requests an exact http(s) origin without a preflight permission lookup", async () => {
  const requests = [];
  globalThis.chrome.permissions.request = (request, callback) => {
    requests.push(request);
    callback(true);
  };

  assert.equal(originPermissionPattern("https://ks.wjx.com/vm/h7YPeR0.aspx"), "https://ks.wjx.com/*");
  assert.equal(await requestOriginPermission("https://ks.wjx.com/vm/h7YPeR0.aspx"), true);
  assert.deepEqual(requests, [{ origins: ["https://ks.wjx.com/*"] }]);
  assert.throws(() => originPermissionPattern("chrome://extensions"), /http 或 https/);
});

test("checks an existing origin permission without requesting it again", async () => {
  const checks = [];
  let requestCount = 0;
  globalThis.chrome.permissions.contains = (request, callback) => {
    checks.push(request);
    callback(true);
  };
  globalThis.chrome.permissions.request = (_request, callback) => {
    requestCount += 1;
    callback(true);
  };

  assert.equal(await hasOriginPermission("https://api.openai.com/v1/models"), true);
  assert.deepEqual(checks, [{ origins: ["https://api.openai.com/*"] }]);
  assert.equal(requestCount, 0);
});

test("requests multiple distinct origins in one user-gesture API call", async () => {
  const requests = [];
  globalThis.chrome.permissions.request = (request, callback) => {
    requests.push(request);
    callback(true);
  };

  assert.equal(await requestOriginsPermission([
    "http://127.0.0.1:8765/api/v1",
    "http://127.0.0.1:8787/retrieve",
    "http://127.0.0.1:8765/health",
  ]), true);
  assert.deepEqual(requests, [{ origins: [
    "http://127.0.0.1:8765/*",
    "http://127.0.0.1:8787/*",
  ] }]);
});
