/**
 * The registration surface, which no other test reaches.
 *
 * `session.test.mjs` drives the extension core directly, so a schema that drifts from the README, or
 * a description that stops telling the model about `resolve`/`offset`, would still ship green. This
 * file checks the contract with pi: what names, keys, and hints the model actually gets.
 */

import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerExtension from "../src/camoufox-gateway.ts";
import { DEFAULT_CONFIG, ENGINE_NAMES } from "../src/config.ts";
import { MAX_RESULTS_HARD_LIMIT } from "../src/tools/search.ts";
import { READ_DESCRIPTION, SEARCH_DESCRIPTION } from "../src/extension.ts";
import { withFakeGateway } from "./helpers/fake_gateway.mjs";

function stubPi() {
  const tools = [];
  const handlers = [];
  return {
    tools,
    handlers,
    registerTool(definition) {
      tools.push(definition);
    },
    on(event, handler) {
      handlers.push({ event, handler });
    },
  };
}

function registered() {
  const pi = stubPi();
  registerExtension(pi);
  return { pi, byName: Object.fromEntries(pi.tools.map((tool) => [tool.name, tool])) };
}

test("registers exactly the two documented tools and a shutdown hook", () => {
  const { pi, byName } = registered();

  assert.deepEqual(Object.keys(byName).sort(), ["camoufox_read", "camoufox_search"]);
  assert.deepEqual(pi.handlers.map((h) => h.event), ["session_shutdown"]);
});

test("the parameter objects match what README documents", () => {
  const { byName } = registered();

  assert.deepEqual(Object.keys(byName.camoufox_search.parameters.properties).sort(), ["engine", "n", "query", "resolve"]);
  assert.deepEqual(Object.keys(byName.camoufox_read.parameters.properties).sort(), ["fresh", "maxChars", "offset", "schema", "url", "waitFor"]);

  // Making a key optional is a contract change the model cannot see; only `query` and `url` need
  // to be supplied.
  assert.deepEqual([...byName.camoufox_search.parameters.required].sort(), ["query"]);
  assert.deepEqual([...byName.camoufox_read.parameters.required].sort(), ["url"]);

  // Both tools are read-only against the gateway but reach the open web. `idempotentHint` is the
  // substantive one for search: repeat calls are cheap because of the SERP cache, and dropping it
  // would let pi treat a second search as a side effect.
  for (const tool of Object.values(byName)) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(tool.annotations.idempotentHint, true);
  }
});

test("every parameter is described before anything dereferences it", () => {
  // Runs first on purpose: without this guard a renamed key fails later tests with
  // "cannot read properties of undefined" instead of naming the missing description.
  const { byName } = registered();

  for (const [tool, definition] of Object.entries(byName)) {
    for (const [key, property] of Object.entries(definition.parameters.properties)) {
      assert.ok(property?.description, `${tool}.${key} has no description for the model to act on`);
    }
  }
});

test("descriptions come from the core, not a second copy that can rot", () => {
  const { byName } = registered();

  assert.equal(byName.camoufox_search.description, SEARCH_DESCRIPTION);
  assert.equal(byName.camoufox_read.description, READ_DESCRIPTION);

  // The model only sees this text, so the choices it has to know about have to be in it.
  assert.match(byName.camoufox_search.description, /resolve:true/u);
  assert.match(byName.camoufox_read.description, /offset/u);
  assert.match(byName.camoufox_read.description, /waitFor/u);
});

test("parameter descriptions quote the code, so they cannot drift from it", () => {
  const { byName } = registered();

  const search = byName.camoufox_search.parameters.properties;
  const read = byName.camoufox_read.parameters.properties;

  // Quoted values, not literals: a default that moves in config must not leave the schema
  // promising the old number.
  assert.match(search.n.description, new RegExp(String(MAX_RESULTS_HARD_LIMIT), "u"), `"${search.n.description}" does not quote MAX_RESULTS_HARD_LIMIT`);
  for (const engine of ENGINE_NAMES) {
    assert.match(search.engine.description, new RegExp(engine, "u"), `"${search.engine.description}" is missing engine "${engine}"`);
  }
  assert.match(
    read.maxChars.description,
    new RegExp(String(DEFAULT_CONFIG.read.defaultMaxChars), "u"),
    `"${read.maxChars.description}" does not quote read.defaultMaxChars`,
  );
  assert.match(
    read.waitFor.description,
    new RegExp(String(DEFAULT_CONFIG.read.waitForTimeoutMs), "u"),
    `"${read.waitFor.description}" does not quote read.waitForTimeoutMs`,
  );
});

