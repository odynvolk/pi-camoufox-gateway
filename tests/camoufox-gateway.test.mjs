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

import registerExtension from "../src/camoufox-gateway.ts";
import { DEFAULT_CONFIG, ENGINE_NAMES, MAX_SEARCH_RESULTS } from "../src/config.ts";
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

test("a numeric parameter declares the type the tool actually accepts", () => {
  // Nothing in this repo validates tool arguments — pi checks none, and there is no `Value.Check` on
  // ours — so the declared `type` and `description` are the only signal a model gets before it calls.
  // A `Number` offering a fraction, a negative, or a string is a promise `tools/read.ts` breaks, which is
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

test("the n schema offers only whole numbers, because the tool refuses anything else", () => {
  // `tools/search.ts` rejects a fractional count, so a `Type.Number` here would advertise a value the
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
