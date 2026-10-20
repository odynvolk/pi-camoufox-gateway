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
    // Not "empty": an id of spaces, of separators, or of anything the sanitizer drops lands here too,
    // and a message saying "empty" sends the reader looking for a missing id rather than a unusable one.
    // Bounded and JSON-quoted: this text reaches a transcript, and the input is arbitrary.
    const got = JSON.stringify(piSessionId.slice(0, 64));
    throw new GatewayError(
      "internal_error",
      `cannot derive a gateway session id: it reduces to nothing once sanitised (got ${got})`,
    );
  }
  // Truncating is what lets two ids agree on the first 125 characters share one namespace — recorded as
  // D.5 in `docs/improvements/2026-10-18-code.md`, and pinned by a test so changing it is a decision.
  return `${PREFIX}-${sanitized}`.slice(0, 128);
}
