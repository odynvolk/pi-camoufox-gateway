/**
 * Gateway session naming.
 *
 * The gateway namespaces tabs by `userId`. If two pi sessions used the same id they would fight over
 * tabs, so it is derived from the pi session id rather than chosen once per process.
 */

import { GatewayError } from "./errors.ts";

const PREFIX = "pi";

export function gatewaySessionId(piSessionId: string): string {
  const sanitized = piSessionId.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!sanitized) {
    // Raised here, not left as a plain `Error` for the tool boundary to label: this is a failed
    // invariant of ours, and it must not arrive looking like a gateway outage.
    throw new GatewayError("internal_error", "cannot derive a gateway session id from an empty pi session id");
  }
  return `${PREFIX}-${sanitized}`.slice(0, 128);
}
