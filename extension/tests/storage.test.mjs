import assert from "node:assert/strict";
import test from "node:test";

const localState = {};
const storageListeners = new Set();

globalThis.chrome = {
  runtime: { lastError: null },
  permissions: {
    contains(_request, callback) { callback(true); },
    request(_request, callback) { callback(true); },
    getAll(_callback) { callback({ origins: [] }); },
    remove(_request, callback) { callback(false); },
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
  DEFAULT_OVERLAY_SETTINGS,
  STORAGE_KEY,
  getSettings,
  hasOriginPermission,
  isRequiredOriginPattern,
  listGrantedOrigins,
  listProfiles,
  originPermissionPattern,
  removeOriginPermission,
  requestOriginPermission,
  requestOriginsPermission,
  saveProfile,
  saveSettings,
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

test("lists granted origins and treats manifest-required patterns as fixed", async () => {
  globalThis.chrome.permissions.getAll = (callback) => {
    callback({
      origins: [
        "chrome-extension://extension-id/*",
        "http://localhost/*",
        "https://ks.wjx.com/*",
        "http://127.0.0.1:8787/*",
      ],
    });
  };
  const removals = [];
  globalThis.chrome.permissions.remove = (request, callback) => {
    removals.push(request);
    // Chrome cannot remove manifest-required permissions; simulate that.
    callback(request.origins[0] !== "http://localhost/*");
  };

  assert.deepEqual(await listGrantedOrigins(), [
    "http://127.0.0.1:8787/*",
    "http://localhost/*",
    "https://ks.wjx.com/*",
  ]);
  assert.equal(isRequiredOriginPattern("http://localhost/*"), true);
  assert.equal(isRequiredOriginPattern("http://127.0.0.1/*"), true);
  assert.equal(isRequiredOriginPattern("https://ks.wjx.com/*"), false);

  assert.equal(await removeOriginPermission("https://ks.wjx.com/*"), true);
  assert.equal(await removeOriginPermission("http://localhost/*"), false);
  assert.deepEqual(removals, [
    { origins: ["https://ks.wjx.com/*"] },
    { origins: ["http://localhost/*"] },
  ]);
});

test("stealth overlay defaults to false and can be enabled", async () => {
  resetSettings();
  const saved = await saveSettings({
    overlay: { enabled: true, stealth: true },
  });
  assert.equal(saved.overlay.stealth, true);
  assert.equal(saved.overlay.stealthOpacity, 0.08);

  const saved2 = await saveSettings({
    overlay: { enabled: true, stealth: "yes" },
  });
  assert.equal(saved2.overlay.stealth, false);

  // stealthOpacity is clamped to [0.01, 0.3]
  const saved3 = await saveSettings({
    overlay: { enabled: true, stealth: true, stealthOpacity: 0.5 },
  });
  assert.equal(saved3.overlay.stealthOpacity, 0.3);

  const saved4 = await saveSettings({
    overlay: { enabled: true, stealth: true, stealthOpacity: 0.001 },
  });
  assert.equal(saved4.overlay.stealthOpacity, 0.01);
});

test("normalizes and persists low-interference overlay preferences", async () => {
  resetSettings();
  const saved = await saveSettings({
    overlay: {
      enabled: true,
      opacity: 0.1,
      clickThrough: true,
      collapsed: false,
      position: { right: -20, bottom: 42 },
    },
  });

  assert.deepEqual(saved.overlay, {
    enabled: true,
    stealth: false,
    stealthOpacity: 0.08,
    opacity: 0.3,
    clickThrough: true,
    collapsed: false,
    position: { right: 8, bottom: 42 },
  });
  const raw = await getSettings();
  assert.deepEqual(raw.overlay, saved.overlay);

  resetSettings();
  assert.deepEqual((await getSettings()).overlay, DEFAULT_OVERLAY_SETTINGS);
});

test("normalizes collector settings and merges them into saved patches", async () => {
  resetSettings();
  const saved = await saveSettings({
    collector: {
      enabled: true,
      endpoint: " http://127.0.0.1:8790/api/v1/extractions ",
      timeoutMs: 100,
    },
  });
  assert.deepEqual(saved.collector, {
    enabled: true,
    endpoint: "http://127.0.0.1:8790/api/v1/extractions",
    timeoutMs: 500,
  });

  // A later patch without collector keys must not clobber the section.
  await saveSettings({ routing: { mode: "balanced" } });
  assert.equal((await getSettings()).collector.enabled, true);

  resetSettings();
  assert.deepEqual(
    (await getSettings()).collector,
    {
      enabled: false,
      endpoint: "http://127.0.0.1:8790/api/v1/extractions",
      timeoutMs: 5_000,
    },
  );
});
