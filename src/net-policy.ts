/**
 * The one place that decides whether a url may be opened in a browser tab.
 *
 * `camofox-browser` enforces no egress policy of its own, so without this guard `camoufox_read` —
 * and `resolve: true`, which opens every url Google handed us — is a request forwarder for internal
 * addresses: a model, or a page that tricks the model, can point us at `169.254.169.254` or a LAN
 * service and read the response back as page text.
 *
 * The check therefore lives at the choke points every navigation passes through — `GatewayClient.openTab`
 * for the url we were given, and `GatewayClient.snapshot` for the destination the gateway reports — not
 * only in the read tool. What it cannot do is judge a *name* that resolves to an internal address (DNS
 * rebinding, `localhost` aliases): that needs gateway-side egress policy, which this repo does not own.
 */

import { GatewayError } from "./errors.ts";
import type { CamoufoxConfig } from "./config.ts";

export interface UrlPolicy {
  /** Hosts the caller listed in `blockedHosts`. */
  blockedHosts: string[];
  /**
   * Permit loopback, RFC1918, link-local and other non-global targets. Off by default: the value of
   * the guard is that a url chosen by the model cannot reach the internal network. Turn it on when
   * the gateway legitimately fronts intranet docs.
   */
  allowPrivateHosts: boolean;
}

export const DEFAULT_URL_POLICY: UrlPolicy = { blockedHosts: [], allowPrivateHosts: false };

/**
 * Build the policy from a loaded config.
 *
 * Every client construction site needs the same two fields; hand-writing the literal at each one is
 * how a third policy setting ends up honoured in one path and ignored in another.
 */
export function urlPolicyFromConfig(config: CamoufoxConfig): UrlPolicy {
  return { blockedHosts: config.blockedHosts, allowPrivateHosts: config.network.allowPrivateHosts };
}

/**
 * Whether a refusal happened before we asked for anything, or about where the browser ended up.
 *
 * The wording the model gets has to know the difference: after `"destination"` nothing here can
 * honestly say the gateway was never contacted — a tab was opened and a page was fetched.
 */
export type UrlCheckStage = "request" | "destination";

/**
 * Whether this policy could refuse anything at all.
 *
 * Used to decide whether a missing destination is worth failing over: a caller that switched the whole
 * guard off should not be blocked by a check that can no longer fire.
 */
export function policyCanRefuse(policy: UrlPolicy): boolean {
  return !policy.allowPrivateHosts || policy.blockedHosts.some((entry) => entry.trim() !== "");
}

/** Names that mean "internal" without being an IP literal. */
const PRIVATE_NAMES = new Set(["localhost", "metadata.google.internal"]);

/** `*.localhost` is loopback by RFC 6761, same as the bare name. */
const PRIVATE_SUFFIX = ".localhost";

interface ParsedUrl {
  /** Host, lower-cased and with a trailing `.` removed. */
  host: string;
}

