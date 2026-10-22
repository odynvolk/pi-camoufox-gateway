/**
 * Single owner of every HTTP call to the camofox gateway.
 *
 * Callers get operations, not endpoints: this hides auth headers, the `userId` that has to appear
 * on every request, timeout handling, the documented single retry, and the mapping from HTTP
 * outcomes onto the codes in `errors.ts`. It also tracks the tabs it opened so a leak is a test
 * failure rather than a mystery.
 */

import { GatewayError, type GatewayErrorCode } from "./errors.ts";
import { assertTabUrlAllowed, DEFAULT_URL_POLICY, policyCanRefuse, type UrlPolicy } from "./net-policy.ts";

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  /**
   * Per-request deadline in milliseconds. Required: the only honest default for a request deadline is
   * the one the product documents, and that lives in `config.ts` (`DEFAULT_CONFIG.timeoutMs`). A
   * fallback here was a second, independent number — so a hand-built client ran on a deadline no doc
   * mentioned, and the two could drift without either being wrong.
   */
  timeoutMs: number;
  /**
   * Url policy applied to *every* tab open, not just the read tool: `resolve: true` opens urls that
   * came out of a search engine's page, and engine adapters open their own. Defaults to the private
   * address block with no host list.
   */
  urlPolicy?: UrlPolicy;
  /** Injectable fetch, mainly for tests. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * How long a *failed* liveness probe is honoured, measured from when the failure was observed,
   * before the gateway is dialled again. Defaults to `PREFLIGHT_RETRY_AFTER_MS`. Kept well above
   * `preflightTimeoutMs` on purpose: the window has to outlast the probe it is promising anything about,
   * or a slow failure is written down already expired and every sequential caller re-dials. Holding it
   * for the whole success window would still be wrong — one transient blip would become that entire
   * window of refusals.
   */
  preflightRetryAfterMs?: number;
  /**
   * Deadline for the liveness probe alone, defaulting to `PREFLIGHT_TIMEOUT_MS`.
   *
   * A probe shares nothing with a real request but the transport, and it used to share their deadline
   * too — so at shipped defaults a gateway that hangs rather than refuses made the probe burn the whole
   * `timeoutMs`, and by the time it reported the shorter failure window had already passed. That is why
   * the failure window could not be a promise. It is one now: a probe is bounded on its own, and
   * clamped to `timeoutMs` rather than allowed to raise it.
   */
  preflightTimeoutMs?: number;
  /**
   * How long a *successful* probe is worth answering with. Defaults to `PREFLIGHT_TTL_MS`.
   *
   * A bound on how stale an answer may be, not on how often we dial: past it the next call is served the
   * last known good status and the refresh happens behind it. Injectable so a window is reachable in a
   * test without waiting a minute for one.
   */
  preflightTtlMs?: number;
}

export interface OpenTabResult {
  tabId: string;
  targetId?: string;
  url: string;
  title?: string;
}

export interface NavigateResult {
  url: string;
  refsAvailable?: boolean;
  googleSerp?: boolean;
}

export interface SnapshotResult {
  url: string;
  text: string;
  refsCount: number;
  truncated: boolean;
  totalChars: number;
  hasMore: boolean;
  nextOffset: number;
}

export interface WaitOutcome {
  /**
   * True when the gateway says the selector appeared. A gateway that omits `ok` counts as success: the
   * read still has to return the page, and a missing field is not evidence the selector was absent.
   */
  ok: boolean;
  /** The gateway's own reason for a failed wait, e.g. an invalid selector. */
  error?: string;
  /**
   * Set when the wait could not be performed at all — an older gateway without `POST /tabs/{id}/wait`
   * — so the caller can say so instead of claiming the page was waited for.
   */
  skipped?: string;
}

export interface GatewayStatus {
  ok: boolean;
  enabled?: boolean;
  engine?: string;
  browserRunning?: boolean;
  checkedAt: number;
}

