import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { resolveConfig } from "../src/extension.ts";
import { testConfig } from "./helpers/config.mjs";

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

  assert.equal(config.gatewayUrl, "http://localhost:9377");
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

test("a partial nested object keeps its sibling defaults", (t) => {
  // The merge is field by field on purpose. Collapsing it to an object spread would reset every key
  // inside a section the caller only mentioned once.
  const configPath = withConfigFile(JSON.stringify({ cache: { serpMs: 1000 } }), t);
  const config = loadConfig({ configPath, env: {} });

  assert.equal(config.cache.serpMs, 1000);
  assert.equal(config.cache.pageMs, DEFAULT_CONFIG.cache.pageMs, "the untouched sibling survives");
});

test("a broken config file fails closed rather than falling through to the environment", (t) => {
  // Locks a contract, not a bug: resolveConfig's catch returns defaults without re-running the env
  // layer, and `error` is set, so every tool call dies with config_error instead of quietly talking
  // to whatever URL the environment happens to point at.
  const configPath = withConfigFile('{"gatewayUrl": 42}', t);
  const { config, usedDefaults, error } = resolveConfig({
    CAMOUFOX_CONFIG_PATH: configPath,
    CAMOUFOX_GATEWAY_URL: "http://env.wins:9377",
  });

  assert.equal(usedDefaults, true);
  assert.match(error, /gatewayUrl/u);
  assert.equal(config.gatewayUrl, DEFAULT_CONFIG.gatewayUrl, "env must not silently repoint a broken config");
});

test("a misspelled key inside a section is a hard error, not a silent default", (t) => {
  // `cache: { serpM: 1000 }` used to be accepted and keep its 30-minute default, which made a typo
  // look exactly like a setting that took effect. A typo inside a section has to fail for the same
  // reason `timeoutM` does, or the whole "unknown keys are errors" principle is decorative.
  const configPath = withConfigFile(JSON.stringify({ cache: { serpM: 1000 } }), t);

  assert.throws(
    () => loadConfig({ configPath, env: {} }),
    (err) => {
      const message = err.message;
      assert.match(message, /cache\.serpM/u, "names the section and the key together");
      assert.match(message, /pageMs, serpMs/u, "lists what it meant to accept");
      return true;
    },
  );
});

