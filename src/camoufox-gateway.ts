/**
 * pi extension entry point.
 *
 * This is the only file that imports pi. It decides *where* things live — tool registration, the
 * session id, shutdown — and delegates every decision to `extension.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { DEFAULT_CONFIG, ENGINE_NAMES } from "./config.ts";
import { urlPolicyFromConfig } from "./net-policy.ts";
import { createExtension, formatError, resolveConfig, READ_DESCRIPTION, SEARCH_DESCRIPTION, type Extension } from "./extension.ts";
import { MAX_RESULTS_HARD_LIMIT } from "./tools/search.ts";
import { createCache } from "./cache.ts";
import { createGatewayClient } from "./gateway.ts";
import { gatewaySessionId } from "./session.ts";

const SearchSchema = Type.Object({
  query: Type.String({ description: "Keywords to search for" }),
  n: Type.Optional(Type.Number({ description: `Maximum results (engine returns a page of ${MAX_RESULTS_HARD_LIMIT})` })),
  engine: Type.Optional(Type.String({ description: `Force one engine: ${ENGINE_NAMES.join(" | ")}` })),
  resolve: Type.Optional(Type.Boolean({ description: "Resolve google redirect urls to final urls" })),
});

const ReadSchema = Type.Object({
  url: Type.String({ description: "http(s) url to read" }),
  maxChars: Type.Optional(Type.Number({ description: `Text budget, defaults to ${DEFAULT_CONFIG.read.defaultMaxChars}` })),
  offset: Type.Optional(Type.Number({ description: "Continue a previous read here" })),
  waitFor: Type.Optional(
    Type.String({
      description: `CSS selector to hold for before reading, up to ${DEFAULT_CONFIG.read.waitForTimeoutMs}ms (for late-rendering content)`,
    }),
  ),
  schema: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON Schema with x-ref hints" })),
  fresh: Type.Optional(
    Type.Boolean({ description: "Ignore the page cache and navigate (pages are reused until cache.pageMs passes)" }),
  ),
});

type SearchArgs = Static<typeof SearchSchema>;
type ReadArgs = Static<typeof ReadSchema>;

const extensions = new Map<string, Extension>();

function sessionOf(ctx: ExtensionContext): string {
  return gatewaySessionId(ctx.sessionManager.getSessionId());
}

function getExtension(ctx: ExtensionContext): Extension {
  const userId = sessionOf(ctx);
  const existing = extensions.get(userId);
  if (existing) return existing;

  const { config, error } = resolveConfig();
  const client = createGatewayClient({
    baseUrl: config.gatewayUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeoutMs: config.timeoutMs,
    // Applied to every tab the client opens, including search-result url resolution.
    urlPolicy: urlPolicyFromConfig(config),
  });
  const extension = createExtension({
    config,
    client,
    cache: createCache(),
    userId,
    ...(error ? { configError: error } : {}),
  });
  extensions.set(userId, extension);
  return extension;
}

/** What pi gets back when a tool call fails. `isError` stays a literal, because pi branches on it. */
interface ToolFailure {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError: true;
}

/**
 * The shape pi gets back when a tool call fails.
 *
 * Only a url the user's own config supplied is worth quoting. Used to fall back to `resolveConfig()`,
 * which returns the shipped defaults when the file will not load — so a broken config reported a
 * gateway url the user never set, in the one message they are reading carefully.
 */
function failure(error: unknown, extension?: Extension): ToolFailure {
  const gatewayUrl = extension && !extension.configError ? extension.gatewayUrl : undefined;
  const formatted = formatError(error, { ...(gatewayUrl ? { gatewayUrl } : {}) });
  return {
    content: [{ type: "text", text: formatted.text }],
    details: formatted.details,
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "camoufox_search",
    label: "Camoufox Search",
    description: SEARCH_DESCRIPTION,
    parameters: SearchSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    async execute(_id: string, args: Static<typeof SearchSchema>, signal, _onUpdate, ctx) {
      let extension: Extension | undefined;
      try {
        extension = getExtension(ctx);
        const outcome = await extension.search(args as SearchArgs, { signal });
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      } catch (error) {
        return failure(error, extension);
      }
    },
  });

  pi.registerTool({
    name: "camoufox_read",
    label: "Camoufox Read",
    description: READ_DESCRIPTION,
    parameters: ReadSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    async execute(_id: string, args: Static<typeof ReadSchema>, signal, _onUpdate, ctx) {
      let extension: Extension | undefined;
      try {
        extension = getExtension(ctx);
        const outcome = await extension.read(args as ReadArgs, { signal });
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      } catch (error) {
        return failure(error, extension);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    for (const extension of extensions.values()) {
      await extension.shutdown().catch(() => undefined);
    }
    extensions.clear();
  });
}
