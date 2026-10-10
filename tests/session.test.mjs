import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { createCache } from "../src/cache.ts";
import { gatewaySessionId } from "../src/session.ts";
import { createExtension, resolveConfig } from "../src/extension.ts";

const CONFIG = {
  gatewayUrl: "http://gateway.test:9377",
  engines: [
    { name: "google", enabled: true },
    { name: "duckduckgo", enabled: true },
  ],
  cache: { serpMs: 60_000, pageMs: 60_000 },
  read: { defaultMaxChars: 12_000 },
  search: { maxResults: 10 },
  blockedHosts: [],
  timeoutMs: 2000,
};

function extensionFor(t, userId = "pi-abcdef", options = {}) {
  const fake = withFakeGateway(t, options);
  const client = createGatewayClient({ baseUrl: CONFIG.gatewayUrl, timeoutMs: 2000 });
  return { fake, client, extension: createExtension({ config: CONFIG, client, cache: createCache(), userId }) };
}

test("the gateway session id is stable, prefixed, and safe for a url path", () => {
  assert.equal(gatewaySessionId("abc-123"), gatewaySessionId("abc-123"));
  assert.notEqual(gatewaySessionId("abc-123"), gatewaySessionId("xyz-999"));
  const weird = gatewaySessionId("  weird id/../..  ");
  assert.match(weird, /^pi-[A-Za-z0-9._-]+$/u, `not url-safe: ${weird}`);
  assert.equal(weird.length <= 128, true);
});

test("teardown deletes the gateway session and repeating it is harmless", async (t) => {
  const { fake, extension } = extensionFor(t);

  await extension.shutdown();
  const first = fake.state.calls.filter((c) => c.method === "DELETE" && c.path === "/sessions/pi-abcdef");
  assert.equal(first.length, 1);

  await extension.shutdown();
  const after = fake.state.calls.filter((c) => c.method === "DELETE" && c.path === "/sessions/pi-abcdef");
  assert.equal(after.length, 2, "the second call is a no-op on the gateway, not an error");
  assert.equal(fake.liveTabs().length, 0);
});

test("an aborted search leaves no tab behind", async (t) => {
  const { client, extension } = extensionFor(t);
  const controller = new AbortController();
  controller.abort();

  const thrown = await extension.search({ query: "camoufox" }, { signal: controller.signal }).catch((e) => e);

  assert.equal(thrown.code, "aborted");
  assert.equal(client.openTabCount(), 0);
});

test("search leaves no tabs behind when it succeeds", async (t) => {
  const { client, extension } = extensionFor(t);
  await extension.search({ query: "camoufox" });
  assert.equal(client.openTabCount(), 0);
});

test("read leaves no tabs behind when it succeeds", async (t) => {
  const { client, extension } = extensionFor(t);
  await extension.read({ url: "https://example.test/page" });
  assert.equal(client.openTabCount(), 0);
});

test("a broken config file is surfaced instead of silently using defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-broken-"));
  const path = join(dir, "camoufox.json");
  writeFileSync(path, '{"gatewayTimout": 5}', "utf8");

  try {
    const { usedDefaults, error } = resolveConfig({ CAMOUFOX_CONFIG_PATH: path });
    assert.equal(usedDefaults, true);
    assert.match(error ?? "", /unknown config key/u);

    const client = createGatewayClient({ baseUrl: CONFIG.gatewayUrl, timeoutMs: 2000 });
    const extension = createExtension({
      config: CONFIG,
      client,
      cache: createCache(),
      userId: "pi-x",
      configError: error,
    });

    return extension.search({ query: "anything" }).then(
      () => assert.fail("should have refused to run"),
      (thrown) => {
        assert.equal(thrown.code, "config_error");
        assert.match(thrown.message, /unknown config key/u);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("an explicit config path that does not exist is a hard error, not defaults", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-missing-"));
  const path = join(dir, "nope.json");
  const client = createGatewayClient({ baseUrl: CONFIG.gatewayUrl, timeoutMs: 2000 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { usedDefaults, error } = resolveConfig({ CAMOUFOX_CONFIG_PATH: path });
  assert.equal(usedDefaults, true);
  assert.match(error ?? "", /was not found/u);

  const extension = createExtension({ config: CONFIG, client, cache: createCache(), userId: "pi-x", configError: error });
  const thrown = await extension.search({ query: "camoufox" }).catch((e) => e);
  assert.equal(thrown.code, "config_error");
  assert.match(thrown.message, /was not found/u);
});

test("with no config file present, the environment decides the gateway", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { config, usedDefaults, error } = resolveConfig({
    PI_CODING_AGENT_DIR: dir,
    CAMOUFOX_GATEWAY_URL: "http://env.wins:1234",
  });

  assert.equal(error, undefined);
  assert.equal(usedDefaults, false);
  assert.equal(config.gatewayUrl, "http://env.wins:1234");
});

test("the extension's read details carry metadata, not a second copy of the page", async (t) => {
  const { extension } = extensionFor(t);
  const outcome = await extension.read({ url: "https://example.test/page" });

  assert.ok(outcome.text.length > 0);
  assert.equal("text" in outcome.details, false);
  assert.equal(typeof outcome.details.totalChars, "number");
  assert.ok("truncated" in outcome.details);
});

test("a dead gateway costs one liveness probe per window, not one timeout per call", async (t) => {
  const fake = withFakeGateway(t);
  const client = createGatewayClient({
    baseUrl: CONFIG.gatewayUrl,
    timeoutMs: 100,
    fetchImpl: () => new Promise((_resolve, reject) => reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))),
  });
  const extension = createExtension({ config: CONFIG, client, cache: createCache(), userId: "pi-dead" });

  const first = await extension.search({ query: "camoufox" }).catch((e) => e);
  const second = await extension.search({ query: "camoufox again" }).catch((e) => e);

  assert.equal(first.code, "gateway_unreachable");
  assert.equal(second.code, "gateway_unreachable");
});

test("shutdown sweeps sessions in one call", async (t) => {
  const { fake, extension } = extensionFor(t);
  await extension.search({ query: "camoufox" });
  await extension.shutdown();
  assert.equal(fake.liveTabs().length, 0);
});
