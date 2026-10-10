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

import registerExtension from "../src/index.ts";
import { DEFAULT_CONFIG, ENGINE_NAMES } from "../src/config.ts";
import { MAX_RESULTS_HARD_LIMIT } from "../src/tools/search.ts";
import { READ_DESCRIPTION, SEARCH_DESCRIPTION } from "../src/extension.ts";

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
  assert.deepEqual(Object.keys(byName.camoufox_read.parameters.properties).sort(), ["maxChars", "offset", "schema", "url"]);

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

  // The model only sees this text, so the two choices it has to know about have to be in it.
  assert.match(byName.camoufox_search.description, /resolve:true/u);
  assert.match(byName.camoufox_read.description, /offset/u);
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
});