test("the registered tool enforces the configured address guard end to end", async (t) => {
  // Every other url-policy test builds its own client, which proves the rule but not the wiring: this
  // one goes through `pi.registerTool`, config loading, and the client the extension actually makes.
  const dir = mkdtempSync(join(tmpdir(), "camoufox-guard-"));
  const configPath = join(dir, "camoufox.json");
  writeFileSync(configPath, JSON.stringify({ gatewayUrl: "http://gateway.test:9377", blockedHosts: ["internal.test"] }), "utf8");
  // `loadConfig` applies the environment *after* the file, so any ambient CAMOUFOX_* knob would win
  // over this test's config — `CAMOUFOX_ALLOW_PRIVATE_HOSTS=1` in a shell or a CI job pointed at a
  // gateway on a LAN turns the guard off and the assertion reads as a product regression. Clear every
  // knob this test does not own, not just the config path.
  const ambient = Object.fromEntries(
    Object.keys(process.env).filter((key) => key.startsWith("CAMOUFOX_")).map((key) => [key, process.env[key]]),
  );
  const scrub = () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("CAMOUFOX_")) delete process.env[key];
  };
  scrub();
  process.env.CAMOUFOX_CONFIG_PATH = configPath;
  t.after(() => {
    scrub();
    Object.assign(process.env, ambient);
    rmSync(dir, { recursive: true, force: true });
  });

  const fake = withFakeGateway(t);
  const { byName } = registered();
  // Stable for the whole test, like production. A fresh id per call would build a new client every
  // time, so the cached per-session extension this test says it exercises would never be used.
  const ctx = { sessionManager: { getSessionId: () => "pi-guard-wiring" } };
  const call = (url) => byName.camoufox_read.execute("id", { url }, undefined, () => undefined, ctx);

  assert.match((await call("http://169.254.169.254/latest/meta-data/")).content[0].text, /private_network/u);
  assert.match((await call("https://internal.test/admin")).content[0].text, /host_blocked/u);
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0, "neither tab was opened, not even to be refused");

  // Two ordinary reads: they both open a tab, so they show whether one extension is being reused.
  for (const url of ["https://example.test/one", "https://example.test/two"]) {
    assert.match((await call(url)).content[0].text, new RegExp(`Page: ${url}`, "u"), "the guard still lets ordinary urls through");
  }
  const opens = fake.state.calls.filter((c) => c.path === "/tabs/open");
  assert.equal(opens.length, 2);
  assert.equal(new Set(opens.map((c) => c.body?.userId)).size, 1, "both reads ran through the one extension built for this session");
});

test("a session id we cannot derive is reported as our own fault", async () => {
  // Nothing was dialled and no gateway is involved, so the code has to say so. It used to reach the
  // model as `gateway_error`, which is how a broken session id started a gateway investigation.
  const { byName } = registered();
  const ctx = { sessionManager: { getSessionId: () => "   " } };

  const result = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, () => undefined, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "internal_error");
  assert.match(result.content[0].text, /^internal_error:/u);
  assert.equal(/(^|\n)gateway_error:/u.test(result.content[0].text), false);
});

test("a config that will not load lends no url to the error it produces", async (t) => {
  // The shipped default is `http://localhost:9377`. Quoting it while the user's own file sits broken
  // points them at a gateway they never configured, in the one message they are reading closely.
  const dir = mkdtempSync(join(tmpdir(), "camoufox-failing-"));
  const configPath = join(dir, "camoufox.json");
  writeFileSync(configPath, '{ "gatewayTimout": 5 }', "utf8");
  const ambient = Object.fromEntries(
    Object.keys(process.env).filter((key) => key.startsWith("CAMOUFOX_")).map((key) => [key, process.env[key]]),
  );
  const scrub = () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("CAMOUFOX_")) delete process.env[key];
  };
  scrub();
  process.env.CAMOUFOX_CONFIG_PATH = configPath;
  t.after(() => {
    scrub();
    Object.assign(process.env, ambient);
    rmSync(dir, { recursive: true, force: true });
  });

  const fake = withFakeGateway(t);
  const { byName } = registered();
  const ctx = { sessionManager: { getSessionId: () => "pi-broken-config" } };

  const result = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, () => undefined, ctx);

  assert.match(result.content[0].text, /^config_error:/u);
  assert.match(result.content[0].text, /unknown config key/u, "the key that is actually wrong");
  assert.match(result.content[0].text, /Nothing was sent to the gateway/u);
  assert.equal(result.content[0].text.includes(DEFAULT_CONFIG.gatewayUrl), false, `must not name "${DEFAULT_CONFIG.gatewayUrl}"`);
  // Counted, so "nothing was attempted" is a fact about the gateway rather than a sentence in a message.
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0, "a config fault opens no tab");
  assert.equal(fake.state.calls.filter((c) => c.path.endsWith("/snapshot")).length, 0, "and reads no page");
  assert.equal(/(^|\n)gateway_error:/u.test(result.content[0].text), false, "a config fault is not a gateway fault");
});

test("the fresh parameter points at the setting rather than a copy of its value", () => {
  const description = registered().byName.camoufox_read.parameters.properties.fresh.description ?? "";
  // Interpolating the resolved TTL would tell a user who set `cache.pageMs` something about their own
  // config that was not true, and this extension has no way to know it at schema-build time.
  assert.match(description, /cache\.pageMs/u);
  assert.doesNotMatch(description, /\d+\s*(minute|second|hour)/u);
});
