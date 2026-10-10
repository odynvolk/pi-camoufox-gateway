/**
 * Error taxonomy shared by every layer that talks to the gateway.
 *
 * The code is the contract the model acts on: `consent_wall` and `empty_results` need different
 * follow-up behaviour, so collapsing them into "search failed" would make the tool useless in
 * practice.
 */

export type GatewayErrorCode =
  | "config_error"
  | "gateway_unreachable"
  | "gateway_unauthorized"
  | "gateway_error"
  | "timeout"
  | "aborted"
  | "tab_not_found"
  | "blocked_url"
  | "host_blocked"
  | "navigation_failed"
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
