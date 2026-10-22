/**
 * One-shot look at what the gateway actually returns for a url.
 *
 * Importable rather than run-at-import, and that is the point: a diagnostic's whole job is to leave
 * nothing behind, and a script that ran at import time with a hardcoded session id could not be
 * asserted on. Its teardown is covered by `tests/diagnose-wall.test.mjs`.
 */

import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../src/config.ts";
import { createGatewayClient } from "../src/gateway.ts";
import { detectWall } from "../src/snapshot.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { gatewaySessionId } from "../src/session.ts";

const DEFAULT_URL = "https://github.com/daijro/camoufox";

/** Worth quoting back with context, wall or not. Lower-cased, matched against the lower-cased page. */
const PATTERNS = [
  "before you continue to google",
  "unusual traffic",
  "not a robot",
  "captcha",
  "network protocol error",
  "cannot be repaired",
  "whitelisted",
  "not allowed to connect",
  "403 forbidden",
  "bad gateway",
];

/**
 * One run, one namespace, derived the way the extension derives its own.
 *
 * A hand-named literal was a third session in the gateway's tab list with no derivation behind it, and
 * two diagnoses running it would have shared that namespace — and its tabs.
 */
export function diagnosisUserId() {
  return gatewaySessionId(`diag-${randomUUID()}`);
}

/**
 * Read one page and report what the gateway says about it.
 *
 * `client` is injected so the teardown is testable and so a caller can point a diagnosis at a gateway
 * other than the configured one. Throws whatever the read throws — after releasing what it opened.
 */
export async function diagnose({ client, url = DEFAULT_URL, log = (...line) => console.log(...line) }) {
  const userId = diagnosisUserId();
  let tab;
  try {
    tab = await client.openTab({ userId, url });
    const snap = await client.snapshot({ userId, tabId: tab.tabId });

    log(`url: ${snap.url} | chars: ${snap.text.length} | refs: ${snap.refsCount} | total: ${snap.totalChars}`);
    log(`detectWall: ${detectWall(snap)}`);

    const lower = snap.text.toLowerCase();
    const matches = [];
    for (const pattern of PATTERNS) {
      const at = lower.indexOf(pattern);
      if (at < 0) continue;
      matches.push(pattern);
      const around = snap.text.slice(Math.max(0, at - 90), at + 90).replace(/\n/gu, " ");
      log(`MATCH "${pattern}" @${at}: ...${around}...`);
    }

    return {
      userId,
      url: snap.url,
      chars: snap.text.length,
      refs: snap.refsCount,
      total: snap.totalChars,
      wall: detectWall(snap),
      matches,
    };
  } finally {
    // Deliberately no signal: cleanup that inherits an aborted one is how a DELETE never leaves the
    // process (`docs/solutions/integration/cleanup-must-not-inherit-the-aborted-signal.md`). It also
    // must not become the failure the caller sees, so a teardown fault is reported, not thrown.
    if (tab) await client.closeTabQuietly({ userId, tabId: tab.tabId });
    try {
      await client.deleteSession({ userId });
    } catch {
      // Not "it is still on the gateway": a gateway we cannot reach has nothing on it to still be
      // anywhere. The delete did not land, which is all this branch can vouch for.
      log(`warning: could not delete the diagnosis session ${userId} — check the gateway's tab list`);
    }
  }
}

/** Resolve the gateway the extension resolves, so this diagnoses the deployment you actually have. */
function clientFromConfig() {
  const config = loadConfig();
  return createGatewayClient({
    baseUrl: config.gatewayUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeoutMs: config.timeoutMs,
    // Same policy as the extension: a diagnostic that opens tabs the tools would refuse reports on a
    // page the model can never read.
    urlPolicy: urlPolicyFromConfig(config),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await diagnose({ client: clientFromConfig(), url: process.argv[2] ?? DEFAULT_URL });
}
