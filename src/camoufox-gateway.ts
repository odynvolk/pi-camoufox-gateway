/**
 * pi extension entry point.
 *
 * This is the only file that imports pi. It decides *where* things live — tool registration, the
 * session id, shutdown — and delegates every decision to `extension.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { ENGINE_NAMES, MAX_SEARCH_RESULTS } from "./config.ts";
import { GatewayError } from "./errors.ts";
import { urlPolicyFromConfig } from "./net-policy.ts";
import { createExtension, formatError, resolveConfig, READ_DESCRIPTION, SEARCH_DESCRIPTION, type Extension, type ReadToolArgs, type ReadToolResult, type SearchDetails, type SearchToolArgs, type ToolOutcome } from "./extension.ts";
import type { TriedStep } from "./engines/chain.ts";
import { createCache } from "./cache.ts";
import { createGatewayClient } from "./gateway.ts";
import { gatewaySessionId } from "./session.ts";

const SearchSchema = Type.Object({
  query: Type.String({ description: "Keywords to search for" }),
  // `Integer`, not `Number`: the tool refuses a fractional count, and a schema offering one would be a
  // promise the code breaks. The guard is still in `tools/search.ts` because that is what actually holds.
  n: Type.Optional(Type.Integer({ description: `Maximum results (engine returns a page of ${MAX_SEARCH_RESULTS})` })),
  engine: Type.Optional(
    Type.Enum(ENGINE_NAMES, {
      description: `Force one engine. Anything else is refused with code unsupported — an unfamiliar name as "unknown engine", a real one you have switched off as "disabled in your config"`,
    }),
  ),
  resolve: Type.Optional(Type.Boolean({ description: "Resolve google redirect urls to final urls" })),
});

const ReadSchema = Type.Object({
  url: Type.String({ description: "http(s) url to read" }),
  // `Integer` for both, on `n`'s reasoning: the tool refuses a fraction, a negative, and any string, and
  // a schema offering one would be a promise the code breaks. Nothing checks arguments, so the schema is
  // also the only place the floor and the refusal code can be said before the call is made.
  maxChars: Type.Optional(
    Type.Integer({
      description:
        "Text budget for this call: a whole number of characters, 1 or more — anything else is refused with code unsupported. Defaults to your read.defaultMaxChars and capped at read.maxCharsCeiling",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      description: "Continue a previous read here: a whole number of characters, 0 or more, taken from the nextOffset it reported — anything else is refused with code unsupported",
    }),
  ),
  waitFor: Type.Optional(
    Type.String({
      description: "CSS selector to hold for before reading, bounded by your read.waitForTimeoutMs (for late-rendering content)",
    }),
  ),
  schema: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON Schema with x-ref hints" })),
  fresh: Type.Optional(
    Type.Boolean({ description: "Ignore the page cache and navigate (pages are reused until cache.pageMs passes)" }),
  ),
});

/**
 * Output contracts.
 *
 * A tool without one is handed to a programmatic caller as its `content` — the prose written for a
 * model, which a script then has to re-parse. Declaring these is what lets a codemode script take
 * `results[].url` rather than a numbered list. `error` is part of the shape rather than an exception
 * to it: a failure is an outcome these tools produce, and pi keeps `structuredContent` on an
 * `isError` result, so a caller must not get a half-filled object with nothing to read.
 */
const ToolErrorSchema = Type.Object({
  code: Type.String({ description: "The code from the Error codes table in README" }),
  message: Type.String({ description: "Why, as the model was told" }),
});

const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String({ description: "The result url, still a redirect wrapper while `resolvable` is true" }),
  host: Type.String(),
  snippet: Type.String(),
  resolvable: Type.Boolean({ description: "True when only navigating to it reveals where it goes" }),
  engine: Type.String(),
  ref: Type.Optional(Type.String({ description: "Snapshot ref, valid until the next navigation" })),
  cite: Type.Optional(Type.String()),
  resolved: Type.Optional(Type.Boolean({ description: "True when this call replaced a wrapper with its destination" })),
  resolveError: Type.Optional(Type.String({ description: "Why a wrapper stayed wrapped" })),
});

