/**
 * What we believe about the gateway, and for how long we keep saying it.
 *
 * Extracted from `GatewayClient`, where it was four fields: a value and a timestamp for good news,
 * another pair for bad. "We are not simultaneously up and down" is the whole invariant, and the only
 * thing enforcing it was each branch remembering to write the other one — which is how a gateway that
 * was down got answered "up" once per retry window, for as long as the process lived. One value with
 * two shapes cannot hold both, so that mistake has no representation left here.
 *
 * The transport stays where it belongs: this takes a thunk and an outcome, and never learns what a
 * `GET /` looks like.
 */

import { GatewayError } from "./errors.ts";

/** How long a *successful* probe is worth answering with. */
export const DEFAULT_TTL_MS = 60_000;

/**
 * How long a *failed* one is honoured. Short against the success window on purpose — holding a failure
 * for the whole of it would turn one transient blip into that entire window of refusals. Long against a
 * probe's own deadline, for the opposite reason: the window has to outlast the probe it is promising
 * anything about, or a slow failure is written down already expired.
 */
export const DEFAULT_RETRY_AFTER_MS = 5_000;

/** What we know, in exactly one of the two shapes a gateway can leave you with. */
type Known<T> = { kind: "up"; value: T; at: number } | { kind: "down"; error: GatewayError; at: number };

export interface LivenessCacheOptions {
  ttlMs?: number;
  retryAfterMs?: number;
}

export class LivenessCache<T> {
  private readonly ttlMs: number;
  private readonly retryAfterMs: number;
  private known: Known<T> | undefined;
  /** One blocking probe, so concurrent callers of a dead gateway share it instead of each dialling. */
  private inflight: Promise<T> | undefined;
  /**
   * A refresh running behind a caller it is no longer answering.
   *
   * Its own field, not another shape of `inflight`: nothing awaits it and it never rejects.
   */
  private revalidating: Promise<void> | undefined;

  constructor(options: LivenessCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  }

  /**
   * Answer this call, dialling only when there is nothing to answer with.
   *
   * A success is answered with for `ttlMs`, and refreshed behind the call once that has passed, so the
   * first call of a window pays nothing for a gateway that is simply up. A failure is re-thrown without
   * dialling for `retryAfterMs`, so a burst of calls behind one dead gateway pays one probe rather than
   * one timeout each — and a gateway that blips once is not written off for the whole success window.
   *
   * The trade is named rather than buried: a gateway that dies inside a success window is discovered by
   * the call that straddles it, from its own request rather than from a probe, because the stale value
   * answered first. Refusals resume from the call after that refresh lands, and stay resumed — a probe
   * that fails replaces the success it invalidated, so there is no older answer to fall back to.
   */
  async resolve(fetchValue: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const now = Date.now();
    const known = this.known;
    if (known?.kind === "up" && now - known.at < this.ttlMs) return known.value;
    if (known?.kind === "down" && now - known.at < this.retryAfterMs) throw known.error;

    // Past the window, an answer we have beats an answer we are about to be late with — and the only one
    // that can still reach here is an up, since a probe that fails replaces it with a down.
    if (known?.kind === "up") {
      this.startRefresh(fetchValue);
      return known.value;
    }

    // One probe serves the window *and* its concurrent callers: raced to a dead gateway, N callers would
    // otherwise each dial and each wait out their own timeout. Two consequences of sharing, both
    // accepted: the probe is bound to the first caller's signal, so it cannot be cancelled by a later
    // caller, and a later caller that cancels itself is not released early either — it waits out the
    // shared probe, bounded by the retry budget. The alternative to sharing is N connections that all
    // have to fail anyway.
    this.inflight ??= this.record(fetchValue, signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Re-dial without making a caller wait for it, one at a time.
   *
   * Callers arriving at an expired window all see the same stale value, and all of them are served by
   * the single refresh the first of them started. Deliberately dials with no caller's signal — that is
   * the whole reason the signal is threaded into `record` rather than closed over by the thunk: this
   * refresh is for the calls *after* the one that triggered it, and cancelling it because that caller
   * gave up would leave the next one re-dialling too. Nothing here can see it settle, so it must not be
   * able to throw.
   */
  private startRefresh(fetchValue: (signal?: AbortSignal) => Promise<T>): void {
    if (this.revalidating) return;
    this.revalidating = this.record(fetchValue, undefined)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.revalidating = undefined;
      });
  }

  /**
   * The only place `known` is written, and the only place either window is stamped.
   *
   * Both are stamped from the moment an outcome is *learned*, never from when the probe set off. A
   * failure that took longer than its own window would otherwise be written down already expired and
   * skipped by the very next call — and a connect timeout is precisely the failure this path exists to
   * bound.
   */
  private async record(fetchValue: (signal?: AbortSignal) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    try {
      const value = await fetchValue(signal);
      this.known = { kind: "up", value, at: Date.now() };
      return value;
    } catch (error) {
      // Every way this can fail is equally futile to redial a millisecond later — except a cancel.
      // `aborted` is one caller's own decision, not evidence about the gateway, and a shared probe hands
      // it to everyone waiting on it: recording it would report "aborted" to callers who never asked to
      // cancel. Everything else replaces `known` outright, which is what keeps a superseded success from
      // being answered with.
      if (error instanceof GatewayError && error.code !== "aborted") {
        this.known = { kind: "down", error, at: Date.now() };
      }
      throw error;
    }
  }
}
