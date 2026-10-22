/**
 * The diagnosis script's own teardown, which is the whole reason it is importable.
 *
 * `diagnose-wall.mjs` used to run at import time with a hardcoded `userId`, so nothing could assert
 * what it left behind — and it left a third, hand-named session namespace in the gateway's tab list,
 * plus a tab whenever the read failed. Both are asserted here: one against a stub client, one against
 * the fake gateway's authoritative tab set.
 *
 * So is `isEntryScript`, the guard that replaced running at import time. Wrongly answering "not me"
 * leaves the script printing nothing and exiting 0, which no assertion on the importable parts can see.
 */

import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { diagnose, isEntryScript } from "../scripts/diagnose-wall.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { testConfig } from "./helpers/config.mjs";
import { withFakeGateway } from "./helpers/fake_gateway.mjs";

/** Records what teardown was asked for, and fails the read so the failure path is reachable. */
function stubClient({ failOn = "snapshot" } = {}) {
  const calls = [];
  const client = {
    calls,
    async openTab(params) {
      calls.push({ op: "openTab", ...params });
      return { tabId: "tab-1", url: params.url };
    },
    async snapshot(params) {
      calls.push({ op: "snapshot", ...params });
      if (failOn === "snapshot") throw new Error("the page did not come back");
      return { url: params.tabId, text: "hello", refsCount: 0, truncated: false, totalChars: 5, hasMore: false, nextOffset: null };
    },
    async closeTabQuietly(params) {
      calls.push({ op: "closeTabQuietly", ...params });
    },
    async deleteSession(params) {
      calls.push({ op: "deleteSession", ...params });
    },
  };
  return client;
}

const silent = () => undefined;

test("a diagnosis releases what it opened even when the read fails", async () => {
  const client = stubClient();

  await assert.rejects(() => diagnose({ client, url: "https://example.test/", log: silent }), /did not come back/u);

  const opened = client.calls.find((call) => call.op === "openTab");
  const ops = client.calls.map((call) => call.op);
  assert.deepEqual(ops.filter((op) => op !== "snapshot"), ["openTab", "closeTabQuietly", "deleteSession"]);
  assert.equal(
    client.calls.filter((call) => call.op !== "openTab" && call.userId !== opened.userId).length,
    0,
    "teardown must release the session it opened, not another one",
  );
});

test("each diagnosis runs in its own derived namespace", async () => {
  const first = stubClient({ failOn: "none" });
  const second = stubClient({ failOn: "none" });

  const one = await diagnose({ client: first, url: "https://example.test/", log: silent });
  const two = await diagnose({ client: second, url: "https://example.test/", log: silent });

  assert.notEqual(one.userId, two.userId, "two diagnoses must not share tabs");
  for (const userId of [one.userId, two.userId]) {
    assert.match(userId, /^pi-diag-[A-Za-z0-9._-]+$/u, `not derived like a session id: ${userId}`);
    assert.notEqual(userId, "pi-diag", "and not the literal this script used to hardcode");
  }
});

test("a failed diagnosis leaves no tab on the gateway", async (t) => {
  // The authoritative side, per `docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md`:
  // a client that remembers its own tabs cannot catch a teardown that never sent its DELETE.
  const fake = withFakeGateway(t, { failSnapshot: true });
  const config = testConfig({ gatewayUrl: "http://gateway.test:9377", timeoutMs: 2000 });
  const client = createGatewayClient({
    baseUrl: config.gatewayUrl,
    timeoutMs: config.timeoutMs,
    urlPolicy: urlPolicyFromConfig(config),
  });

  await assert.rejects(() => diagnose({ client, url: "https://example.test/", log: silent }));

  assert.deepEqual(fake.liveTabs(), [], "the tab is closed on the gateway, not just on our side");
  assert.equal(
    fake.state.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/sessions/pi-diag-")).length,
    1,
    "and the session it ran in is deleted",
  );
});

test("a diagnosis that works closes its tab and deletes its session", async (t) => {
  const fake = withFakeGateway(t);
  const config = testConfig({ gatewayUrl: "http://gateway.test:9377", timeoutMs: 2000 });
  const client = createGatewayClient({
    baseUrl: config.gatewayUrl,
    timeoutMs: config.timeoutMs,
    urlPolicy: urlPolicyFromConfig(config),
  });

  const report = await diagnose({ client, url: "https://example.test/", log: silent });

  assert.equal(report.wall, null, "the fake's ordinary page is not a wall");
  assert.deepEqual(fake.liveTabs(), []);
  assert.equal(
    fake.state.calls.filter((call) => call.method === "DELETE" && call.path === `/sessions/${report.userId}`).length,
    1,
  );
});

test("the entry guard resolves the path it was run with", (t) => {
  // Node hands a module a resolved url and leaves `argv[1]` as it was typed, so the two differ whenever
  // the invocation path passes through a symlink — `/tmp` on macOS. Measured against the old check: a
  // diagnosis run that way matched neither side, printed nothing, and exited 0.
  const root = mkdtempSync(join(tmpdir(), "diagnose-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  mkdirSync(real);
  const script = join(real, "diagnose-wall.mjs");
  writeFileSync(script, "", "utf8");
  symlinkSync(real, join(root, "linked"));
  const moduleUrl = pathToFileURL(realpathSync(script)).href;

  assert.equal(isEntryScript(script, moduleUrl), true, "run directly, this is the script that was run");
  assert.equal(
    isEntryScript(join(root, "linked", "diagnose-wall.mjs"), moduleUrl),
    true,
    "run through a symlinked directory, it is still the same file",
  );
});