/**
 * The one way this repo turns a hostname into the string its rules compare against.
 *
 * Exported because a host read in two places is two answers: `src/snapshot.ts` judges engine ownership
 * off the same field this file's address rules use, and it used to call `new URL().hostname` directly —
 * which keeps the FQDN terminator, so `www.google.com.` was refused as nobody's domain while
 * `parseHttpUrl` below was happily calling it `www.google.com`. Every host *this file* compares against a
 * rule comes through here.
 *
 * It is not yet true repo-wide, and saying so is the point: `src/tools/search.ts → engineLabel` prints a
 * raw hostname, `src/resolve.ts` matches wrapper bytes rather than a host, and `src/tools/read.ts →
 * pageCacheKey` keys on `new URL().href`. None of them decides ownership today; all of them would be
 * wrong about a terminated host. Recorded in `docs/improvements/2026-10-18-code.md` rather than left for
 * the next reader to discover by being bitten — which is how the P1 above happened.
 */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function parseHttpUrl(url: string): ParsedUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError("unsupported", `"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayError("blocked_url", `only http(s) urls can be opened in a browser tab (got "${url}")`);
  }
  if (!parsed.hostname) {
    throw new GatewayError("blocked_url", `"${url}" has no host to open in a browser tab`);
  }
  // `new URL()` keeps the FQDN terminator and even decodes `%2e` into one, so `evil.test.` resolves
  // exactly like `evil.test`. Normalising here — the one place a host is read, shared with
  // `engineOwnsUrl` — means the host rules and the address rules below can never disagree about what a
  // url points at, and neither can drift from what the browser actually resolved.
  return { host: normalizeHost(parsed.hostname) };
}

/**
 * Does this host match a host rule — exactly, or as a subdomain, with the `*.` prefix accepted?
 *
 * Exported for `src/snapshot.ts`, which asks the same question about the engine's own hosts. Two copies
 * of "does this host equal or sit under that one" is how `blockedHosts` and the chrome filter could start
 * meaning different things about the same string.
 */
export function matchesHostRule(host: string, rule: string): boolean {
  const needle = rule.toLowerCase();
  if (!needle) return false;
  return needle.startsWith("*.")
    ? host === needle.slice(2) || host.endsWith(needle.slice(1))
    : host === needle || host.endsWith(`.${needle}`);
}

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  // Reject things like `1.2.3.04` that Number accepts but are not a dotted quad.
  if (parts.some((part) => part !== String(Number(part)))) return undefined;
  return octets;
}

/** Everything a tab must not reach: loopback, private, link-local, metadata, multicast, reserved. */
function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b, c] = [octets[0] ?? -1, octets[1] ?? -1, octets[2] ?? -1];
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10/8 RFC1918
    a === 127 || // 127/8 loopback
    a >= 224 || // 224/4 multicast, 240/4 reserved, 255/32 broadcast
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 RFC1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF assignments, not all of 192.0/16
    (a === 192 && b === 168) || // 192.168/16 RFC1918
    (a === 198 && (b === 18 || b === 19)) // 198.18/15 benchmarking
  );
}

function isPrivateIpv6(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1") return true;
  // An IPv4 written in dots (`::ffff:127.0.0.1`, `64:ff9b::10.0.0.1`) carries its own verdict.
  const dotted = host.match(/(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (dotted && isPrivateIpv4(dotted)) return true;
  // `new URL()` has already collapsed the compressed forms to hex groups, so `::ffff:169.254.169.254`
  // reaches us as `::ffff:a9fe:a9fe`. Rebuild the address before deciding it is not internal.
  const mapped = host.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mapped) {
    const high = Number.parseInt(mapped[1] ?? "0", 16);
    const low = Number.parseInt(mapped[2] ?? "0", 16);
    if (isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)) return true;
  }
  const head = host.replace(/^:/u, "");
  return (
    /^f[cd]/u.test(head) || // fc00::/7 unique-local
    /^fe[89ab]/u.test(head) || // fe80::/10 link-local
    /^ff/u.test(head) // ff00::/12 multicast
  );
}

export function isPrivateHost(host: string): boolean {
  // Same normaliser, not a re-typing of it. This function is exported and takes a raw `new URL().hostname`,
  // so it used to carry its own terminator strip — a second reader of one field, in the file that
  // documents why that is how the P1 was born.
  const lowered = normalizeHost(host);
  if (PRIVATE_NAMES.has(lowered)) return true;
  if (lowered.endsWith(PRIVATE_SUFFIX)) return true;
  return isPrivateIpv4(lowered) || isPrivateIpv6(lowered);
}

/** The `blockedHosts` half of the policy, kept separate so a caller can name the rule it hit. */
export function assertHostAllowed(url: string, blockedHosts: string[], stage: UrlCheckStage = "request"): void {
  const host = parseHttpUrl(url).host;
  const rule = blockedHosts.map((entry) => entry.toLowerCase()).find((entry) => matchesHostRule(host, entry));
  if (rule !== undefined) {
    throw new GatewayError("host_blocked", `"${host}" is listed in camoufox blockedHosts, so it was not fetched`, {
      details: { host, rule, stage },
    });
  }
}

/**
 * Full pre-flight for opening a tab: scheme, then the caller's `blockedHosts`, then the private
 * address block. Order matters for the message the model gets — a host the user explicitly blocked
 * should say so rather than reporting the generic address rule.
 *
 * Parsing through `URL` first is part of the guard, not plumbing: it collapses `http://0177.0.0.1`,
 * `http://2130706433` and `http://[::ffff:a9fe:a9fe]` into addresses the rules below can recognise.
 * What it cannot reach is a *name* that resolves to one of those — see the module comment.
 */
export function assertTabUrlAllowed(url: string, policy: UrlPolicy = DEFAULT_URL_POLICY, stage: UrlCheckStage = "request"): void {
  const host = parseHttpUrl(url).host;
  assertHostAllowed(url, policy.blockedHosts, stage);
  if (!policy.allowPrivateHosts && isPrivateHost(host)) {
    throw new GatewayError(
      "private_network",
      `"${host}" is an internal address, so it was not opened in the browser`,
      { details: { host, stage } },
    );
  }
}
