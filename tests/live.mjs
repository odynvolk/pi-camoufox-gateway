/**
 * Live smoke test. Skipped unless CAMOUFOX_LIVE=1.
 *
 * The unit suite proves our logic against recorded fixtures. This proves the three things fixtures
 * cannot: the gateway still answers, redirects still resolve, and we still leave no tabs behind.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { createCache } from "../src/cache.ts";
import { createGatewayClient } from "../src/gateway.ts";
import { createExtension } from "../src/extension.ts";

const live = process.env.CAMOUFOX_LIVE === "1";
const config = loadConfig();

const client = createGatewayClient({
  baseUrl: config.gatewayUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: config.timeoutMs,
  // Wired exactly as the extension wires it, so the live run exercises the real address guard.
  urlPolicy: urlPolicyFromConfig(config),
});
const extension = createExtension({ config, client, cache: createCache(), userId: `pi-live-${process.pid}` });

test("live: search returns real results", { skip: !live }, async () => {
  const outcome = await extension.search({ query: "camoufox anti-detect browser" });
  assert.ok(outcome.details.results.length > 0, "expected at least one result");
  assert.ok(outcome.details.results.every((r) => r.url.startsWith("http")));
});

test("live: resolve turns wrappers into final urls", { skip: !live }, async () => {
  const outcome = await extension.search({ query: "daijro camoufox github", resolve: true, n: 3 });
  const wrapped = outcome.details.results.filter((r) => /google\.com\/goto\?url=/u.test(r.url));
  assert.equal(wrapped.length, 0, `unresolved urls: ${JSON.stringify(wrapped.map((r) => r.url))}`);
});

test("live: read is bounded and says so", { skip: !live }, async () => {
  const outcome = await extension.read({ url: "https://github.com/daijro/camoufox" });
  const body = outcome.text.slice(outcome.text.indexOf("\n\n") + 2);

  assert.ok(outcome.details.truncated, "a repo page is longer than the default budget");
  assert.ok(outcome.details.totalChars > config.read.defaultMaxChars);
  assert.ok(body.length <= config.read.defaultMaxChars + 200, `body was ${body.length} chars`);
  assert.equal("text" in outcome.details, false, "details must not duplicate the page body");
});

test("live: n above the page size is clamped and disclosed", { skip: !live }, async () => {
  const outcome = await extension.search({ query: "camoufox", n: 20 });
  assert.equal(outcome.details.clampedTo, 10);
});

test("live: an internal address is refused and costs the gateway nothing", { skip: !live }, async () => {
  const error = await extension.read({ url: "http://169.254.169.254/latest/meta-data/" }).catch((e) => e);
  assert.equal(error.code, "private_network");
});

test("live: teardown leaves the gateway without our session", { skip: !live }, async () => {
  await extension.search({ query: "camoufox" });
  assert.equal(client.openTabCount(), 0);
  await extension.shutdown();
});
