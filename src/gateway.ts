/**
 * Single owner of every HTTP call to the camofox gateway.
 *
 * Callers get operations, not endpoints: this hides auth headers, the `userId` that has to appear
 * on every request, timeout handling, the documented single retry, and the mapping from HTTP
 * outcomes onto the codes in `errors.ts`. It also tracks the tabs it opened so a leak is a test
 * failure rather than a mystery.
 */

import { GatewayError, type GatewayErrorCode } from "./errors.ts";

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch, mainly for tests. */
  fetchImpl?: typeof globalThis.fetch;
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
   * `"connect-only"` retries only when the request never landed (so the gateway could not have
   * created anything). Opening a tab must use this: a timeout usually means the tab exists and the
   * response was lost, so retrying creates a second tab whose id we never learn.
   */
  retry?: "always" | "connect-only";
}

const PREFLIGHT_TTL_MS = 60_000;

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
  private readonly fetchImpl: typeof globalThis.fetch;
  private preflightCache: GatewayStatus | undefined;
  private preflightAt = 0;
  /** tabId -> userId for every tab this client opened and has not yet closed. */
  private readonly liveTabs = new Map<string, string>();
  /** In-flight /tabs/open calls; an ambiguous failure may only sweep when this is empty. */
  private readonly pendingOpens = new Set<symbol>();

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  /** Tabs the client believes are still open, for leak assertions. */
  openTabCount(): number {
    return this.liveTabs.size;
  }

  /** Cheap liveness check, cached for 60s so a dead gateway costs one failure per window. */
  async preflight(signal?: AbortSignal): Promise<GatewayStatus> {
    const now = Date.now();
    if (this.preflightCache && now - this.preflightAt < PREFLIGHT_TTL_MS) return this.preflightCache;

    const status = await this.requestJson<Record<string, unknown>>("GET", endpointPath("status"), {
      signal,
    });
    const result: GatewayStatus = {
      ok: status.ok === true,
      enabled: typeof status.enabled === "boolean" ? status.enabled : undefined,
      engine: typeof status.engine === "string" ? status.engine : undefined,
      browserRunning: typeof status.browserRunning === "boolean" ? status.browserRunning : undefined,
      checkedAt: now,
    };
    this.preflightCache = result;
    this.preflightAt = now;
    return result;
  }

  async openTab(params: { userId: string; url: string; signal?: AbortSignal }): Promise<OpenTabResult> {
    if (!/^https?:\/\//i.test(params.url)) {
      throw new GatewayError("blocked_url", `can only open http(s) URLs in a browser tab (got "${params.url}")`);
    }
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
    return {
      tabId,
      targetId: typeof body.targetId === "string" ? body.targetId : undefined,
      url: typeof body.url === "string" ? body.url : params.url,
      title: typeof body.title === "string" ? body.title : undefined,
    };
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
    return {
      url: typeof body.url === "string" ? body.url : "",
      text,
      refsCount: typeof body.refsCount === "number" ? body.refsCount : (text.match(/\[e\d+\]/gu) ?? []).length,
      truncated: body.truncated === true,
      totalChars,
      hasMore: body.hasMore === true,
      nextOffset,
    };
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
        const gatewayError = error instanceof GatewayError ? error : new GatewayError("gateway_error", String(error));
        const connectOnly = options.retry === "connect-only" && gatewayError.code !== "gateway_unreachable";
        if (attempt === 0 && gatewayError.retryable && !connectOnly && !options.signal?.aborted) {
          lastError = gatewayError;
          continue;
        }
        throw gatewayError;
      }
    }
    throw lastError ?? new GatewayError("gateway_error", `request to ${path} failed`);
  }

  private async perform<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const callerSignal = options.signal;
    const onAbort = () => controller.abort(callerSignal?.aborted ? "caller" : "timeout");
    if (callerSignal) {
      if (callerSignal.aborted) onAbort();
      else callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("timeout");
    }, this.timeoutMs);

    try {
      if (controller.signal.aborted) {
        throw this.abortError(callerSignal);
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
        () => this.abortError(callerSignal),
      );
      if (controller.signal.aborted) throw this.abortError(callerSignal);

      const body = await this.readBody(response);

      if (!response.ok) {
        if (options.tolerateMissing && response.status === 404) return {} as T;
        throw this.httpError(response, body, path, options);
      }
      if (body && typeof body === "object" && (body as Record<string, unknown>).ok === false) {
        throw this.gatewayBodyError(body as Record<string, unknown>, path);
      }
      if (body === undefined) {
        throw new GatewayError("gateway_error", `gateway returned no body for ${method} ${path}`);
      }
      return body as T;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if ((error as { name?: string })?.name === "AbortError") throw this.abortError(callerSignal);
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

  private abortError(signal?: AbortSignal): GatewayError {
    if (signal?.aborted) {
      // A deadline that aborts on its own behalf keeps its own code; a cancelled tool call gets the
      // plain `aborted`.
      if (signal.reason instanceof GatewayError) return signal.reason;
      return new GatewayError("aborted", "the tool call was cancelled before the gateway request completed");
    }
    return new GatewayError("timeout", `gateway did not respond within ${this.timeoutMs}ms`, { retryable: true });
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
      return new GatewayError("gateway_error", `gateway has no route ${path}: ${message}`, { details });
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