/** The search result as returned. `requested` is deliberately absent: it echoes what was asked, not what came back. */
const SearchOutputSchema = Type.Object({
  query: Type.String({ description: "The query exactly as this call was asked for it, including a failed one" }),
  results: Type.Array(SearchResultSchema, { description: "Ranked results, empty when nothing was served" }),
  engine: Type.Optional(Type.String({ description: "The engine that served, absent when none did" })),
  tried: Type.Array(
    Type.Object({ engine: Type.String(), code: Type.String(), message: Type.String() }),
    { description: "One entry per engine attempted, in order; empty when nothing was attempted" },
  ),
  clampedTo: Type.Optional(Type.Number({ description: "Set when the ask exceeded what one call may return" })),
  shortBy: Type.Optional(Type.Number({ description: "How far short of the ask the page came" })),
  pageCarried: Type.Optional(Type.Number({ description: "How many the engine page held, when more than this call returned" })),
  settledInMs: Type.Optional(Type.Number({ description: "Extra time the engines spent re-looking at a SERP that had not arrived" })),
  fromCache: Type.Optional(Type.Boolean()),
  error: Type.Optional(ToolErrorSchema),
});

const ReadOutputSchema = Type.Object({
  url: Type.String({ description: "Where the page ended up, or the url asked for on a call that got nowhere" }),
  text: Type.String({ description: "The page text this call returned, already sliced to maxChars and offset" }),
  truncated: Type.Boolean({ description: "True when this call's own budget cut the page" }),
  hasMore: Type.Boolean({ description: "True when the gateway says more exists beyond what it sent" }),
  totalChars: Type.Number({ description: "The whole page, not what this call returned" }),
  nextOffset: Type.Union([Type.Number(), Type.Null()], { description: "Offset to resume at, null when there is nothing left" }),
  refsCount: Type.Number(),
  settledInMs: Type.Optional(Type.Number({ description: "Extra time spent re-snapshotting a thin page" })),
  stalledAtDeadline: Type.Optional(Type.Boolean()),
  thinAfterWait: Type.Optional(Type.Boolean()),
  waitForRequested: Type.Optional(Type.Boolean()),
  waitNote: Type.Optional(Type.String({ description: "What a `waitFor` did not achieve, in words" })),
  fromCache: Type.Optional(Type.Boolean()),
  cappedAt: Type.Optional(Type.Number({ description: "read.maxCharsCeiling, when it is what bounded this call" })),
  extracted: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "A schema extraction's data" })),
  error: Type.Optional(ToolErrorSchema),
});

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

/**
 * What a `structuredContent` value may hold.
 *
 * pi's own `JsonValue` is not re-exported from the package entry point, and reaching past it into
 * `@earendil-works/pi-ai` would make a transitive dependency one this package names. The same union,
 * spelled here — and `tsc` still checks it against whatever pi's field wants.
 */
type Structured = null | boolean | number | string | readonly Structured[] | { [key: string]: Structured };

/** What pi gets back when a tool call fails. `isError` stays a literal, because pi branches on it. */
interface ToolFailure {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  /**
   * Still filled in. pi keeps this on an `isError` result, and a caller that asked for the tool's data
   * should get the empty version of it plus the reason, not a different shape altogether.
   */
  structuredContent: { [key: string]: Structured };
  isError: true;
}

/**
 * A progress line, in the shape pi's tool UI expects.
 *
 * `details` is empty because nothing is yet true about the outcome — a half-filled result would be
 * indistinguishable from the real one to anything reading the update stream.
 */
function progress(note: string) {
  return { content: [{ type: "text" as const, text: note }], details: {} };
}

/**
 * The engine chain's record, as the output schema declares it.
 *
 * `code` is a union of error names in and a string out: a script must not find its match list moved by
 * a code added on the server side of this boundary.
 */
