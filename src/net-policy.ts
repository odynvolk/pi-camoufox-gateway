/**
 * The one place that decides whether a url may be opened in a browser tab.
 *
 * `camofox-browser` enforces no egress policy of its own, so without this guard `camoufox_read` —
 * and `resolve: true`, which opens every url Google handed us — is a request forwarder for internal
 * addresses: a model, or a page that tricks the model, can point us at `169.254.169.254` or a LAN
 * service and read the response back as page text.
 *
 * The check therefore lives at the single choke point every navigation passes through
 * (`GatewayClient.openTab`), not only in the read tool. What it cannot do is judge a *name* that
 * resolves to an internal address (DNS rebinding, `localhost` aliases): that needs gateway-side
 * egress policy, which this repo does not own.
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

/** Names that mean "internal" without being an IP literal. */
const PRIVATE_NAMES = new Set(["localhost", "metadata.google.internal"]);

/** `*.localhost` is loopback by RFC 6761, same as the bare name. */
const PRIVATE_SUFFIX = ".localhost";

interface ParsedUrl {
  /** Host, lower-cased and with a trailing `.` removed. */
  host: string;
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
  // exactly like `evil.test`. Normalising here — the only place a host is read — means the host rules
  // and the address rules below can never disagree about what a url points at.
  return { host: parsed.hostname.toLowerCase().replace(/\.$/u, "") };
}

function matchesHostRule(host: string, rule: string): boolean {
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
  const lowered = host.toLowerCase().replace(/\.$/u, "");
  if (PRIVATE_NAMES.has(lowered)) return true;
  if (lowered.endsWith(PRIVATE_SUFFIX)) return true;
  return isPrivateIpv4(lowered) || isPrivateIpv6(lowered);
}

/** The `blockedHosts` half of the policy, kept separate so a caller can name the rule it hit. */
export function assertHostAllowed(url: string, blockedHosts: string[]): void {
  const host = parseHttpUrl(url).host;
  const rule = blockedHosts.map((entry) => entry.toLowerCase()).find((entry) => matchesHostRule(host, entry));
  if (rule !== undefined) {
    throw new GatewayError("host_blocked", `"${host}" is listed in camoufox blockedHosts, so it was not fetched`, {
      details: { host, rule },
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
export function assertTabUrlAllowed(url: string, policy: UrlPolicy = DEFAULT_URL_POLICY): void {
  const host = parseHttpUrl(url).host;
  assertHostAllowed(url, policy.blockedHosts);
  if (!policy.allowPrivateHosts && isPrivateHost(host)) {
    throw new GatewayError(
      "private_network",
      `"${host}" is an internal address, so it was not opened in the browser`,
      { details: { host } },
    );
  }
}
