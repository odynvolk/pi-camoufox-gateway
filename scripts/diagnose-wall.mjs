import { createGatewayClient } from "../src/gateway.ts";
import { detectWall } from "../src/snapshot.ts";

const client = createGatewayClient({ baseUrl: "http://192.168.8.110:9377", timeoutMs: 30000 });
const url = process.argv[2] ?? "https://github.com/daijro/camoufox";
const tab = await client.openTab({ userId: "pi-diag", url });
const snap = await client.snapshot({ userId: "pi-diag", tabId: tab.tabId });
console.log("url:", snap.url, "| chars:", snap.text.length, "| refs:", snap.refsCount, "| total:", snap.totalChars);
console.log("detectWall:", detectWall(snap));

const patterns = [
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
const lower = snap.text.toLowerCase();
for (const p of patterns) {
  const i = lower.indexOf(p);
  if (i >= 0) console.log(`MATCH "${p}" @${i}: ...${snap.text.slice(Math.max(0, i - 90), i + 90).replace(/\n/g, " ")}...`);
}
await client.closeTab({ userId: "pi-diag", tabId: tab.tabId });
await client.deleteSession({ userId: "pi-diag" });
