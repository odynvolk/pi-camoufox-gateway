/**
 * The read side: navigate, report where we actually ended up, and hand back a bounded slice of the
 * page. The bound is the point — the gateway happily returns ~20K tokens of accessibility tree for
 * a single page, and the model asked for a page, not an eviction.
 */

import type { CamoufoxConfig } from "../config.ts";
import { GatewayError } from "../errors.ts";
import type { GatewayClient } from "../gateway.ts";
import { detectWall, extractText, type ExtractedText } from "../snapshot.ts";

export interface ReadToolDeps {
  client: GatewayClient;
  config: CamoufoxConfig;
  userId: string;
}

export interface ReadParams {
  url: string;
  maxChars?: number;
  offset?: number;
  /** JSON Schema with `x-ref` hints; requires a snapshot first, which this tool does for you. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ReadOutcome {
  url: string;
  text: string;
  truncated: boolean;
  hasMore: boolean;
  totalChars: number;
  nextOffset: number | null;
  extracted?: Record<string, unknown>;
  refsCount: number;
}

/** Reject before the browser is touched: the gateway enforces no host policy of its own. */
export function assertHostAllowed(url: string, blockedHosts: string[]): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new GatewayError("unsupported", `"${url}" is not a valid URL`);
  }
  for (const rule of blockedHosts) {
    const needle = rule.toLowerCase();
    if (!needle) continue;
    const hit = needle.startsWith("*.")
      ? host === needle.slice(2) || host.endsWith(needle.slice(1))
      : host === needle || host.endsWith(`.${needle}`);
    if (hit) {
      throw new GatewayError("host_blocked", `"${host}" is listed in camoufox blockedHosts, so it was not fetched`, {
        details: { host, rule: needle },
      });
    }
  }
}

export function readTool(deps: ReadToolDeps) {
  const { client, config, userId } = deps;

  async function read(params: ReadParams): Promise<ReadOutcome> {
    if (!/^https?:\/\//iu.test(params.url ?? "")) {
      throw new GatewayError("blocked_url", `camoufox_read only fetches http(s) urls (got "${params.url}")`);
    }
    assertHostAllowed(params.url, config.blockedHosts);

    const tab = await client.openTab({ userId, url: params.url, signal: params.signal });
    try {
      let snapshot = await client.snapshot({ userId, tabId: tab.tabId, offset: params.offset, signal: params.signal });

      const wall = detectWall(snapshot);
      if (wall) {
        throw new GatewayError(wall, `the page did not load as content (${wall}): ${snapshot.url}`, {
          details: { url: snapshot.url, refsCount: snapshot.refsCount },
        });
      }

      let extracted: Record<string, unknown> | undefined;
      if (params.schema) {
        extracted = await client.extract({ userId, tabId: tab.tabId, schema: params.schema, signal: params.signal });
        if (Object.keys(extracted).length === 0) {
          throw new GatewayError("extraction_empty", "no element matched that schema's refs — re-read the page and use current refs", {
            details: { url: snapshot.url, refsCount: snapshot.refsCount },
          });
        }
      }

      const budget = params.maxChars ?? config.read.defaultMaxChars;
      const sliced: ExtractedText = extractText(snapshot, { maxChars: budget, offset: params.offset });

      return {
        url: snapshot.url || tab.url,
        text: sliced.text,
        truncated: sliced.truncated,
        hasMore: sliced.hasMore,
        totalChars: sliced.totalChars,
        nextOffset: sliced.nextOffset,
        ...(extracted ? { extracted } : {}),
        refsCount: snapshot.refsCount,
      };
    } finally {
      await client.closeTabQuietly({ userId, tabId: tab.tabId });
    }
  }

  return { name: "camoufox_read", read };
}
