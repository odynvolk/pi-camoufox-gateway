import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));

test("the shipped config example is a config the loader accepts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camoufox-example-"));
  const path = join(dir, "camoufox.json");
  writeFileSync(path, JSON.stringify(example), "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = loadConfig({ configPath: path, env: {} });

  assert.equal(config.gatewayUrl, "http://localhost:9377");
  assert.equal(config.search.maxResults, 10);
  assert.equal(config.read.defaultMaxChars, 12_000);
  assert.deepEqual(config.engines.map((engine) => engine.name), ["google", "duckduckgo"]);
});

test("what the README promises about defaults matches what the loader does", () => {
  const config = loadConfig({ configPath: join(tmpdir(), "definitely-absent-camoufox.json"), env: {} });
  assert.equal(config.read.defaultMaxChars, example.read.defaultMaxChars);
  assert.equal(config.search.maxResults, example.search.maxResults);
  assert.equal(config.timeoutMs, example.timeoutMs);
});