test("apiKey can be set in the file, and the environment still wins", (t) => {
  // `apiKey` is optional in the type, so it is absent from DEFAULT_CONFIG — which is what the
  // validator used to derive known keys from, making the documented setting unreadable from a file.
  const configPath = withConfigFile(JSON.stringify({ apiKey: "from-file" }), t);

  assert.equal(loadConfig({ configPath, env: {} }).apiKey, "from-file");
  assert.equal(loadConfig({ configPath, env: { CAMOUFOX_API_KEY: "from-env" } }).apiKey, "from-env");
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
  const configPath = withConfigFile(JSON.stringify({ gatewayUrl: "localhost:9377" }), t);

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

test("the rendering-wait settings default to a bounded poll", (t) => {
  const configPath = withConfigFile(undefined, t);
  const config = loadConfig({ configPath, env: {} });

  assert.equal(config.read.waitForSettleMs, DEFAULT_CONFIG.read.waitForSettleMs);
  assert.ok(config.read.waitForSettleMs > 0, "reads must wait for hydration by default");
  assert.ok(config.read.settlePollMs > 0 && config.read.settlePollMs < config.read.waitForSettleMs);
  assert.ok(config.read.settleMinChars > 0);
  assert.equal(config.network.allowPrivateHosts, false, "internal addresses are refused unless asked for");
});

test("waitForSettleMs accepts 0 as off, unlike the other read numbers", (t) => {
  const configPath = withConfigFile(JSON.stringify({ read: { waitForSettleMs: 0 } }), t);
  assert.equal(loadConfig({ configPath, env: {} }).read.waitForSettleMs, 0);

  // The other half of why `assertNonNegativeNumber` exists rather than reusing `assertFiniteNumber`:
  // without it, "off" and "a negative budget" are indistinguishable at load time.
  const negativeSettle = withConfigFile(JSON.stringify({ read: { waitForSettleMs: -1 } }), t);
  assert.throws(() => loadConfig({ configPath: negativeSettle, env: {} }), /read\.waitForSettleMs/u);

  const negative = withConfigFile(JSON.stringify({ read: { settlePollMs: -1 } }), t);
  assert.throws(() => loadConfig({ configPath: negative, env: {} }), /read\.settlePollMs/u);
});

test("a typo inside the network section is a hard error too", (t) => {
  const configPath = withConfigFile(JSON.stringify({ network: { allowPrivateHost: true } }), t);

  assert.throws(
    () => loadConfig({ configPath, env: {} }),
    (err) => {
      assert.match(err.message, /network\.allowPrivateHost/u);
      assert.match(err.message, /allowPrivateHosts/u, "lists what it meant to accept");
      return true;
    },
  );
});

test("network.allowPrivateHosts must be a real boolean", (t) => {
  const configPath = withConfigFile(JSON.stringify({ network: { allowPrivateHosts: "yes" } }), t);

  assert.throws(() => loadConfig({ configPath, env: {} }), /must be true or false/u);
});

test("CAMOUFOX_ALLOW_PRIVATE_HOSTS overrides the file, and nonsense is refused", (t) => {
  const configPath = withConfigFile(JSON.stringify({ network: { allowPrivateHosts: false } }), t);

  assert.equal(loadConfig({ configPath, env: { CAMOUFOX_ALLOW_PRIVATE_HOSTS: "1" } }).network.allowPrivateHosts, true);
  assert.equal(loadConfig({ configPath, env: { CAMOUFOX_ALLOW_PRIVATE_HOSTS: "false" } }).network.allowPrivateHosts, false);
  assert.throws(
    () => loadConfig({ configPath, env: { CAMOUFOX_ALLOW_PRIVATE_HOSTS: "maybe" } }),
    /CAMOUFOX_ALLOW_PRIVATE_HOSTS/u,
  );
});

test("the boolean env error lists every spelling the parser accepts", (t) => {
  // The message used to name two of the six, so `y` was refused with advice that could not have helped.
  const configPath = withConfigFile(undefined, t);

  assert.throws(
    () => loadConfig({ configPath, env: { CAMOUFOX_ALLOW_PRIVATE_HOSTS: "y" } }),
    /"1" \| "true" \| "yes" \| "on" \| "0" \| "false" \| "no" \| "off"/u,
  );
});

test("settings that cannot both be true are refused, naming both keys", (t) => {
  // Individually valid values that make the settle loop or the selector wait silently useless; see
  // `assertCoherent`.
  const neverPolled = withConfigFile(JSON.stringify({ read: { waitForSettleMs: 500, settlePollMs: 500 } }), t);
  assert.throws(
    () => loadConfig({ configPath: neverPolled, env: {} }),
    (err) => {
      assert.match(err.message, /read\.settlePollMs/u);
      assert.match(err.message, /read\.waitForSettleMs/u, "naming one key is not enough to fix it");
      return true;
    },
  );

  const unreachable = withConfigFile(JSON.stringify({ timeoutMs: 4000, read: { waitForTimeoutMs: 4000 } }), t);
  assert.throws(
    () => loadConfig({ configPath: unreachable, env: {} }),
    (err) => {
      assert.match(err.message, /read\.waitForTimeoutMs/u);
      assert.match(err.message, /timeoutMs/u);
      return true;
    },
  );
});

test("a disabled settle loop imposes no bound on the poll interval", (t) => {
  // `waitForSettleMs: 0` means "never poll", so a long `settlePollMs` is not a contradiction.
  const configPath = withConfigFile(JSON.stringify({ read: { waitForSettleMs: 0, settlePollMs: 5_000 } }), t);

  assert.equal(loadConfig({ configPath, env: {} }).read.waitForSettleMs, 0);
});

test("the test config helper refuses what the loader would refuse", () => {
  // `testConfig` builds configs without going through `loadConfig`, so it has to say no to a typo
  // itself. Without this, a misspelled override merges in unseen and the setting keeps its default,
  // which makes the test that set it describe a configuration it does not have.
  assert.throws(() => testConfig({ read: { settlePolllMs: 10 } }), /unknown test config key "read\.settlePolllMs"/u);
  assert.throws(() => testConfig({ network: { allowPrivateHost: true } }), /unknown test config key "network\.allowPrivateHost"/u);
  assert.throws(() => testConfig({ timeoutM: 1000 }), /unknown test config key "timeoutM"/u);
  assert.throws(() => testConfig({ read: 5 }), /"read" must be an object/u);

  // `apiKey` is valid but has no default, and the sections a test does set have to survive.
  assert.equal(testConfig({ apiKey: "sekret" }).apiKey, "sekret");
  assert.equal(testConfig({ read: { settlePollMs: 10 } }).read.settlePollMs, 10);
  assert.equal(testConfig({ read: { settlePollMs: 10 } }).read.waitForSettleMs, DEFAULT_CONFIG.read.waitForSettleMs);
});
