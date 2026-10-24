import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  AI_PROTOCOLS,
  AI_GATEWAY_CREDENTIAL_EPOCH_KEY as gatewayEpochKey,
  AI_PROVIDER_CREDENTIAL_EPOCH_KEY as epochKey,
  AI_PROVIDER_SETTINGS_LEGACY_KEY as legacyKey,
  AI_PROVIDER_SETTINGS_STORAGE_KEY as currentKey,
  loadAIProviderSettings as load,
  saveAIProviderSettings as save,
  removeAIProviderCredential as remove,
  removeAIGatewayCredential as removeGateway,
  validateAIProviderSettings as validate,
} from "./settings.ts";

const legacy = {
  protocol: "openai-compatible",
  baseURL: "https://models.example/v1",
  modelId: "model",
  apiKey: "sentinel-key",
};
function fixture() {
  const values = new Map();
  const denied = new Set();
  return {
    values,
    denied,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (denied.has(key)) throw new Error("storage denied");
      values.set(key, value);
    },
  };
}

test("optional context capacity validates token units and persists without breaking legacy settings", () => {
  const storage = fixture();
  assert.equal(save({ ...legacy, contextWindowTokens: 128000 }, storage).success, true);
  assert.equal(load(storage).contextWindowTokens, 128000);
  for (const contextWindowTokens of [16383, 2000001, 16384.5, "32768", NaN, Infinity]) {
    const result = validate({ ...legacy, contextWindowTokens });
    assert.equal(result.success, false);
    assert.ok(result.fieldErrors.contextWindowTokens);
  }
  assert.equal(validate(legacy).success, true);
});

test("migrates v1 to v2 Direct without losing values or changing the rollback record", () => {
  const storage = fixture();
  storage.setItem(legacyKey, JSON.stringify(legacy));
  const original = storage.getItem(legacyKey);
  assert.deepEqual(load(storage), { ...legacy, route: "direct" });
  assert.equal(storage.getItem(legacyKey), original);
  assert.deepEqual(JSON.parse(storage.getItem(currentKey)), {
    version: 2,
    credentialEpoch: 0,
    settings: { ...legacy, route: "direct" },
  });
  assert.deepEqual(load(storage), { ...legacy, route: "direct" });
});

test("failed migration leaves v1 intact and does not silently run with unpersisted settings", () => {
  const storage = fixture();
  storage.setItem(legacyKey, JSON.stringify(legacy));
  storage.denied.add(currentKey);
  assert.throws(() => load(storage), /storage permissions/);
  assert.equal(storage.getItem(currentKey), null);
  assert.deepEqual(JSON.parse(storage.getItem(legacyKey)), legacy);
});

test("v2 takes precedence; invalid/future records never silently fall back to v1", () => {
  for (const record of ["{", JSON.stringify({ version: 3 }), JSON.stringify({ version: 2, settings: legacy })]) {
    const storage = fixture();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    storage.setItem(currentKey, record);
    assert.throws(() => load(storage));
    assert.equal(storage.getItem(currentKey), record);
  }
  const storage = fixture();
  storage.setItem(currentKey, JSON.stringify({ version: 3, settings: legacy }));
  assert.throws(() => save(legacy, storage), /Unsupported/);
  assert.equal(JSON.parse(storage.getItem(currentKey)).version, 3);
});

test("explicit Save can repair known corrupt settings, while failed writes preserve the record", () => {
  const storage = fixture();
  storage.setItem(currentKey, "{");
  storage.denied.add(currentKey);
  assert.throws(() => save(legacy, storage));
  assert.equal(storage.getItem(currentKey), "{");
  storage.denied.clear();
  assert.equal(save(legacy, storage).success, true);
  assert.equal(load(storage).apiKey, legacy.apiKey);
});

test("validates all protocols/routes and rejects URL credentials and misplaced route fields", () => {
  for (const protocol of AI_PROTOCOLS) {
    for (const route of ["direct", "official", "self-hosted"]) {
      assert.equal(
        validate({
          ...legacy,
          protocol,
          route,
          ...(route === "self-hosted" ? { gatewayURL: "https://relay.example" } : {}),
        }).success,
        true,
      );
    }
  }
  for (const baseURL of [
    "https://user@models.example",
    "https://models.example?key=secret",
    "https://models.example#secret",
    "file:///tmp/key",
  ])
    assert.equal(validate({ ...legacy, baseURL }).success, false);
  assert.equal(validate({ ...legacy, protocol: "unknown" }).success, false);
  assert.equal(validate({ ...legacy, route: "self-hosted" }).success, false);
  assert.equal(validate({ ...legacy, route: "direct", gatewayToken: "secret" }).success, false);
});