interface RequestOptions {
  userId?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Treat a 404 as a no-op, used by idempotent teardown calls. */
  tolerateMissing?: boolean;
  /**
   * Do not turn a `{ "ok": false }` body into an error. `POST /tabs/{tabId}/wait` answers `ok: false`
   * for the ordinary condition "the selector never appeared", which the caller handles, not fails.
   */
  tolerateNotOk?: boolean;
  /**
   * `"connect-only"` retries only when the request never landed (so the gateway could not have
   * created anything). Opening a tab must use this: a timeout usually means the tab exists and the
   * response was lost, so retrying creates a second tab whose id we never learn.
   *
   * `"never"` opts out of the retry budget entirely, for a request whose failure is reported rather
   * than acted on — retrying an optional wait only doubles the latency the caller paid for it.
   */
  retry?: "always" | "connect-only" | "never";
  /**
   * Deadline for this one request, for the caller whose operation is shorter-lived than the client.
   *
   * Only ever lowers `timeoutMs` — see `GatewayClientOptions.preflightTimeoutMs`.
   */
  timeoutMs?: number;
}

const PREFLIGHT_TTL_MS = 60_000;
/** A failure earns a far shorter window than a success. See `GatewayClientOptions.preflightRetryAfterMs`. */const PREFLIGHT_RETRY_AFTER_MS = 5_000;
/**
 * How long the status probe may take. Well under the shipped `timeoutMs` (30s) on purpose: the point of
 * a probe is that it is the cheap thing, and its result has to arrive inside the window a failure of it
 * is honoured for (`PREFLIGHT_RETRY_AFTER_MS`).
 */
const PREFLIGHT_TIMEOUT_MS = 2_000;

/**
 * Endpoints this extension depends on. Kept in one place so a gateway upgrade is caught by one
 * conformance test (against the recorded OpenAPI fixture) instead of five scattered string literals.
 */
export const ENDPOINTS = {
  status: { method: "GET", path: "/" },
  openTab: { method: "POST", path: "/tabs/open" },
  listTabs: { method: "GET", path: "/tabs" },
  navigate: { method: "POST", path: "/tabs/{tabId}/navigate" },
  snapshot: { method: "GET", path: "/tabs/{tabId}/snapshot" },
  wait: { method: "POST", path: "/tabs/{tabId}/wait" },
  extract: { method: "POST", path: "/tabs/{tabId}/extract" },
  closeTab: { method: "DELETE", path: "/tabs/{tabId}" },
  deleteSession: { method: "DELETE", path: "/sessions/{userId}" },
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

export function endpointPath(name: EndpointName, params: Record<string, string> = {}): string {
  let path: string = ENDPOINTS[name].path;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  return path;
}

/**
 * Did the gateway possibly create a tab before we lost the answer?
 *
 * A connect failure cannot (nothing was sent). A timeout or a cancel can, because the request had
 * already landed. That distinction is what makes the sweep worth its cost.
 */
/** Did this gateway answer 404 because the path does not exist, rather than because a tab is gone? */
function isRouteMissing(error: GatewayError): boolean {
  return (error.details as { routeMissing?: boolean } | undefined)?.routeMissing === true;
}

function isAmbiguousTabOpen(error: unknown): boolean {
  return error instanceof GatewayError && (error.code === "timeout" || error.code === "aborted");
}

function messageFrom(body: unknown, statusHint: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return `gateway responded ${statusHint}`;
}

function isNetworkFailure(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code) return ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code) return ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(cause.code);
  return error instanceof TypeError;
}

/**
 * Reject as soon as the signal does, even if the underlying fetch never settles. Some fetch
 * implementations ignore `signal`, and a hung request would otherwise outlive the tool call.
 */
