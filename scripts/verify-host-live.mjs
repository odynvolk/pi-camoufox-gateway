/**
 * Live probe for C.4: every reported host is the host of the url that result shows.
 *
 * The suite proves a page cannot name its own host; this proves the derivation still holds against real
 * engines, on both the default path (wrappers unresolved) and resolve: true (urls replaced). Prints every
 * row so a reviewer can see the pairing rather than trust a count. Skips loudly when no gateway answers.
 */

import { loadConfig } from "../src/config.ts";
import { urlPolicyFromConfig } from "../src/net-policy.ts";
import { createCache } from "../src/cache.ts";
import { createGatewayClient } from "../src/gateway.ts";
import { createExtension } from "../src/extension.ts";
import { normalizeHost } from "../src/net-policy.ts";

const config = loadConfig();
const client = createGatewayClient({
  baseUrl: config.gatewayUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  timeoutMs: config.timeoutMs,
  urlPolicy: urlPolicyFromConfig(config),
});
const extension = createExtension({ config, client, cache: createCache(), userId: `pi-hostprobe-${process.pid}` });

const hostOf = (url) => normalizeHost(new URL(url).hostname).replace(/^www\./u, "");

let rows = 0;
let lies = 0;

for (const resolve of [false, true]) {
  const outcome = await extension.search({ query: "daijro camoufox github docs", resolve, n: 5 });
  console.log(`\n=== engine: ${outcome.engine ?? "(none)"} | resolve: ${resolve} | ${outcome.error?.code ?? "ok"} ===`);
  for (const r of outcome.details.results ?? []) {
    rows += 1;
    const expected = hostOf(r.url);
    const honest = r.host === expected;
    if (!honest) lies += 1;
    console.log(
      `${honest ? "ok  " : "LIE "} host=${JSON.stringify(r.host)} url-host=${JSON.stringify(expected)}` +
        ` resolvable=${r.resolvable} resolved=${r.resolved ?? "-"}${r.cite ? ` cite=${JSON.stringify(r.cite.slice(0, 40))}` : ""}`,
    );
    console.log(`     ${r.url.slice(0, 110)}`);
  }
}

console.log(`\nrows: ${rows}, host not the host of its own url: ${lies}`);
if (rows === 0) {
  console.log("VERDICT: no results came back, so this proved nothing — do not report it as a pass.");
  process.exit(2);
}
if (lies > 0) {
  console.log("VERDICT: a result reported a host it does not host.");
  process.exit(1);
}
console.log("VERDICT: every reported host was the host of the url that result shows.");