test("credential removal sanitizes v2 and the rollback record, including a missing-v2 fallback", () => {
  const storage = fixture();
  storage.setItem(legacyKey, JSON.stringify(legacy));
  load(storage);
  assert.equal(remove(storage), true);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(JSON.parse(storage.getItem(legacyKey)).apiKey, undefined);
  storage.values.delete(currentKey);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(remove(storage), false);
});

test("failed revocation marker write reports failure without falsely claiming deletion", () => {
  const storage = fixture();
  save(legacy, storage);
  storage.denied.add(epochKey);
  assert.throws(() => remove(storage));
  assert.equal(load(storage).apiKey, legacy.apiKey);
});

for (const deniedKey of [currentKey, legacyKey]) {
  test(`interrupted ${deniedKey} cleanup cannot resurrect credentials and is retryable`, () => {
    const storage = fixture();
    storage.setItem(legacyKey, JSON.stringify(legacy));
    load(storage);
    storage.denied.add(deniedKey);
    assert.throws(() => remove(storage));
    assert.equal(load(storage).apiKey, undefined);
    storage.denied.clear();
    assert.equal(remove(storage), true);
    storage.values.delete(currentKey);
    assert.equal(load(storage).apiKey, undefined);
    assert.equal(save({ ...legacy, apiKey: "explicit-new-key" }, storage).success, true);
    assert.equal(load(storage).apiKey, "explicit-new-key");
  });
}

test("malformed legacy data cannot block removing a valid v2 credential", () => {
  const storage = fixture();
  save(legacy, storage);
  storage.setItem(legacyKey, "{");
  assert.equal(remove(storage), true);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(storage.getItem(legacyKey), "{");
});

test("invalid revocation metadata fails closed without rewriting settings", () => {
  const storage = fixture();
  save(legacy, storage);
  const original = storage.getItem(currentKey);
  storage.setItem(epochKey, "NaN");
  assert.throws(() => load(storage), /revocation/);
  assert.throws(() => save(legacy, storage), /revocation/);
  assert.equal(storage.getItem(currentKey), original);
});

const selfHosted = {
  ...legacy,
  route: "self-hosted",
  gatewayURL: "https://gateway.example.org",
  gatewayToken: "sentinel-gateway",
};
test("provider and gateway credentials can be removed independently", () => {
  const storage = fixture();
  save(selfHosted, storage);
  assert.equal(removeGateway(storage), true);
  assert.equal(load(storage).gatewayToken, undefined);
  assert.equal(load(storage).apiKey, legacy.apiKey);
  assert.equal(removeGateway(storage), false);
  save(selfHosted, storage);
  remove(storage);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(load(storage).gatewayToken, selfHosted.gatewayToken);
});

test("gateway revocation marker failure preserves credentials and reports failure", () => {
  const storage = fixture();
  save(selfHosted, storage);
  storage.denied.add(gatewayEpochKey);
  assert.throws(() => removeGateway(storage));
  assert.equal(load(storage).gatewayToken, selfHosted.gatewayToken);
});

test("interrupted gateway cleanup never resurrects a token, even after API key removal", () => {
  const storage = fixture();
  save(selfHosted, storage);
  storage.denied.add(currentKey);
  assert.throws(() => removeGateway(storage));
  assert.equal(load(storage).gatewayToken, undefined);
  assert.equal(load(storage).apiKey, legacy.apiKey);
  storage.denied.clear();
  remove(storage);
  assert.equal(load(storage).gatewayToken, undefined);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(removeGateway(storage), true);
  save(selfHosted, storage);
  assert.equal(load(storage).gatewayToken, selfHosted.gatewayToken);
});

test("gateway removal does not resurrect an independently revoked provider key", () => {
  const storage = fixture();
  save(selfHosted, storage);
  storage.denied.add(currentKey);
  assert.throws(() => remove(storage));
  storage.denied.clear();
  removeGateway(storage);
  assert.equal(load(storage).apiKey, undefined);
  assert.equal(load(storage).gatewayToken, undefined);
});

test("public gateways require HTTPS; only explicit local development can use HTTP", () => {
  for (const gatewayURL of [
    "http://gateway.example.org",
    "https://gateway.example.org?token=x",
    "https://user@gateway.example.org",
  ]) {
    assert.equal(validate({ ...selfHosted, gatewayURL }).success, false);
  }
  for (const gatewayURL of [
    "https://gateway.example.org",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])
    assert.equal(validate({ ...selfHosted, gatewayURL }).success, true);
});