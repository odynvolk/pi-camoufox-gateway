/**
 * The url policy, which guards every tab the client opens — not just the read tool's.
 *
 * These are the cases a model can reach by asking for one url: cloud metadata, loopback services, a
 * LAN database, and the near-miss hosts that must *not* be blocked, because a guard with false
 * positives gets turned off.
 */

import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { assertHostAllowed, assertTabUrlAllowed, isPrivateHost } from "../src/net-policy.ts";
import { resolveUrls } from "../src/resolve.ts";
import { GatewayError } from "../src/errors.ts";

const BASE = "http://gateway.test:9377";
const OPEN = { blockedHosts: [], allowPrivateHosts: false };

function codeFor(run) {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected a GatewayError, got ${error}`);
    return error.code;
  }
}

test("internal addresses are recognised", () => {
  for (const host of [
    "127.0.0.1",
    "127.9.9.9",
    "10.0.4.9",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "239.1.1.1",
    "255.255.255.255",
    "localhost",
    "LOCALHOST",
    "db.localhost",
    "metadata.google.internal",
    "::1",
    "[::1]",
    "::",
    "[fd00::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[::ffff:169.254.169.254]",
    "[::ffff:a9fe:a9fe]", // what `new URL()` turns the line above into
    "[64:ff9b::a9fe:a9fe]",
    "[::ffff:7f00:1]",
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
});

test("public addresses are not blocked, including the near-misses", () => {
  for (const host of [
    "example.com",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "192.0.1.1",
    "192.0.2.1",
    "198.17.0.1",
    "198.20.0.1",
    "169.253.0.1",
    "notlocalhost",
    "localhost.example.com",
    "metadata.google.internal.evil.test",
    "[::ffff:8.8.8.8]",
    "[64:ff9b::808:808]",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(isPrivateHost(host), false, `${host} should be reachable`);
  }
});

test("encoded forms of an internal address are caught, not just the obvious one", () => {
  // The URL parser is part of the guard: it collapses these into forms the rules can recognise.
  for (const url of ["http://2130706433/", "http://0177.0.0.1/", "http://[::ffff:a9fe:a9fe]/", "http://127.1/"]) {
    assert.equal(codeFor(() => assertTabUrlAllowed(url, OPEN)), "private_network", `${url} slipped through`);
  }
});

test("the scheme and shape rules keep their codes", () => {
  assert.equal(codeFor(() => assertTabUrlAllowed("file:///etc/passwd", OPEN)), "blocked_url");
  assert.equal(codeFor(() => assertTabUrlAllowed("javascript:alert(1)", OPEN)), "blocked_url");
  assert.equal(codeFor(() => assertTabUrlAllowed("data:text/html,hi", OPEN)), "blocked_url");
  assert.equal(codeFor(() => assertTabUrlAllowed("not a url", OPEN)), "unsupported");
  assert.equal(codeFor(() => assertTabUrlAllowed("https://example.com", OPEN)), undefined);
});

test("blockedHosts wins over the address rule so the message names the user's list", () => {
  const error = (() => {
    try {
      assertTabUrlAllowed("http://169.254.169.254/", { blockedHosts: ["169.254.169.254"], allowPrivateHosts: true });
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();

  assert.equal(error.code, "host_blocked");
  assert.deepEqual(error.details, { host: "169.254.169.254", rule: "169.254.169.254" });
});

test("allowPrivateHosts is the documented escape hatch", () => {
  assert.doesNotThrow(() => assertTabUrlAllowed("http://127.0.0.1:8080/admin", { blockedHosts: [], allowPrivateHosts: true }));
});

test("assertHostAllowed still matches exact and wildcard rules only", () => {
  assert.equal(codeFor(() => assertHostAllowed("https://db.corp.test/x", ["*.corp.test"])), "host_blocked");
  assert.equal(codeFor(() => assertHostAllowed("https://corp.test/x", ["corp.test"])), "host_blocked");
  assert.doesNotThrow(() => assertHostAllowed("https://notcorp.test/x", ["corp.test"]));
  assert.doesNotThrow(() => assertHostAllowed("https://example.com/x", [""]));
});

test("openTab refuses an internal address without making a single request", async (t) => {
  const fake = withFakeGateway(t);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000, urlPolicy: OPEN });

  const error = await client.openTab({ userId: "u1", url: "http://169.254.169.254/latest/meta-data/" }).catch((e) => e);

  assert.equal(error.code, "private_network");
  assert.equal(error.details.host, "169.254.169.254");
  assert.equal(fake.state.calls.filter((c) => c.path !== "/").length, 0, "the gateway was asked to open it anyway");
  assert.equal(client.openTabCount(), 0);
});

test("url resolution cannot be used to reach an internal host", async (t) => {
  // `resolve: true` opens whatever the engine page contained, which is the path a hostile result
  // would take. It goes through the same choke point, so it inherits the same refusal.
  const fake = withFakeGateway(t);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000, urlPolicy: OPEN });

  const resolved = await resolveUrls(
    [{ title: "internal", url: "http://127.0.0.1:9200/_search", host: "127.0.0.1", snippet: "", resolvable: true, engine: "google" }],
    { client, userId: "u1" },
  );

  assert.equal(resolved[0].resolved, false);
  assert.match(resolved[0].resolveError, /private_network|internal address/iu);
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 0);
});

test("an allowed internal host is opened by the client once the policy opts in", async (t) => {
  const fake = withFakeGateway(t);
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 2000, urlPolicy: { ...OPEN, allowPrivateHosts: true } });

  const tab = await client.openTab({ userId: "u1", url: "http://[::1]:9200/" });

  assert.ok(tab.tabId);
  assert.equal(fake.state.calls.filter((c) => c.path === "/tabs/open").length, 1);
  await client.closeTab({ userId: "u1", tabId: tab.tabId });
});
