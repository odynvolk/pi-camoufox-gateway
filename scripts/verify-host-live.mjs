/**
 * Live probe for C.4: every reported host is the host of the url that result shows.
 *
 * The suite proves a page cannot name its own host; this proves the derivation still holds against real
 * engines, on both the default path (wrappers unresolved) and resolve: true (urls replaced). Prints every
 * row so a reviewer can see the pairing rather than trust a count.
 *
 * `hostOf` here is deliberately **not** `resultHost` from `src/snapshot.ts`. A gate that judges a value with
 * the function that produced it can only ever agree; this derives the host independently — `new URL()` plus
 * `normalizeHost` — so a `resolve.ts` that forgot to recompute still fails here.
 *
 * Exit codes, because a gate that cannot tell "clean" from "broken" is not a gate:
 *   0  every row honest
 *   1  a result reported a host it does not host
 *   2  the probe could not run — no gateway answered, or no results came back
 */

import { loadConfig } from "../src/config.ts";
import { normalizeHost, urlPolicyFromConfig } from "../src/net-policy.ts";
import { createCache } from "../src/cache.ts";
import { createGatewayClient } from "../src/gateway.ts";
import { createExtension } from "../src/extension.ts";

const PROBE_QUERY = "daijro camoufox github docs";
const LEGS = [false, true]; // resolve: false, then resolve: true

const config = loadConfig();
const client = createGatewayClient({
  baseUrl: config.gatewayUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: config.timeoutMs,
  // Wired exactly as the extension wires it, so the live run exercises the real address guard.
  urlPolicy: urlPolicyFromConfig(config),
});
const extension = createExtension({ config, client, cache: createCache(), userId: `pi-hostprobe-${process.pid}` });

const hostOf = (url) => {
  try {
    return normalizeHost(new URL(url).hostname).replace(/^www\./u, "");
  } catch {
    // A url the probe cannot parse is a result whose host cannot be judged — which is a failure to report,
    // not a reason to abort the gate. `rawHostOf` in `src/snapshot.ts` answers the same case with "".
    return "";
  }
};

let rows = 0;
let lies = 0;
let erroredLegs = 0;

for (const resolve of LEGS) {
  // A dead gateway re-throws out of `extension.search` — the `{ text, details: { error } }` shape is built
  // only at the registration boundary in `src/camoufox-gateway.ts`. Caught here so a leg that never ran
  // prints as itself instead of killing the run as an unhandled rejection, which exits 1 and would look
  // exactly like a found lie. Same convention as `scripts/verify-settle-live.mjs`.
  const outcome = await extension
    .search({ query: PROBE_QUERY, resolve, n: 5 })
    .catch((error) => error);
  // `engine` and `results` live on `details`, not on the outcome. Reading them off the outcome printed
  // "(none)" and zero rows while the engine was in fact answering.
  const details = outcome.details ?? {};

  if (outcome instanceof Error) {
    erroredLegs += 1;
    console.log(`\n=== engine: (no answer) | resolve: ${resolve} | code=${outcome.code ?? outcome.name} ===`);
    console.log(`    ${outcome.message}`);
    continue;
  }

  console.log(
    `\n=== engine: ${details.engine ?? "(none)"} | resolve: ${resolve} | code=ok` +
      `${details.fromCache ? " | cached" : ""} ===`,
  );
  for (const r of details.results ?? []) {
    rows += 1;
    const expected = hostOf(r.url);
    const honest = r.host === expected;
    if (!honest) lies += 1;
    console.log(
      `${honest ? "ok  " : "LIE "} host=${JSON.stringify(r.host)} url-host=${JSON.stringify(expected)}` +
        ` resolvable=${r.resolvable} resolved=${r.resolved ?? "-"}${
          r.cite ? ` cite=${JSON.stringify(String(r.cite).slice(0, 40))}` : ""
        }`,
    );
    console.log(`     ${String(r.url).slice(0, 110)}`);
  }
}

console.log(`\nrows: ${rows}, host not the host of its own url: ${lies}, legs that never ran: ${erroredLegs}`);
if (rows === 0 || erroredLegs > 0) {
  console.log(
    rows === 0
      ? "VERDICT: no results came back, so this proved nothing — not a pass, and not a failure of the code either."
      : "VERDICT: a leg never reached the point of judging, so this run is incomplete — not a pass.",
  );
  process.exit(2);
}
if (lies > 0) {
  console.log("VERDICT: a result reported a host it does not host.");
  process.exit(1);
}
console.log("VERDICT: every reported host was the host of the url that result shows.");
