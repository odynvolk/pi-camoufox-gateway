import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

function withConfigFile(contents, t) {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-config-"));
  const configPath = join(dir, "camoufox.json");
  if (contents !== undefined) writeFileSync(configPath, contents, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return configPath;
}

test("returns defaults when nothing is configured", (t) => {
  const configPath = withConfigFile(undefined, t);
  const config = loadConfig({ configPath, env: {} });

  assert.equal(config.gatewayUrl, "http://192.168.8.110:9377");
  assert.equal(config.read.defaultMaxChars, DEFAULT_CONFIG.read.defaultMaxChars);
  assert.equal(config.search.maxResults, 10);
  assert.deepEqual(config.blockedHosts, []);
  assert.equal(config.engines[0].name, "google");
  assert.equal(config.apiKey, undefined);
});

test("config file overrides defaults", (t) => {
  const configPath = withConfigFile(
    JSON.stringify({
      gatewayUrl: "http://localhost:9377",
      read: { defaultMaxChars: 5000 },
      engines: [{ name: "duckduckgo", enabled: true }],
    }),
    t,
  );
  const config = loadConfig({ configPath, env: {} });

  assert.equal(config.gatewayUrl, "http://localhost:9377");
  assert.equal(config.read.defaultMaxChars, 5000);
  assert.equal(config.engines[0].name, "duckduckgo");
  // unrelated defaults survive a partial file
  assert.equal(config.search.maxResults, 10);
});

test("environment overrides the config file", (t) => {
  const configPath = withConfigFile(JSON.stringify({ gatewayUrl: "http://localhost:9377" }), t);
  const config = loadConfig({
    configPath,
    env: { CAMOUFOX_GATEWAY_URL: "http://10.0.0.5:9377", CAMOUFOX_API_KEY: "sekret" },
  });

  assert.equal(config.gatewayUrl, "http://10.0.0.5:9377");
  assert.equal(config.apiKey, "sekret");
});

test("reports the file and key that broke a malformed config", (t) => {
  const configPath = withConfigFile('{"gatewayUrl": 42}', t);

  assert.throws(
    () => loadConfig({ configPath, env: {} }),
    (err) => {
      assert.match(err.message, /camoufox\.json/);
      assert.match(err.message, /gatewayUrl/);
      return true;
    },
  );
});

test("rejects a gateway URL without a scheme", (t) => {
  const configPath = withConfigFile(JSON.stringify({ gatewayUrl: "192.168.8.110:9377" }), t);

  assert.throws(() => loadConfig({ configPath, env: {} }), /http:\/\/ or https:\/\/|scheme/u);
});

test("rejects unknown config keys instead of silently ignoring them", (t) => {
  const configPath = withConfigFile(JSON.stringify({ gatewayTimout: 5000 }), t);

  assert.throws(() => loadConfig({ configPath, env: {} }), /unknown config key/u);
});

test("an explicitly configured config path that does not exist is a hard error", () => {
  assert.throws(
    () => loadConfig({ env: { CAMOUFOX_CONFIG_PATH: "/tmp/definitely-not-here/camoufox.json" } }),
    /not found/u,
  );
});