function structuredTried(tried: readonly TriedStep[]): { engine: string; code: string; message: string }[] {
  return tried.map((step) => ({ engine: step.engine, code: String(step.code), message: step.message }));
}

/**
 * What pi gets back when a search succeeded.
 *
 * `structuredContent` is spelled field by field rather than spread from `details` on purpose: a declared
 * schema and an opaque object can drift apart by one field, and an unvalidated contract gives no warning
 * when they do. Spelled out, `tsc` is the warning.
 */
function searchResult(args: SearchToolArgs, outcome: ToolOutcome<SearchDetails>) {
  const details = outcome.details;
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    details,
    structuredContent: {
      query: args.query,
      results: details.results.map((result) => ({
        title: result.title,
        url: result.url,
        host: result.host,
        snippet: result.snippet,
        resolvable: result.resolvable,
        engine: result.engine,
        ...(result.ref === undefined ? {} : { ref: result.ref }),
        ...(result.cite === undefined ? {} : { cite: result.cite }),
        ...(result.resolved === undefined ? {} : { resolved: result.resolved }),
        ...(result.resolveError === undefined ? {} : { resolveError: result.resolveError }),
      })),
      ...(details.engine === undefined ? {} : { engine: details.engine }),
      tried: structuredTried(details.tried),
      ...(details.clampedTo === undefined ? {} : { clampedTo: details.clampedTo }),
      ...(details.shortBy === undefined ? {} : { shortBy: details.shortBy }),
      ...(details.pageCarried === undefined ? {} : { pageCarried: details.pageCarried }),
      ...(details.settledInMs === undefined ? {} : { settledInMs: details.settledInMs }),
      ...(details.fromCache === undefined ? {} : { fromCache: details.fromCache }),
    },
  };
}

/** The read shape. Same reasoning as `searchResult`, and the same one exception. */
function readResult(args: ReadToolArgs, outcome: ReadToolResult) {
  const details = outcome.details;
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    details,
    structuredContent: {
      // The url asked for, on a call that got nowhere: `url` is a required field, and the only location a
      // failed read can vouch for is the one the caller supplied.
      url: details.url || args.url,
      // Unwrapped, for the reason `ReadToolResult.pageText` gives.
      text: outcome.pageText,
      truncated: details.truncated,
      hasMore: details.hasMore,
      totalChars: details.totalChars,
      nextOffset: details.nextOffset,
      refsCount: details.refsCount,
      ...(details.settledInMs === undefined ? {} : { settledInMs: details.settledInMs }),
      ...(details.stalledAtDeadline === undefined ? {} : { stalledAtDeadline: details.stalledAtDeadline }),
      ...(details.thinAfterWait === undefined ? {} : { thinAfterWait: details.thinAfterWait }),
      ...(details.waitForRequested === undefined ? {} : { waitForRequested: details.waitForRequested }),
      ...(details.waitNote === undefined ? {} : { waitNote: details.waitNote }),
      ...(details.fromCache === undefined ? {} : { fromCache: details.fromCache }),
      ...(details.cappedAt === undefined ? {} : { cappedAt: details.cappedAt }),
      // The one field this function cannot vouch for: an extraction is whatever the gateway put under
      // `data`, typed as a record of unknowns. It arrives from `JSON.parse`, so it is JSON by
      // construction — the cast records that, rather than the type claiming the boundary was checked.
      ...(details.extracted === undefined ? {} : { extracted: details.extracted as { [key: string]: Structured } }),
    },
  };
}

/** The frame each tool returns when it got nowhere, so a failure has one shape rather than two. */
const failedSearch = (query: string): { [key: string]: Structured } => ({ query, results: [], tried: [] });
const failedRead = (url: string): { [key: string]: Structured } => ({
  url,
  text: "",
  truncated: false,
  hasMore: false,
  totalChars: 0,
  nextOffset: null,
  refsCount: 0,
});

