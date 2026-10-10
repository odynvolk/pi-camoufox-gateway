import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { resolveUrls } from "../src/resolve.ts";

const BASE = "http://gateway.test:9377";

function setup(t, options = {}) {
  const fake = withFakeGateway(t, options);
  return { fake, client: createGatewayClient({ baseUrl: BASE, timeoutMs: 2000 }) };
}

function result(url, { resolvable = false, title = "x" } = {}) {
  return { title, url, host: "example.test", snippet: "", resolvable, engine: "google" };
}

test("resolves every redirect wrapper in parallel and closes every tab", async (t) => {
  const { fake, client } = setup(t);
  const results = [
    result("https://www.google.com/goto?url=AAA", { resolvable: true, title: "one" }),
    result("https://www.google.com/goto?url=BBB", { resolvable: true, title: "two" }),
    result("https://www.google.com/goto?url=CCC", { resolvable: true, title: "three" }),
  ];

  const resolved = await resolveUrls(results, { client, userId: "u1" });

  assert.equal(resolved.length, 3);
  for (const item of resolved) {
    assert.ok(!item.url.includes("goto"), `url should be final, got ${item.url}`);
    assert.equal(item.resolved, true);
  }
  assert.equal(client.openTabCount(), 0);
  const opens = fake.state.calls.filter((c) => c.method === "POST" && c.path === "/tabs/open");
  assert.equal(opens.length, 3);
  assert.equal(fake.state.calls.filter((c) => c.method === "DELETE").length, 3);
});

test("resolves concurrently, not one after another", async (t) => {
  const { client } = setup(t, { openLatencyMs: 30 });
  const started = Date.now();

  await resolveUrls(
    [
      result("https://www.google.com/goto?url=AAA", { resolvable: true }),
      result("https://www.google.com/goto?url=BBB", { resolvable: true }),
      result("https://www.google.com/goto?url=CCC", { resolvable: true }),
    ],
    { client, userId: "u1", concurrency: 3 },
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 85, `three 30ms opens in series would take ~90ms, took ${elapsed}ms`);
});

test("keeps the original url and flags it when resolution fails", async (t) => {
  const { client } = setup(t, { resolveFailures: new Set(["https://www.google.com/goto?url=BBB"]) });
  const results = [
    result("https://www.google.com/goto?url=AAA", { resolvable: true }),
    result("https://www.google.com/goto?url=BBB", { resolvable: true }),
  ];

  const resolved = await resolveUrls(results, { client, userId: "u1" });

  assert.equal(resolved[0].url, "https://github.com/daijro/camoufox");
  assert.equal(resolved[1].url, "https://www.google.com/goto?url=BBB", "a failed result must not be dropped");
  assert.equal(resolved[1].resolved, false);
  assert.equal(client.openTabCount(), 0);
});

test("a hanging url is flagged unresolved without blocking the others", async (t) => {
  const target = "https://www.google.com/goto?url=HANG";
  const { client } = setup(t, { hangUrls: new Set([target]), hangForMs: 5000 });

  const resolved = await resolveUrls(
    [result(target, { resolvable: true }), result("https://www.google.com/goto?url=OK", { resolvable: true })],
    { client, userId: "u1", timeoutMs: 40 },
  );

  assert.equal(resolved[0].resolved, false);
  assert.match(resolved[0].url, /HANG/u);
  assert.equal(resolved[1].resolved, true);
  assert.equal(client.openTabCount(), 0);
});

test("does not open a single tab for urls that are already final", async (t) => {
  const { fake, client } = setup(t);

  const resolved = await resolveUrls(
    [result("https://camoufox.com", {}), result("https://github.com/daijro/camoufox", {})],
    { client, userId: "u1" },
  );

  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0);
  assert.deepEqual(resolved.map((r) => r.resolved), [undefined, undefined]);
});

test("caps in-flight tabs so the gateway is not flooded", async (t) => {
  const { client } = setup(t);
  const results = Array.from({ length: 8 }, (_, i) =>
    result(`https://www.google.com/goto?url=${i}`, { resolvable: true }),
  );

  const resolved = await resolveUrls(results, { client, userId: "u1", concurrency: 2 });

  assert.equal(resolved.length, 8);
  assert.equal(client.openTabCount(), 0);
});
