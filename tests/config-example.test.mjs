import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { isPlainObject } from "./helpers/config.mjs";

const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));

test("the shipped config example is a config the loader accepts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-example-"));
  const path = join(dir, "camoufox.json");
  writeFileSync(path, JSON.stringify(example), "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = loadConfig({ configPath: path, env: {} });

  assert.equal(config.gatewayUrl, DEFAULT_CONFIG.gatewayUrl, "the example drifted from the loader's default");
  assert.equal(config.search.maxResults, 10);
  assert.equal(config.read.defaultMaxChars, 12_000);
  assert.deepEqual(config.engines.map((engine) => engine.name), ["google", "duckduckgo"]);
});

test("the example documents every setting the loader knows about", () => {
  // An undocumented setting is a setting nobody can discover, and a section the example shows only
  // partly invites a caller to guess at the missing keys. The sections are derived from
  // `DEFAULT_CONFIG`: a hardcoded list checks the four that existed when this was written and waves
  // through the next one, which is exactly the drift the test exists to catch.
  // `apiKey` is deliberately absent from the example, and from `DEFAULT_CONFIG`, so nothing has to be
  // allowed for it here.
  assert.deepEqual(Object.keys(example).sort(), Object.keys(DEFAULT_CONFIG).sort());

  const sections = Object.keys(DEFAULT_CONFIG).filter((key) => isPlainObject(DEFAULT_CONFIG[key]));
  // Without this the loop could be vacuous and still be green.
  assert.ok(sections.length > 0, "expected object-valued sections to compare, found none");
  for (const section of sections) {
    assert.deepEqual(
      Object.keys(example[section]).sort(),
      Object.keys(DEFAULT_CONFIG[section]).sort(),
      `config.example.json is out of date on "${section}"`,
    );
  }
});

test("what the README promises about defaults matches what the loader does", () => {
  const config = loadConfig({ configPath: join(tmpdir(), "definitely-absent-camoufox.json"), env: {} });
  assert.equal(config.gatewayUrl, example.gatewayUrl);
  assert.equal(config.read.defaultMaxChars, example.read.defaultMaxChars);
  assert.equal(config.search.maxResults, example.search.maxResults);
  assert.equal(config.timeoutMs, example.timeoutMs);
});
