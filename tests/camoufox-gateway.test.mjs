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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Check } from "typebox/value";

import registerExtension from "../src/camoufox-gateway.ts";
import { DEFAULT_CONFIG, ENGINE_NAMES, MAX_SEARCH_RESULTS } from "../src/config.ts";
import { describeAge, READ_DESCRIPTION, SEARCH_DESCRIPTION } from "../src/extension.ts";
import { withFakeGateway, opens } from "./helpers/fake_gateway.mjs";
import { stageClock } from "./helpers/clock.mjs";

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

/**
 * Point the extension at a config file, with every ambient knob cleared.
 *
 * `loadConfig` applies the environment after the file, so a shell with `CAMOUFOX_GATEWAY_URL` set turns
 * any of these tests into a run against a gateway nobody configured.
 */
function withConfigFile(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-config-"));
  const configPath = join(dir, "camoufox.json");
  writeFileSync(configPath, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
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
  return configPath;
}

/**
 * One session per test, as production has one per pi session: a fresh id builds a fresh client.
 *
 * A function rather than one shared object because the fake gateway keys some of its own behaviour
 * (`consentWallOn`) on the *gateway* user id, which is this id prefixed by `session.ts`.
 */
function session(name) {
  return { ctx: { sessionManager: { getSessionId: () => name } }, userId: `pi-${name}` };
}

/**
 * That an argument reaches the tool through the *declared* surface and not past it.
 *
 * `execute` takes whatever it is handed, so an argument the schema never declared still works here —
 * which is exactly how a parameter can be tested while it does not exist. Both halves are needed:
 * `Check` proves the declared schema admits the value, and the key list proves the parameter is one a
 * caller was ever told about, since the declared properties are the only list a model is shown.
 */
function assertCallable(tool, args, label) {
  const declared = Object.keys(tool.parameters.properties);
  for (const key of Object.keys(args)) {
    assert.ok(declared.includes(key), `${label}: "${key}" is not a declared parameter, so pi would never forward it`);
  }
  assert.equal(Check(tool.parameters, args), true, `${label}: the declared schema rejects a call this test is making`);
}

/** Nothing a tool returns may carry a key its own `outputSchema` does not declare. */
function assertDeclaredBy(schema, value, label) {
  const declared = Object.keys(schema.properties);
  const extra = Object.keys(value).filter((key) => !declared.includes(key));
  assert.deepEqual(extra, [], `${label} returns keys its outputSchema does not declare`);
  const missing = (schema.required ?? []).filter((key) => !(key in value));
  assert.deepEqual(missing, [], `${label} is missing keys its outputSchema requires`);
}

test("registers exactly the two documented tools and a shutdown hook", () => {
  const { pi, byName } = registered();

  assert.deepEqual(Object.keys(byName).sort(), ["camoufox_read", "camoufox_search"]);
  assert.deepEqual(pi.handlers.map((h) => h.event), ["session_shutdown"]);
});

test("one session's shutdown releases only its own gateway session", async (t) => {
  // Two runtimes, one module-level map — production's shape. pi gives each session its own extension
  // runtime, so each registers its own handler, while `extensions` is shared by the whole process.
  // Tearing down everything in it meant one session's quit deleted every other session's client, cache,
  // and gateway-side tabs.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const quitting = registered();
  const surviving = registered();
  const a = session("pi-shutdown-a");
  const b = session("pi-shutdown-b");

  for (const [tools, s] of [[quitting.byName, a], [surviving.byName, b]]) {
    const built = await tools.camoufox_search.execute("id", { query: "camoufox" }, undefined, undefined, s.ctx);
    assert.equal(built.isError, undefined, `session ${s.userId} could not start`);
  }

  const deletionsFor = (userId) =>
    fake.state.calls.filter((call) => call.method === "DELETE" && call.path === `/sessions/${userId}`).length;
  const handler = quitting.pi.handlers.find((entry) => entry.event === "session_shutdown").handler;

  await handler({ type: "session_shutdown", reason: "quit" }, a.ctx);

  assert.equal(deletionsFor(a.userId), 1, "the session that shut down is the one released");
  assert.equal(deletionsFor(b.userId), 0, "a session still running keeps its tabs, client, and cache");

  const after = await surviving.byName.camoufox_search.execute("id", { query: "camoufox again" }, undefined, undefined, b.ctx);
  assert.equal(after.isError, undefined, "and it keeps answering afterwards");

  // Reload, session replacement, and process exit can converge on the same handler.
  await handler({ type: "session_shutdown", reason: "reload" }, a.ctx);
  assert.equal(deletionsFor(a.userId), 1, "a second shutdown for the same session is a no-op, not an error");
});

test("a shutdown whose session id cannot be derived releases nothing, and says nothing", async (t) => {
  // Teardown stays total. An id the sanitizer empties cannot name a session on the gateway, so there is
  // nothing of ours to release — and the same unusable id already stopped this session registering an
  // entry, so the only thing a throw here could achieve is an error at shutdown over nothing.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const handler = registered().pi.handlers.find((entry) => entry.event === "session_shutdown").handler;

  // Not rejecting *is* one of the two assertions: node:test fails this test if the handler throws.
  await handler({ type: "session_shutdown", reason: "quit" }, { sessionManager: { getSessionId: () => "///" } });

  assert.equal(
    fake.state.calls.filter((call) => call.method === "DELETE").length,
    0,
    "a session we cannot name is not a session we can release",
  );
});

test("a shutdown over a context that cannot answer still says so", async () => {
  // Only the derivation's own fault is swallowed. A `ctx` that throws on being read is a pi-side fault,
  // and swallowing it would leave a session unreleased with nothing reported — the class of bug this
  // handler exists to close.
  const handler = registered().pi.handlers.find((entry) => entry.event === "session_shutdown").handler;

  await assert.rejects(
    () =>
      handler(
        { type: "session_shutdown", reason: "quit" },
        {
          get sessionManager() {
            throw new Error("extension context invalidated");
          },
        },
      ),
    /extension context invalidated/u,
    "a fault that is not about the id must not be mistaken for one",
  );
});

test("the parameter objects match what README documents", () => {
  const { byName } = registered();

  assert.deepEqual(Object.keys(byName.camoufox_search.parameters.properties).sort(), ["engine", "n", "query", "resolve"]);
  assert.deepEqual(Object.keys(byName.camoufox_read.parameters.properties).sort(), ["fresh", "maxAgeMs", "maxChars", "offset", "schema", "url", "waitFor"]);

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

test("README states the read signature the schema actually declares", () => {
  // The signature line is what a reader copies into a call, and it is the one place the whole parameter
  // list is written down outside the schema. Read off `README.md` rather than kept beside it: a second
  // copy of a list is a list that drifts, which is the same defect the description tests above exist for.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const signature = readme.match(/^### `camoufox_read\(([^)]*)\)`$/mu);
  assert.ok(signature, "README still carries the camoufox_read signature line");

  const documented = signature[1].split(", ").map((entry) => entry.trim().replace(/\?$/u, ""));
  assert.deepEqual(
    documented,
    Object.keys(registered().byName.camoufox_read.parameters.properties),
    "the order in README is the order the schema declares, and neither has a parameter the other lacks",
  );
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

test("a numeric parameter declares the type the tool actually accepts", () => {
  // Nothing in this repo validates tool arguments — pi checks none, and there is no `Value.Check` on
  // ours — so the declared `type` and `description` are the only signal a model gets before it calls.
  // A `Number` offering a fraction, a negative, or a string is a promise `src/tools/read.ts` breaks, which is
  // the reason `n` is already an `Integer`; these two were left behind by that ruling.
  const { byName } = registered();
  const read = byName.camoufox_read.parameters.properties;

  assert.equal(read.maxChars.type, "integer", "the guard refuses every other kind of number");
  assert.equal(read.offset.type, "integer", "and refuses a string or a fraction for the offset too");

  // The type name does not carry the floor, and `Integer` still admits values the guard refuses, so the
  // sentence has to. Naming the code is what lets a model stop retrying the same call.
  assert.match(read.maxChars.description, /1 or more/u, `"${read.maxChars.description}"`);
  assert.match(read.offset.description, /0 or more/u, `"${read.offset.description}"`);
  for (const key of ["maxChars", "offset"]) {
    assert.match(read[key].description, /unsupported/u, "and says how a refusal is coded");
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

test("the read description tells the model a staleness tolerance is one it can ask for", () => {
  // `fresh` is in the text because a model cannot otherwise know to reach for it, and `maxAgeMs` is the
  // other half of the same question — refused together, so a caller who knows neither can only guess.
  // One clause is the budget: this text is sent on every call, whatever the call was about.
  const { byName } = registered();

  assert.equal(byName.camoufox_read.description, READ_DESCRIPTION, "the surface still uses the exported constant");
  assert.match(byName.camoufox_read.description, /maxAgeMs/u, "the parameter has to be named, or nobody calls it");
  assert.match(byName.camoufox_read.description, /fresh/u, "and so does the knob it is refused alongside");
  // Every other duration in this repo is milliseconds and Jina's tolerance is seconds, so a description
  // that names the key without its unit is how a model asks for half an hour and gets thirty milliseconds.
  assert.match(byName.camoufox_read.description, /milliseconds/u, "the unit belongs in the one sentence the model reads");
  assert.match(byName.camoufox_read.description, /cach/u, "and so does what the number bounds: a stored page, not a wait");
});

test("parameter descriptions quote structural values and name the key for anything overridable", () => {
  const { byName } = registered();

  const search = byName.camoufox_search.parameters.properties;
  const read = byName.camoufox_read.parameters.properties;

  // Structural: one engine page is this wide whatever anyone configures, so quoting the number is
  // quoting a fact. Same for the engine names — but these two moved out of the description and into the
  // schema's own `enum`, which is where a name belongs: readable by the model, checkable by a caller, and
  // not a sentence that can drift away from the set it describes. Asserted against `enum`, so the guard
  // still holds the fact; the sentence no longer has to carry it.
  const nDescription = search.n.description;
  assert.match(nDescription, new RegExp(String(MAX_SEARCH_RESULTS), "u"), `"${nDescription}" does not quote MAX_SEARCH_RESULTS`);
  for (const engine of ENGINE_NAMES) {
    assert.ok(search.engine.enum.includes(engine), `"${JSON.stringify(search.engine.enum)}" is missing engine "${engine}"`);
  }

  // Overridable: these numbers belong to the user's config, which is read after this module is
  // imported. Interpolating `DEFAULT_CONFIG` here — which is what this test used to require — states a
  // resolved default as a promise, and is false for anyone who set the key. So the description names
  // the key and quotes no number a config file could contradict.
  assert.match(read.maxChars.description, /read\.defaultMaxChars/u, `"${read.maxChars.description}" does not name read.defaultMaxChars`);
  assert.match(read.maxChars.description, /read\.maxCharsCeiling/u, "the ceiling belongs in the same sentence as the budget it bounds");
  assert.equal(
    read.maxChars.description.includes(String(DEFAULT_CONFIG.read.defaultMaxChars)),
    false,
    `"${read.maxChars.description}" quotes a number a user's config can contradict`,
  );
  assert.match(read.waitFor.description, /read\.waitForTimeoutMs/u, `"${read.waitFor.description}" does not name read.waitForTimeoutMs`);
  assert.equal(
    read.waitFor.description.includes(String(DEFAULT_CONFIG.read.waitForTimeoutMs)),
    false,
    `"${read.waitFor.description}" quotes a number a user's config can contradict`,
  );
});

test("the configured timeoutMs is the deadline a call actually obeys", async (t) => {
  // The client used to carry its own `?? 30_000`, so a hand-built one ran on a deadline no document
  // mentioned and the number in the README could stop being the one that fires. It is required now, and
  // this is the wiring that proves it: 250ms from a config file, through `pi.registerTool`, into the
  // request the hung fake is still answering.
  const dir = mkdtempSync(join(tmpdir(), "camoufox-timeout-"));
  const configPath = join(dir, "camoufox.json");
  // `read.waitForTimeoutMs` has to stay under `timeoutMs` for the config to be coherent at all — the
  // rule that already refuses the contradictory pair, so this fixture has to satisfy it.
  const fixture = { gatewayUrl: "http://gateway.test:9377", timeoutMs: 250, read: { waitForTimeoutMs: 120 } };
  writeFileSync(configPath, JSON.stringify(fixture), "utf8");
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

  // Long enough that answering at all would mean the client never cut it off; short enough that the
  // uncancellable fake timer does not become the suite's wall clock.
  withFakeGateway(t, { hangUrls: new Set(["https://slow.test/"]), hangForMs: 1_000 });
  const { byName } = registered();
  const ctx = { sessionManager: { getSessionId: () => "pi-configured-timeout" } };

  const started = Date.now();
  const result = await byName.camoufox_read.execute("id", { url: "https://slow.test/" }, undefined, () => undefined, ctx);

  // The message is only half of it: pi branches on `isError`, and a deadline that renders but never
  // flags is a different bug. Assert the shape, then the prose.
  assert.equal(result.isError, true, "an aborted call has to reach pi as a tool failure");
  // Both result shapes are 1-tuples by type (`ToolFailure`, and the two success returns), so pin the
  // tuple rather than defaulting it away: `content[0]?.text ?? ""` would make an empty array and an
  // empty message indistinguishable, which is less diagnostic than the crash it avoids.
  assert.equal(result.content.length, 1, "a tool result carries exactly one text block");
  const text = result.content[0].text;

  assert.match(text, /^timeout:/u, `"${text}" is not a deadline`);
  assert.match(text, /within 250ms/u, "the message names the configured number, not a default it invented");
  assert.ok(Date.now() - started < 5_000, "the call outlived its deadline instead of being aborted at 250ms");
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
  // What this pins: a config fault is coded `config_error`, says nothing was sent, and names no
  // address. It is not the case that reaches the url a `gateway_unreachable` prints — `guard()` refuses
  // before anything is dialled — so where that url comes from is pinned separately, below.
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

test("the url a dead gateway names is the one this client was built with", async (t) => {
  // A pin on provenance, not a reproduced regression: the address in a failure message has to come from
  // the client that made the call. Read config on the error path instead and the second call below —
  // the one whose file is gone — prints a shipped default for a gateway nothing was dialled at.
  const dir = mkdtempSync(join(tmpdir(), "camoufox-provenance-"));
  const configPath = join(dir, "camoufox.json");
  writeFileSync(configPath, JSON.stringify({ gatewayUrl: "http://gateway.test:9377" }), "utf8");
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

  withFakeGateway(t, { unreachable: true });
  const { byName } = registered();
  // One session id for both calls, as in production: a fresh one would build a second client, and the
  // second message would then say nothing about the client the first one used.
  const ctx = { sessionManager: { getSessionId: () => "pi-url-provenance" } };
  const call = () => byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, () => undefined, ctx);

  const whileConfigured = await call();
  assert.equal(whileConfigured.details.code, "gateway_unreachable");
  assert.match(whileConfigured.content[0].text, /gateway\.test:9377/u, "the address this client dials");

  rmSync(configPath);

  const afterRemoval = await call();
  assert.equal(afterRemoval.details.code, "gateway_unreachable");
  assert.match(afterRemoval.content[0].text, /gateway\.test:9377/u, "still the client's own address with the file gone");
  assert.equal(
    afterRemoval.content[0].text.includes(DEFAULT_CONFIG.gatewayUrl),
    false,
    `a removed file must not put "${DEFAULT_CONFIG.gatewayUrl}" in the message`,
  );
});

test("the fresh parameter points at the setting rather than a copy of its value", () => {
  const description = registered().byName.camoufox_read.parameters.properties.fresh.description ?? "";
  // Interpolating the resolved TTL would tell a user who set `cache.pageMs` something about their own
  // config that was not true, and this extension has no way to know it at schema-build time.
  assert.match(description, /cache\.pageMs/u);
  assert.doesNotMatch(description, /\d+\s*(minute|second|hour)/u);
});

test("the staleness tolerance declares what the guard holds it to, and quotes no config number", () => {
  // Same three things `maxChars` and `offset` are held to, for the same reason: nothing validates tool
  // arguments, so the declared type and this sentence are the only signal a model gets before it calls.
  const maxAgeMs = registered().byName.camoufox_read.parameters.properties.maxAgeMs;

  assert.equal(maxAgeMs.type, "integer", "the guard refuses a fraction, a string and a negative alike");
  assert.ok(maxAgeMs.description, "described, like every other parameter");
  // `0` is the floor and it is legal — it is `fresh` spelled in milliseconds — so the sentence has to say
  // it, because `Integer` alone admits the negatives the guard refuses.
  assert.match(maxAgeMs.description, /0 or more/u, `"${maxAgeMs.description}" does not state its floor`);
  assert.match(maxAgeMs.description, /unsupported/u, "and says how a refusal is coded");
  // The bound it sits under belongs to the user's config, so the key is named and no millisecond count is
  // quoted: `cache.pageMs` is 10 minutes by default and is whatever a config file says it is.
  assert.match(maxAgeMs.description, /cache\.pageMs/u, `"${maxAgeMs.description}" does not name cache.pageMs`);
  assert.equal(
    maxAgeMs.description.includes(String(DEFAULT_CONFIG.cache.pageMs)),
    false,
    `"${maxAgeMs.description}" quotes a number a user's config can contradict`,
  );
  // The two are refused together, so the sentence has to say which one to drop rather than leave a model
  // to discover `fresh` by trial.
  assert.match(maxAgeMs.description, /fresh/u, `"${maxAgeMs.description}" does not say what fresh does differently`);
  // The comparison is strict (`!(ageMs < bound.maxAgeMs)`), so "a page this old is accepted" is a claim the
  // code does not honour — and the sentence cannot even hold it alongside its own "0 always navigates", which
  // is only true because nothing is accepted at age 0. A model reads this sentence and not the operator, so
  // it is the operator's wording that has to survive here.
  assert.doesNotMatch(
    maxAgeMs.description,
    /page (this|that) old/u,
    `"${maxAgeMs.description}" states the bound inclusively, which the strict test does not honour`,
  );
  assert.match(
    maxAgeMs.description,
    /younger than/u,
    `"${maxAgeMs.description}" does not say which side of the number a stored page has to be on`,
  );
});

// READ_DESCRIPTION is the other sentence a model reads about this knob, and it made the same inclusive claim
// ("up to that many milliseconds old will do"). The two are held to the same wording so they cannot drift
// apart in the one direction that is wrong.
test("the read description bounds a cached page strictly, the way the guard and the schema do", () => {
  assert.doesNotMatch(
    READ_DESCRIPTION,
    /up to [a-z0-9]+ ?(many )?milliseconds old|page this old/u,
    `"${READ_DESCRIPTION}" states the tolerance inclusively, which the strict test does not honour`,
  );
  assert.match(READ_DESCRIPTION, /younger than/u, `"${READ_DESCRIPTION}" does not say which side of the number counts`);
});

test("the n schema offers only whole numbers, because the tool refuses anything else", () => {
  // `src/tools/search.ts` rejects a fractional count, so a `Type.Number` here would advertise a value the
  // code then refuses — a schema advertising an input the tool rejects is the same defect as a
  // description quoting a number a user's config can contradict.
  assert.equal(registered().byName.camoufox_search.parameters.properties.n.type, "integer");
});

test("the engine param enumerates, because only two names can ever be answered", () => {
  // `A.5`'s second half. This one was not a schema lying about the code — the tool does refuse anything
  // else — but the allowed set lived in a `description` string, where a model reads it as prose and a
  // caller cannot validate against it. `n` and `maxChars` were both fixed for the weaker reason.
  const engine = registered().byName.camoufox_search.parameters.properties.engine;

  assert.deepEqual(engine.enum, ["google", "duckduckgo"], "the choices are the schema, not the sentence");
  assert.match(engine.description, /unsupported/u, "and a refusal names the code it comes back as");
});

test("both tools declare an outputSchema, and return nothing it does not declare", async (t) => {
  // pi never validates `structuredContent` against `outputSchema` — the two agree only because someone
  // keeps them agreeing. Checked both directions: an undeclared key is a field a script is told to
  // ignore, and a missing required one is a contract the tool breaks on its own happy path.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  withFakeGateway(t);
  const { byName } = registered();

  const { ctx } = session("pi-schema-drift");

  const search = await byName.camoufox_search.execute("id", { query: "camoufox" }, undefined, undefined, ctx);
  const read = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);

  assert.equal(search.isError, undefined, "a gateway that works must not be reported as one that did not");
  assert.equal(read.isError, undefined);
  assertDeclaredBy(byName.camoufox_search.outputSchema, search.structuredContent, "camoufox_search");
  assertDeclaredBy(byName.camoufox_read.outputSchema, read.structuredContent, "camoufox_read");
});

test("structured read hands back the page itself, not the prose wrapped around it", async (t) => {
  // The whole reason to declare an output schema: a programmatic caller otherwise receives the header,
  // the notes, and the continuation footer written for a model, and has to strip them to get the page.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-unwrapped-page");

  const read = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);

  assert.match(read.content[0].text, /^URL: https:\/\/example\.test\//u, "the model keeps its header");
  assert.equal(
    read.structuredContent.text.startsWith("URL:"),
    false,
    "the script does not get it",
  );
  assert.equal(read.structuredContent.url, "https://example.test/");
});

test("the README section an error code points a model at is still there", () => {
  // This repo's prose drifts as easily as its schemas: the commit that added "Structured results" deleted
  // the `## Error codes` heading, orphaning the table under it while the schema still sent a model there.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const described = registered().byName.camoufox_search.outputSchema.properties.error.properties.code.description;

  assert.match(described, /Error codes/u, "the description names the section a model is sent to");
  assert.ok(readme.includes("\n## Error codes\n"), "and README still carries that heading");
});

test("a failed call answers with the same shape, plus the reason", async (t) => {
  // A refusal that changes shape is a second contract. The frame is empty-but-typed and `error` says why,
  // so a caller reads one object either way.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  withFakeGateway(t, { unreachable: true });
  const { byName } = registered();

  const { ctx } = session("pi-failed-shape");

  const search = await byName.camoufox_search.execute("id", { query: "camoufox" }, undefined, undefined, ctx);
  const read = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);

  assert.equal(search.isError, true);
  assert.equal(search.structuredContent.error.code, "gateway_unreachable");
  assert.deepEqual(search.structuredContent.results, []);
  assert.equal(search.structuredContent.query, "camoufox", "the query a script asked for survives the failure");
  assertDeclaredBy(byName.camoufox_search.outputSchema, search.structuredContent, "a failed camoufox_search");

  assert.equal(read.isError, true);
  assert.equal(read.structuredContent.error.code, "gateway_unreachable");
  assert.equal(read.structuredContent.url, "https://example.test/", "the url asked for, since nothing was fetched");
  assert.equal(read.structuredContent.text, "");
  assert.equal(read.structuredContent.nextOffset, null, "null, not absent: there is nowhere to resume");
  assertDeclaredBy(byName.camoufox_read.outputSchema, read.structuredContent, "a failed camoufox_read");
});

test("an engine that fell through is reported to a script as well as to the model", async (t) => {
  // The chain's per-engine record used to exist only inside a sentence in the model's text. It is the
  // difference between "retry" and "file a bug", and a programmatic caller has an interest in it too.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const { ctx, userId } = session("pi-fell-through");
  withFakeGateway(t, { consentWallOn: new Set([userId]) });
  const { byName } = registered();

  const search = await byName.camoufox_search.execute("id", { query: "camoufox" }, undefined, undefined, ctx);

  assert.equal(search.structuredContent.engine, "duckduckgo");
  assert.deepEqual(
    search.structuredContent.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:consent_wall", "duckduckgo:ok"],
  );
});

test("a chain that ran out hands a script the steps, not only the code", async (t) => {
  // The other half of that record: a call that never succeeded. The failure test above points at an
  // unreachable gateway, where nothing was attempted and `tried` is the frame's empty list — so the
  // passthrough that carries a real chain through `failure()` had never run.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const { ctx, userId } = session("pi-ran-out");
  const linkless = `- heading "DuckDuckGo" [level=1]\n${"- paragraph:\n  - text: nothing here is shaped like a link.\n".repeat(60)}`;
  assert.ok(linkless.length > 2_000, `needs to be past PARSEABLE_MIN_CHARS to be parse_error, got ${linkless.length}`);
  withFakeGateway(t, {
    consentWallOn: new Set([userId]),
    pageContents: new Map([["https://duckduckgo.com/?q=camoufox", linkless]]),
  });
  const { byName } = registered();

  const search = await byName.camoufox_search.execute("id", { query: "camoufox" }, undefined, undefined, ctx);

  assert.equal(search.isError, true);
  assert.equal(search.structuredContent.error.code, "consent_wall", "the first engine still leads");
  assert.deepEqual(
    search.structuredContent.tried.map((step) => `${step.engine}:${step.code}`),
    ["google:consent_wall", "duckduckgo:parse_error"],
  );
  assertDeclaredBy(byName.camoufox_search.outputSchema, search.structuredContent, "an exhausted camoufox_search");
});

test("the two width counts reach structuredContent, not just the prose", async (t) => {
  // `assertDeclaredBy` only checks declared-ness, so an optional key nobody ever produces is invisible to
  // it — and the schema-drift guard's own call, the default SERP with no `n`, can only produce `shortBy`.
  // These two are the keys the output contract declares and the registration boundary maps field by
  // field, so that boundary is where they have to be seen being produced.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const page = Array.from(
    { length: 12 },
    (_unused, i) => `- link "Wide ${i + 1}" [e${i + 1}]:\n  - /url: https://example.test/w${i + 1}\n  - text: snippet ${i + 1}`,
  ).join("\n");
  withFakeGateway(t, { pageContents: new Map([["https://www.google.com/search?q=camoufox", page]]) });
  const { byName } = registered();
  const { ctx } = session("pi-wide-page");

  const search = await byName.camoufox_search.execute("id", { query: "camoufox", n: 50 }, undefined, undefined, ctx);

  assert.equal(search.isError, undefined, "a search that worked must not be reported as one that did not");
  assert.equal(search.structuredContent.clampedTo, 10, "the ask past the ceiling");
  assert.equal(search.structuredContent.pageCarried, 12, "the page wider than what returned");
  assertDeclaredBy(byName.camoufox_search.outputSchema, search.structuredContent, "a capped camoufox_search");
});

test("the time a search waited for its SERP reaches structuredContent, not just the prose", async (t) => {
  // The same guard as the two width counts, and for the same reason: `assertDeclaredBy` cannot see an
  // optional key no call ever produces, and this one is produced by a page that renders late.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const skeleton = `- heading "camoufox"\n- navigation:\n  - link "Allt" [e1]\n  - link "Webb" [e2]`;
  const served = `${skeleton}\n- link "Camoufox" [e3]:\n  - /url: https://camoufox.com\n  - text: An anti-detect browser.`;
  withFakeGateway(t, {
    snapshotScripts: new Map([["https://www.google.com/search?q=late", [skeleton, served]]]),
  });
  const { byName } = registered();
  const { ctx } = session("pi-slow-serp");

  const search = await byName.camoufox_search.execute("id", { query: "late", n: 1 }, undefined, undefined, ctx);

  assert.equal(search.isError, undefined, "a search that worked must not be reported as one that did not");
  assert.equal(typeof search.structuredContent.settledInMs, "number", "the cost of the fetch is data, not only prose");
  assert.match(search.content[0].text, /\(waited \d+ms for the page to render\)/u, "and the model is told the same fact");
  assertDeclaredBy(byName.camoufox_search.outputSchema, search.structuredContent, "a slow camoufox_search");
});

test("a read says what it is doing while it does it", async (t) => {
  // A read can spend seconds waiting for a page to render, with nothing reaching pi's UI in between.
  // `onUpdate` was received and dropped; this is the plumbing, not the wording.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-read-notes");
  const notes = [];

  const read = await byName.camoufox_read.execute(
    "id",
    { url: "https://example.test/", waitFor: "#main" },
    undefined,
    (update) => notes.push(update.content[0].text),
    ctx,
  );

  assert.equal(read.isError, undefined);
  assert.ok(notes.includes('opening https://example.test/'), `no open note in ${JSON.stringify(notes)}`);
  assert.ok(notes.includes('waiting for "#main"'), `no wait note in ${JSON.stringify(notes)}`);
});

test("a search names the engine it is trying, before it tries it", async (t) => {
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const { ctx, userId } = session("pi-search-notes");
  withFakeGateway(t, { consentWallOn: new Set([userId]) });
  const { byName } = registered();
  const notes = [];

  await byName.camoufox_search.execute(
    "id",
    { query: "camoufox" },
    undefined,
    (update) => notes.push(update.content[0].text),
    ctx,
  );

  assert.deepEqual(notes, ['searching "camoufox" with google', 'searching "camoufox" with duckduckgo']);
});

// --- what a cached page says about its age ------------------------------------------------------

const MINUTE = 60_000;

test("a cached read tells the model the page's age, and the tolerance it met", async (t) => {
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-age-and-tolerance");
  const clock = stageClock(t, 1_000_000);

  const first = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);
  assert.equal(first.isError, undefined, "the read that filled the cache has to have worked");
  clock.advance(4 * MINUTE);

  // The parameter is declared now, so this call goes through the surface a caller actually has: every key
  // is one the schema declares, and the declared schema admits the value.
  const args = { url: "https://example.test/", maxAgeMs: 5 * MINUTE };
  assertCallable(byName.camoufox_read, args, "a bounded camoufox_read");
  const hit = await byName.camoufox_read.execute("id", args, undefined, undefined, ctx);

  assert.equal(opens(fake), 1, "a page inside the tolerance cost no second navigation");
  assert.equal(hit.structuredContent.fromCache, true);
  // Both numbers have to reach the prose. A model that cannot see a page's age cannot decide whether to
  // ask for `fresh`, and a model that cannot see the bound it set cannot tell a hit it approved from one
  // it merely got.
  assert.match(hit.content[0].text, /this copy is 240s old/u, "the age is in the text a model reads, not only in details");
  assert.match(hit.content[0].text, /within your 300s tolerance/u, "and so is the tolerance that accepted it");
  assert.equal(hit.structuredContent.pageAgeMs, 4 * MINUTE, "the stored value stays milliseconds; only the printed form is trimmed");
  assert.equal(hit.structuredContent.maxAgeMs, 5 * MINUTE, "and the caller's own ask travels with it");
  assertDeclaredBy(byName.camoufox_read.outputSchema, hit.structuredContent, "an aged camoufox_read");
});

test("a cached read with no tolerance says the age and invents no bound", async (t) => {
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-age-no-tolerance");
  const clock = stageClock(t, 1_000_000);

  await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);
  clock.advance(2 * MINUTE);
  const hit = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);

  assert.equal(opens(fake), 1, "the age sentence must not cost a navigation to produce");
  // The other half of the pair: the age is said on every hit, and the tolerance only on a bounded one.
  // A note that named a bound nobody set would be the output claiming more than the call said.
  assert.match(hit.content[0].text, /this copy is 120s old/u, "the age is claimed whether or not anyone asked");
  assert.equal(/tolerance|maxAgeMs/iu.test(hit.content[0].text), false, "and no bound is mentioned when none was set");
  assert.equal("maxAgeMs" in hit.structuredContent, false, "absent, not undefined");
  assertDeclaredBy(byName.camoufox_read.outputSchema, hit.structuredContent, "an unbounded camoufox_read");
});

test("a re-fetch the tolerance forced says so, where a cold cache says nothing", async (t) => {
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-tolerance-dropped");
  const clock = stageClock(t, 1_000_000);

  await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);
  clock.advance(4 * MINUTE);
  const droppedArgs = { url: "https://example.test/", maxAgeMs: MINUTE };
  assertCallable(byName.camoufox_read, droppedArgs, "a tolerance the stored page overshoots");
  const dropped = await byName.camoufox_read.execute("id", droppedArgs, undefined, undefined, ctx);

  assert.equal(opens(fake), 2, "the tolerance spent a navigation, and the note is what makes that visible");
  assert.match(
    dropped.content[0].text,
    /\[re-fetched: the stored page was 240s old, over your maxAgeMs\]/u,
    "the note says it was re-fetched and names the age that cost it",
  );
  assert.equal(dropped.structuredContent.staleSkippedMs, 4 * MINUTE, "the same fact, as a number, for a script");
  assert.equal(/this copy is 240s old/u.test(dropped.content[0].text), false, "the page it answered with was just fetched, so it has no age");

  // The reason the note exists at all: a guard rejection and a cold cache used to be the same output.
  const coldArgs = { url: "https://other.test/", maxAgeMs: MINUTE };
  assertCallable(byName.camoufox_read, coldArgs, "a bounded read of a cold cache");
  const cold = await byName.camoufox_read.execute("id", coldArgs, undefined, undefined, ctx);
  assert.equal(opens(fake), 3, "a cold cache costs the same navigation...");
  assert.equal(/re-fetched:/u.test(cold.content[0].text), false, "...and this sentence is the only thing that tells them apart");
  assert.equal("staleSkippedMs" in cold.structuredContent, false, "nothing was rejected, so nothing is claimed");
  assertDeclaredBy(byName.camoufox_read.outputSchema, cold.structuredContent, "a cold camoufox_read");
});

test("the age fields are declared by the output schema, and absent on a plain read", async (t) => {
  // `assertDeclaredBy` only sees a field a call actually produced, so a field declared and never copied,
  // or copied and never declared, needs the schema read directly — and a field copied on a call that had
  // nothing to say about it needs the key to be *absent*, the way `fromCache` is held to.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-age-fields-declared");

  const declared = Object.keys(byName.camoufox_read.outputSchema.properties);
  for (const field of ["pageAgeMs", "staleSkippedMs", "maxAgeMs"]) {
    assert.ok(declared.includes(field), `${field} is a field the boundary copies, so it must be declared`);
  }

  const read = await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);
  assert.equal(read.isError, undefined);
  for (const field of ["pageAgeMs", "staleSkippedMs", "maxAgeMs"]) {
    assert.equal(field in read.structuredContent, false, `${field} must be absent on a read that has nothing to claim about it`);
  }
  assertDeclaredBy(byName.camoufox_read.outputSchema, read.structuredContent, "a plain camoufox_read");
});

test("a maxAgeMs sent as the schema declares it is forwarded, and comes back on the result", async (t) => {
  // The round trip, end to end: the schema declares the parameter, the boundary forwards it, and the two
  // numbers the tolerance produced survive into `structuredContent`. A parameter only exists if a call
  // carrying it reaches `read` — and `execute` accepts anything, so what is checked here is that this one
  // is a call the declared surface admits.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377" });
  const fake = withFakeGateway(t);
  const { byName } = registered();
  const { ctx } = session("pi-tolerance-round-trip");
  const clock = stageClock(t, 1_000_000);

  await byName.camoufox_read.execute("id", { url: "https://example.test/" }, undefined, undefined, ctx);
  clock.advance(3 * MINUTE);

  const args = { url: "https://example.test/", maxAgeMs: 4 * MINUTE };
  assertCallable(byName.camoufox_read, args, "the tolerance round trip");
  const hit = await byName.camoufox_read.execute("id", args, undefined, undefined, ctx);

  assert.equal(hit.isError, undefined, hit.content[0].text);
  assert.equal(opens(fake), 1, "a page inside the declared tolerance answered without a second navigation");
  assert.equal(hit.structuredContent.fromCache, true, "which is the only way it can have an age at all");
  assert.equal(hit.structuredContent.maxAgeMs, 4 * MINUTE, "the ask this caller made is echoed back to it");
  assert.equal(hit.structuredContent.pageAgeMs, 3 * MINUTE, "and so is the age the cache put on the page that answered");
  assertDeclaredBy(byName.camoufox_read.outputSchema, hit.structuredContent, "a bounded camoufox_read");
});

test("the age lives inside the cache note, and the notes keep their order", async (t) => {
  // Four notes, in the order a model meets them: `fromCache`, `cappedAt`, `thinAfterWait`, `waitNote`.
  // The age is one more fact of the cache claim, not a fifth claim, so it has to sit inside the first
  // note — and adding it may not shuffle the note that comes after it.
  withConfigFile(t, { gatewayUrl: "http://gateway.test:9377", read: { maxCharsCeiling: 20_000 } });
  withFakeGateway(t, { pageContents: new Map([["https://big.test/", "b".repeat(30_000)]]), snapshotLimit: 30_000 });
  const { byName } = registered();
  const { ctx } = session("pi-note-order");
  const clock = stageClock(t, 1_000_000);

  const args = { url: "https://big.test/", maxChars: 40_000 };
  const first = await byName.camoufox_read.execute("id", args, undefined, undefined, ctx);
  assert.equal(first.isError, undefined, "the read that fills the cache has to have worked");
  clock.advance(2 * MINUTE);
  const cached = await byName.camoufox_read.execute("id", args, undefined, undefined, ctx);
  const text = cached.content[0].text;

  const cacheNote = text.indexOf("[served from the page cache");
  const capNote = text.indexOf("[maxChars capped at");
  assert.ok(cacheNote >= 0, `no cache note in ${JSON.stringify(text.slice(-600))}`);
  assert.ok(capNote >= 0, `no cap note in ${JSON.stringify(text.slice(-600))}`);
  assert.ok(cacheNote < capNote, "the cache claim still leads, as it did before the age joined it");

  const age = text.indexOf("this copy is 120s old");
  assert.ok(age > cacheNote && age < capNote, "the age sits inside the cache note, one fact of the same claim");
  assert.equal(/^\[this copy is/mu.test(text), false, "and never became a note of its own");
});

test("the age helper trims a sub-second age to milliseconds, the unit everything here stores", () => {
  // The value a script reads is milliseconds and stays milliseconds; this only decides what a model has
  // to squint at. One helper, two shapes, because `waiting ${outcome.settledInMs}ms` already prints raw
  // ms elsewhere and a duration library would be a second way to say the same thing.
  assert.equal(describeAge(900), "900ms");
});

test("the age helper switches to seconds from one second up, and rounds up", () => {
  assert.equal(describeAge(240_000), "240s");
  // Rounded *up*: a page aged down is a page claimed younger than it is, and the whole point of the
  // sentence is to let the model judge staleness it cannot measure itself.
  assert.equal(describeAge(1_500), "2s");
});