/**
 * The shape pi gets back when a call failed.
 *
 * The url quoted here is the one this client was built with, never one re-read on the error path: the
 * address has to describe the call that just failed. `resolveConfig()` used to be called here, and a
 * file that will not load makes it return the shipped defaults — the address of no call at all.
 */
function failure(error: unknown, extension: Extension | undefined, frame: { [key: string]: Structured }): ToolFailure {
  const gatewayUrl = extension && !extension.configError ? extension.gatewayUrl : undefined;
  const formatted = formatError(error, { ...(gatewayUrl ? { gatewayUrl } : {}) });
  const code = formatted.details.code;
  const tried = formatted.details.tried;
  return {
    content: [{ type: "text", text: formatted.text }],
    details: formatted.details,
    structuredContent: {
      ...frame,
      // Whatever the chain got through is worth keeping: `google=consent_wall, duckduckgo=parse_error` is
      // the difference between a retry and a bug report, and a script reads it without parsing a sentence.
      ...(Array.isArray(tried) && tried.length > 0 ? { tried: tried as Structured[] } : {}),
      error: { code: typeof code === "string" ? code : "internal_error", message: formatted.text },
    },
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "camoufox_search",
    label: "Camoufox Search",
    description: SEARCH_DESCRIPTION,
    parameters: SearchSchema,
    outputSchema: SearchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    async execute(_id: string, args: Static<typeof SearchSchema>, signal, onUpdate, ctx) {
      let extension: Extension | undefined;
      const toolArgs = args as SearchToolArgs;
      try {
        extension = getExtension(ctx);
        const outcome = await extension.search(toolArgs, {
          signal,
          ...(onUpdate ? { onProgress: (note: string) => onUpdate(progress(note)) } : {}),
        });
        return searchResult(toolArgs, outcome);
      } catch (error) {
        return failure(error, extension, failedSearch(toolArgs.query));
      }
    },
  });

  pi.registerTool({
    name: "camoufox_read",
    label: "Camoufox Read",
    description: READ_DESCRIPTION,
    parameters: ReadSchema,
    outputSchema: ReadOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    async execute(_id: string, args: Static<typeof ReadSchema>, signal, onUpdate, ctx) {
      let extension: Extension | undefined;
      const toolArgs = args as ReadToolArgs;
      try {
        extension = getExtension(ctx);
        const outcome = await extension.read(toolArgs, {
          signal,
          ...(onUpdate ? { onProgress: (note: string) => onUpdate(progress(note)) } : {}),
        });
        return readResult(toolArgs, outcome);
      } catch (error) {
        return failure(error, extension, failedRead(toolArgs.url));
      }
    },
  });

  /**
   * Release the session that is shutting down, and only that one.
   *
   * `extensions` is module-level while pi gives each session its own extension runtime, so clearing it
   * wholesale made one session's quit drop every other session's client, cache, and gateway-side tabs.
   * pi emits this to the outgoing session's runner before replacing it, so `ctx` still names the session
   * being torn down. Deleting the entry before the round trip keeps a call landing mid-teardown from
   * reusing an extension that is on its way out — it builds a fresh one instead.
   *
   * Idempotent, because pi says cancellation, reload, session replacement, and process exit can converge
   * on this path; a session that never registered anything has nothing to release.
   */
  pi.on("session_shutdown", async (_event, ctx) => {
    // An id that cannot be derived cannot name a session on the gateway, so there is nothing of ours to
    // release. Swallowed rather than thrown: pi surfaces a throw here as a shutdown failure, and an id we
    // cannot name is not one. Narrowed to that fault deliberately — the read of `ctx` sits in the same
    // try, and a context pi has already invalidated would otherwise be swallowed with it, leaving a
    // session unreleased and nothing said about it.
    let userId: string;
    try {
      userId = sessionOf(ctx);
    } catch (error) {
      if (error instanceof GatewayError && error.code === "internal_error") return;
      throw error;
    }
    const extension = extensions.get(userId);
    if (!extension) return;
    extensions.delete(userId);
    await extension.shutdown().catch(() => undefined);
  });
}