async function firstToSettle<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) throw onAbort();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly urlPolicy: UrlPolicy;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly preflightRetryAfterMs: number;
  /** The probe's own deadline, never longer than `timeoutMs`. */
  private readonly preflightTimeoutMs: number;
  /** Only ever holds a success. A probe that fails discards it — see `probe`. */
  private preflightCache: GatewayStatus | undefined;
  /** When the cached success was learned. Read only alongside it. */
  private preflightAt = 0;
  private readonly preflightTtlMs: number;
  /**
   * The last failure, honoured for `preflightRetryAfterMs`. Without it a dead gateway is dialled — and
   * times out — on every tool call, which is the guarantee `preflight` advertises in the README.
   */
  private preflightFailure: GatewayError | undefined;
  private preflightFailureAt = 0;
  /** One in-flight probe, so concurrent callers of a dead gateway share it instead of each dialling. */
  private preflightInflight: Promise<GatewayStatus> | undefined;
  /**
   * A refresh running behind a caller it is no longer answering.
   *
   * Its own field, not another shape of `preflightInflight`: nothing awaits it and it never rejects.
   */
  private revalidating: Promise<void> | undefined;
  /** tabId -> userId for every tab this client opened and has not yet closed. */
  private readonly liveTabs = new Map<string, string>();
  /** In-flight /tabs/open calls; an ambiguous failure may only sweep when this is empty. */
  private readonly pendingOpens = new Set<symbol>();

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.urlPolicy = options.urlPolicy ?? DEFAULT_URL_POLICY;
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.preflightRetryAfterMs = options.preflightRetryAfterMs ?? PREFLIGHT_RETRY_AFTER_MS;
    // Clamped, not validated: a probe may decide to give up sooner than a real request would, never
    // later. Refusing an over-long value would have to reject the shipped default against any caller
    // that lowered `timeoutMs` below it, which is a legal thing to do.
    this.preflightTimeoutMs = Math.min(options.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS, this.timeoutMs);
    this.preflightTtlMs = options.preflightTtlMs ?? PREFLIGHT_TTL_MS;
  }

  /** Tabs the client believes are still open, for leak assertions. */
  openTabCount(): number {
    return this.liveTabs.size;
  }

  /**
   * Cheap liveness check.
   *
   * A success is answered with for `preflightTtlMs` and refreshed behind the call once it has passed, so
   * the first call of a window pays nothing for a gateway that is simply up. A failure is honoured for
   * `preflightRetryAfterMs` and re-thrown without dialling, so a burst of calls behind one dead gateway
   * pays one probe rather than one timeout each — and a gateway that blips once is not written off for
   * the whole success window.
   *
   * The trade is named rather than buried: a gateway that dies inside a success window is discovered by
   * the call that straddles the window, from its own request rather than from a probe, because the stale
   * status answered first. Refusals resume from the call after the refresh lands, and stay resumed: a
   * probe that fails discards the success it invalidated, so there is no older answer to fall back to.
   * `liveness` in `extension.ts` re-throws only `gateway_unreachable` and lets everything else reach the
   * real request, so a status we answered with is never the authority on a call that went out.
   */
  async preflight(signal?: AbortSignal): Promise<GatewayStatus> {
    const now = Date.now();
    const known = this.preflightCache;
    if (known && now - this.preflightAt < this.preflightTtlMs) return known;
    if (this.preflightFailure && now - this.preflightFailureAt < this.preflightRetryAfterMs) {
      throw this.preflightFailure;
    }

    // Past the window, an answer we have beats an answer we are about to be late with — and the only one
    // that can still be here is a success, since a probe that fails discards it. The refresh takes no
    // caller's signal on purpose: it is for the calls after this one, and cancelling it because one
    // caller gave up would leave the next one re-dialling too.
    if (known) {
      this.revalidate();
      return known;
    }

    // One probe serves the window *and* its concurrent callers: raced to a dead gateway, N tool calls
    // would otherwise each dial and each wait out their own timeout. Two consequences of sharing, both
    // accepted: the probe is bound to the first caller's signal, so it cannot be cancelled by a later
    // caller, and a later caller that cancels itself is not released early either — it waits out the
    // shared probe, bounded by the retry budget. The alternative to sharing is N connections that all
    // have to fail anyway.
    this.preflightInflight ??= this.probe(signal).finally(() => {
      this.preflightInflight = undefined;
    });
    return this.preflightInflight;
  }

  /**
   * Re-dial without making a caller wait for it.
   *
   * One at a time: callers arriving at an expired window all see the same stale status, and they are all
   * served by the single refresh the first of them started. A failure is recorded by `probe` exactly as a
   * blocking one is, which is what makes the next call refuse cheaply. No caller can see this settle, so
   * it must not be able to throw.
   */
  private revalidate(): void {
    if (this.revalidating) return;
    this.revalidating = this.probe()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.revalidating = undefined;
      });
  }

  /**
   * The actual `GET /`, and the only place either window is written.
   *
   * Both windows are stamped from the moment an outcome is *learned*, never from when the probe set
   * off. A failure that took longer than its own window would otherwise be written down already
   * expired and skipped by the very next call — and a connect timeout is precisely the failure this
   * path exists to bound. `checkedAt` stays start-stamped: it records when we asked, not when we
   * stopped asking.
   */
  private async probe(signal?: AbortSignal): Promise<GatewayStatus> {
    const startedAt = Date.now();
    try {
      const status = await this.requestJson<Record<string, unknown>>("GET", endpointPath("status"), {
        signal,
        // The probe's own deadline, so a hung gateway costs this and not the full request timeout.
        timeoutMs: this.preflightTimeoutMs,
        // Retry a connect failure that never landed — it costs nothing to try again — but never a
        // timeout, which has already spent the entire deadline. Retrying that doubles the latency
        // every caller pays, including the ones sharing this probe. Same reasoning `waitFor` records.
        retry: "connect-only",
      });
      const result: GatewayStatus = {
        ok: status.ok === true,
        enabled: typeof status.enabled === "boolean" ? status.enabled : undefined,
        engine: typeof status.engine === "string" ? status.engine : undefined,
        browserRunning: typeof status.browserRunning === "boolean" ? status.browserRunning : undefined,
        checkedAt: startedAt,
      };
      this.preflightCache = result;
      this.preflightAt = Date.now();
      this.preflightFailure = undefined;
      return result;
    } catch (error) {
      // Every way this can fail is equally futile to redial a millisecond later — except a cancel.
      // `aborted` is one caller's own decision, not evidence about the gateway, and this client hands
      // it to everyone sharing the probe: caching it would report "aborted" to callers who never
      // asked to cancel. `liveness` only acts on `gateway_unreachable` and lets the rest fall through
      // to the real request, which stays the authority on them.
      if (error instanceof GatewayError && error.code !== "aborted") {
        this.preflightFailure = error;
        this.preflightFailureAt = Date.now();
        // A failure invalidates the success, being the fresher fact about the gateway. Leaving it would
        // leave the stale-answer branch of `preflight` reachable for as long as the process lives: a
        // gateway that stays dead would be told "up" once per failure window, indefinitely. So once this
        // window passes the next call has nothing to lean on and blocks on a probe — the only way to
        // learn the gateway recovered.
        this.preflightCache = undefined;
      }
      throw error;
    }
  }

  async openTab(params: { userId: string; url: string; signal?: AbortSignal }): Promise<OpenTabResult> {
    // The choke point: everything that puts a url in the browser goes through here, so a policy that
    // only lived in the read tool could be walked around by url resolution.
    assertTabUrlAllowed(params.url, this.urlPolicy);
    let body: Record<string, unknown>;
    const token = Symbol("openTab");
    this.pendingOpens.add(token);
    try {
      body = await this.requestJson<Record<string, unknown>>("POST", endpointPath("openTab"), {
        body: { userId: params.userId, url: params.url },
        signal: params.signal,
        retry: "connect-only",
      });
    } catch (error) {
      // Timeout or cancel: the tab may exist and we never got its id. Sweep before propagating so a
      // lost response cannot accumulate pages for the life of the gateway.
      if (isAmbiguousTabOpen(error)) {
        this.pendingOpens.delete(token);
        // Only when nothing else of ours is opening: an unfiltered sweep would close tabs that a
        // sibling call has legitimately opened and not finished with. With siblings in flight we can
        // only match by url, which a redirect wrapper cannot do.
        const exclusive = this.pendingOpens.size === 0;
        await this.reconcileStrayTabs({ userId: params.userId, ...(exclusive ? {} : { url: params.url }) }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.pendingOpens.delete(token);
    }
    const tabId = String(body.tabId ?? body.targetId ?? "");
    if (!tabId) {
      throw new GatewayError("gateway_error", "gateway opened a tab without reporting a tabId");
    }
    this.liveTabs.set(tabId, params.userId);
    const result: OpenTabResult = {
      tabId,
      targetId: typeof body.targetId === "string" ? body.targetId : undefined,
      // A gateway that reports no destination gets back the url we asked for, so callers that merely
      // report a url still get one. It is not evidence about where the page went — the check below has
      // nothing to compare in that case — so `snapshot` is where the destination is enforced for real.
      url: typeof body.url === "string" ? body.url : params.url,
      title: typeof body.title === "string" ? body.title : undefined,
    };

    // The browser followed redirects we never saw. Checking only the url we were handed would make
    // any public page a free pass to an internal one, and the destination is already in the response.
    try {
      assertTabUrlAllowed(result.url, this.urlPolicy, "destination");
    } catch (error) {
      await this.closeTabQuietly({ userId: params.userId, tabId });
      throw error;
    }

    return result;
  }

  /**
   * Close tabs the gateway is holding for us that we never learned about.
   *
   * A lost response is the only leak we cannot close the normal way: the gateway may have created the
   * tab before the answer went missing, so we never got an id to close. Listing and closing by url
   * is precise enough to be safe — anything already in `liveTabs` is a tab a live caller owns.
   */
  async reconcileStrayTabs(params: { userId: string; url?: string; signal?: AbortSignal }): Promise<number> {
    const body = await this.requestJson<Record<string, unknown>>("GET", endpointPath("listTabs"), {
      query: { userId: params.userId },
      signal: params.signal,
      retry: "connect-only",
    });
    const tabs = Array.isArray(body.tabs) ? (body.tabs as Record<string, unknown>[]) : [];
    const wanted = params.url ? params.url.replace(/\/$/u, "") : undefined;

    let closed = 0;
    for (const tab of tabs) {
      const tabId = typeof tab.tabId === "string" ? tab.tabId : typeof tab.targetId === "string" ? tab.targetId : "";
      if (!tabId || this.liveTabs.has(tabId)) continue;
      if (wanted) {
        const url = typeof tab.url === "string" ? tab.url.replace(/\/$/u, "") : "";
        if (url !== wanted) continue;
      }
      await this.closeTab({ userId: params.userId, tabId }).catch(() => undefined);
      closed += 1;
    }
    return closed;
  }

  async navigateMacro(params: {
    userId: string;
    tabId: string;
    macro: string;
    query: string;
    signal?: AbortSignal;
  }): Promise<NavigateResult> {
    const body = await this.requestJson<Record<string, unknown>>("POST", endpointPath("navigate", { tabId: params.tabId }), {
      userId: params.userId,
      body: { userId: params.userId, macro: params.macro, query: params.query },
      signal: params.signal,
    });
    return this.asNavigateResult(body, params.tabId);
  }

  async snapshot(params: {
    userId: string;
    tabId: string;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<SnapshotResult> {
    const body = await this.requestJson<Record<string, unknown>>("GET", endpointPath("snapshot", { tabId: params.tabId }), {
      userId: params.userId,
      query: { userId: params.userId, format: "text", ...(params.offset ? { offset: params.offset } : {}) },
      signal: params.signal,
    });
    const text = typeof body.snapshot === "string" ? body.snapshot : "";
    const totalChars = typeof body.totalChars === "number" ? body.totalChars : text.length;
    const nextOffset = typeof body.nextOffset === "number" ? body.nextOffset : text.length;
    let url = typeof body.url === "string" ? body.url : "";

    // A snapshot we cannot place is not a snapshot we may hand back: there would be nothing to check,
    // the guard would be skipped silently, and `read` would report the url we asked for as though it
    // were where the page ended up. That is how a client-side redirect to `169.254.169.254` returns an
    // internal body under a public-looking header. Ask the tab list once, and refuse if that stays
    // silent too — but only while the guard can still refuse something, so a caller that switched it
    // off entirely is not blocked by a check that can no longer fire.
    if (!url && policyCanRefuse(this.urlPolicy)) {
      url = await this.tabLocation({ userId: params.userId, tabId: params.tabId, signal: params.signal });
      if (!url) {
        throw new GatewayError(
          "destination_unreported",
          "the gateway reported no destination for this page, so its content was not returned — a page that moves after opening would go unchecked",
          { details: { tabId: params.tabId } },
        );
      }
    }

    const result: SnapshotResult = {
      url,
      text,
      refsCount: typeof body.refsCount === "number" ? body.refsCount : (text.match(/\[e\d+\]/gu) ?? []).length,
      truncated: body.truncated === true,
      totalChars,
      hasMore: body.hasMore === true,
      nextOffset,
    };
    // Where the page actually ended up, from the one response that cannot be stale. `openTab` re-checks
    // the destination it is handed, but a gateway that reports no url there leaves that check with
    // nothing to compare — it falls back to the url we asked for, which is the one already vetted. This
    // is the check that still holds, it is the one no caller can forget to write, and content from a
    // destination we would have refused is content we must not hand back.
    if (result.url) assertTabUrlAllowed(result.url, this.urlPolicy, "destination");
    return result;
  }

  /** Where the tab list says this tab is. Empty when the gateway will not say, which is treated as unsafe. */
  private async tabLocation(params: { userId: string; tabId: string; signal?: AbortSignal }): Promise<string> {
    const body = await this.requestJson<Record<string, unknown>>("GET", endpointPath("listTabs"), {
      userId: params.userId,
      query: { userId: params.userId },
      signal: params.signal,
      tolerateMissing: true,
    });
    const tabs = Array.isArray(body.tabs) ? (body.tabs as Record<string, unknown>[]) : [];
    for (const tab of tabs) {
      const tabId = typeof tab.tabId === "string" ? tab.tabId : typeof tab.targetId === "string" ? tab.targetId : "";
      if (tabId !== params.tabId) continue;
      return typeof tab.url === "string" ? tab.url : "";
    }
    return "";
  }

  /**
   * Ask the gateway to hold until a selector exists in the rendered page.
   *
   * An enhancement, so nothing that stops it may end the read: a gateway older than the endpoint
   * answers 404, and one that ignores its own `timeout` argument is cut off by our per-request
   * deadline. Both degrade to a reported skip and we snapshot anyway — once, because `retry: "never"`
   * keeps an optional wait from costing the retry budget, and it is why an over-long gateway deadline
   * cannot cost us twice. A cancelled call or a tab that vanished is different: there is nothing left
   * to read, so `aborted` and `tab_not_found` are the only codes allowed out of here.
   */
  async waitFor(params: {
    userId: string;
    tabId: string;
    selector: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<WaitOutcome> {
    // Two deadlines on one request. Ours wins: telling the gateway to hold for longer than we can wait
    // buys work we then abandon. Config validation keeps the pair coherent, so this only bites for a
    // client built by hand.
    const timeoutMs = params.timeoutMs === undefined ? undefined : Math.min(params.timeoutMs, this.timeoutMs);
    try {
      const body = await this.requestJson<Record<string, unknown>>("POST", endpointPath("wait", { tabId: params.tabId }), {
        userId: params.userId,
        body: {
          userId: params.userId,
          selector: params.selector,
          ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        },
        signal: params.signal,
        tolerateNotOk: true,
        retry: "never",
      });
      // Only a gateway that omits the field gets the benefit of the doubt. Anything else has to say so
      // outright: silence from `read` is what tells the model the selector appeared.
      const ok = body.ok === undefined ? true : body.ok === true;
      return { ok, ...(typeof body.error === "string" ? { error: body.error } : {}) };
    } catch (error) {
      if (error instanceof GatewayError) {
        if (error.code === "gateway_error" && isRouteMissing(error)) {
          return { ok: false, skipped: "gateway has no /wait route" };
        }
        if (error.code === "timeout" || error.code === "gateway_error") {
          return { ok: false, skipped: error.message };
        }
      }
      throw error;
    }
  }

  async extract(params: {
    userId: string;
    tabId: string;
    schema: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const body = await this.requestJson<Record<string, unknown>>("POST", endpointPath("extract", { tabId: params.tabId }), {
      userId: params.userId,
      body: { userId: params.userId, schema: params.schema },
      signal: params.signal,
    });
    const data = body.data;
    if (data === null || typeof data !== "object") {
      throw new GatewayError("extraction_empty", "gateway returned no structured data for that schema");
    }
    return data as Record<string, unknown>;
  }

  async closeTab(params: { userId: string; tabId: string; signal?: AbortSignal }): Promise<void> {
    await this.requestJson("DELETE", endpointPath("closeTab", { tabId: params.tabId }), {
      userId: params.userId,
      query: { userId: params.userId },
      signal: params.signal,
      tolerateMissing: true,
    });
    this.liveTabs.delete(params.tabId);
  }

  /**
   * Teardown-only close. It must not inherit the caller's signal: when a tool call is aborted, the
   * aborted signal makes the DELETE throw before it is sent, the caller swallows the error, and the
   * page stays open on the gateway forever.
   */
  async closeTabQuietly(params: { userId: string; tabId: string }): Promise<void> {
    try {
      await this.closeTab(params);
    } catch {
      // Best effort. `session_shutdown` still reclaims the tab, and losing one page is not worth
      // replacing the error the caller is already about to return.
    }
  }

  /** Best-effort: an already-gone session is not an error. */
  async deleteSession(params: { userId: string; signal?: AbortSignal }): Promise<void> {
    await this.requestJson("DELETE", endpointPath("deleteSession", { userId: params.userId }), {
      signal: params.signal,
      tolerateMissing: true,
    });
    for (const [tabId, userId] of [...this.liveTabs.entries()]) {
      if (userId === params.userId) this.liveTabs.delete(tabId);
    }
  }

  private asNavigateResult(body: Record<string, unknown>, tabId: string): NavigateResult {
    if (body.ok === false) {
      throw new GatewayError("navigation_failed", messageFrom(body, 200), { details: { tabId } });
    }
    return {
      url: typeof body.url === "string" ? body.url : "",
      refsAvailable: typeof body.refsAvailable === "boolean" ? body.refsAvailable : undefined,
      googleSerp: typeof body.googleSerp === "boolean" ? body.googleSerp : undefined,
    };
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const target = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
    return target.toString();
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions & { tolerateMissing?: boolean } = {},
  ): Promise<T> {
    // The documented retry budget is exactly one extra attempt, and only for transient outcomes.
    let lastError: GatewayError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.perform<T>(method, path, options);
      } catch (error) {
        // This is the transport boundary, so a bare throw here happened while talking to the gateway —
        // an unreadable body, a half-open socket. It stays `gateway_error`; anything further out is ours.
        const gatewayError = error instanceof GatewayError ? error : new GatewayError("gateway_error", String(error));
        const connectOnly = options.retry === "connect-only" && gatewayError.code !== "gateway_unreachable";
        const never = options.retry === "never";
        if (attempt === 0 && gatewayError.retryable && !never && !connectOnly && !options.signal?.aborted) {
          lastError = gatewayError;
          continue;
        }
        throw gatewayError;
      }
    }
    throw lastError ?? new GatewayError("gateway_error", `request to ${path} failed`);
  }

  private async perform<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    // One number for this request, so the deadline that fires and the deadline that gets reported
    // cannot be two different ones.
    const deadlineMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const callerSignal = options.signal;
    const onAbort = () => controller.abort(callerSignal?.aborted ? "caller" : "timeout");
    if (callerSignal) {
      if (callerSignal.aborted) onAbort();
      else callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("timeout");
    }, deadlineMs);

    try {
      if (controller.signal.aborted) {
        throw this.abortError(callerSignal, deadlineMs);
      }
      const response = await firstToSettle(
        this.fetchImpl(this.url(path, options.query), {
          method,
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        }),
        controller.signal,
        () => this.abortError(callerSignal, deadlineMs),
      );
      if (controller.signal.aborted) throw this.abortError(callerSignal, deadlineMs);

      const body = await this.readBody(response);

      if (!response.ok) {
        if (options.tolerateMissing && response.status === 404) return {} as T;
        throw this.httpError(response, body, path, options);
      }
      if (body && typeof body === "object" && (body as Record<string, unknown>).ok === false && !options.tolerateNotOk) {
        throw this.gatewayBodyError(body as Record<string, unknown>, path);
      }
      if (body === undefined) {
        throw new GatewayError("gateway_error", `gateway returned no body for ${method} ${path}`);
      }
      return body as T;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if ((error as { name?: string })?.name === "AbortError") throw this.abortError(callerSignal, deadlineMs);
      if (isNetworkFailure(error)) {
        throw new GatewayError("gateway_unreachable", `cannot reach the gateway at ${this.baseUrl}: ${String(error)}. Check that camofox-browser is running and try \`GET ${this.baseUrl}/\`.`, {
          retryable: true,
        });
      }
      throw new GatewayError("gateway_error", `gateway request ${method} ${path} failed: ${String(error)}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  }

  private abortError(signal?: AbortSignal, deadlineMs: number = this.timeoutMs): GatewayError {
    if (signal?.aborted) {
      // A deadline that aborts on its own behalf keeps its own code; a cancelled tool call gets the
      // plain `aborted`.
      if (signal.reason instanceof GatewayError) return signal.reason;
      return new GatewayError("aborted", "the tool call was cancelled before the gateway request completed");
    }
    return new GatewayError("timeout", `gateway did not respond within ${deadlineMs}ms`, { retryable: true });
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private httpError(response: Response, body: unknown, path: string, options: RequestOptions): GatewayError {
    const message = messageFrom(body, response.status);
    const details = { status: response.status, path };

    if (response.status === 401 || response.status === 403) {
      return new GatewayError("gateway_unauthorized", `gateway rejected our credentials: ${message}`, { details });
    }
    if (response.status === 404) {
      if (/tab not found/i.test(message)) {
        const tabId = path.match(/^\/tabs\/([^/]+)/)?.[1] ?? "?";
        return new GatewayError("tab_not_found", `the browser tab ${tabId} is gone for user "${options.userId}"`, { details });
      }
      // "We asked for a path this gateway does not have" — flagged structurally, because the caller that
      // degrades on it must not be coupled to how this message is phrased.
      return new GatewayError("gateway_error", `gateway has no route ${path}: ${message}`, { details: { ...details, routeMissing: true } });
    }
    if (response.status === 400 && /blocked url|scheme/i.test(message)) {
      return new GatewayError("blocked_url", message, { details });
    }
    if (response.status >= 500) {
      return new GatewayError("gateway_error", `gateway error ${response.status}: ${message}`, { details, retryable: true });
    }
    return new GatewayError("gateway_error", `gateway rejected the request (${response.status}): ${message}`, { details });
  }

  private gatewayBodyError(body: Record<string, unknown>, path: string): GatewayError {
    const message = messageFrom(body, 200);
    if (/consent|captcha/i.test(message)) {
      return new GatewayError("consent_wall", `google served a consent/CAPTCHA interstitial: ${message}`, {
        details: { path },
      });
    }
    if (/blocked url|scheme/i.test(message)) {
      return new GatewayError("blocked_url", message, { details: { path } });
    }
    return new GatewayError("gateway_error", message, { details: { path } });
  }
}

/** Factory form keeps the client's construction site identical everywhere it is used. */
export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  return new GatewayClient(options);
}
