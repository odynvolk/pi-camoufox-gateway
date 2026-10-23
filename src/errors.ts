/**
 * Error taxonomy shared by every layer that talks to the gateway.
 *
 * The code is the contract the model acts on: `consent_wall` and `empty_results` need different
 * follow-up behaviour, so collapsing them into "search failed" would make the tool useless in
 * practice.
 */

export type GatewayErrorCode =
  /**
   * Our own plumbing failed — an invariant we hold, not a fault the gateway reported.
   *
   * Every gateway-boundary failure is classified where it is caught, so by the time an error reaches
   * the tool boundary an unclassified one cannot be the gateway's doing. Labelling it `gateway_error`
   * sends the reader to check a service that is fine.
   */
  | "internal_error"
  | "config_error"
  | "gateway_unreachable"
  | "gateway_unauthorized"
  | "gateway_error"
  | "timeout"
  | "aborted"
  | "tab_not_found"
  | "blocked_url"
  | "host_blocked"
  | "private_network"
  | "navigation_failed"
  | "destination_unreported"
  | "consent_wall"
  | "empty_results"
  | "empty_page"
  | "parse_error"
  | "extraction_empty"
  | "unsupported";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: GatewayErrorCode, message: string, options: { details?: Record<string, unknown>; retryable?: boolean } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** How much of a rejected value a refusal may carry. */
const PRINTED_ARG_MAX = 60;

/**
 * Print a rejected argument the way a caller needs to read it: `"1,000"` with its quotes, so the model
 * that sent it can see it sent a string.
 *
 * The length bound is the reason this is a function rather than an interpolation. A refusal is not
 * swallowed — it reaches the model as `content[0].text`, the same context window a ceiling guard exists
 * to protect — so echoing an arbitrary value back whole would be the defect with an error code on it.
 * The withheld length is still reported, so a clipped value stays identifiable.
 *
 * `JSON.stringify` alone would report `NaN` and `Infinity` as `null`, which is the other distinction a
 * reader tracing this must not lose. It also throws on a circular object and on a `BigInt`; neither is
 * reachable from a JSON tool call, and both would surface as `internal_error`, which is the honest code.
 */
export function describeArgument(value: unknown): string {
  const printed =
    typeof value === "number" && !Number.isFinite(value) ? String(value) : JSON.stringify(value) ?? String(value);
  const shown = printed.length > PRINTED_ARG_MAX ? `${printed.slice(0, PRINTED_ARG_MAX)}… (${printed.length} chars)` : printed;
  return `${shown} (${typeof value})`;
}
