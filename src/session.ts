/**
 * Gateway session naming.
 *
 * The gateway namespaces tabs by `userId`. If two pi sessions used the same id they would fight over
 * tabs, so it is derived from the pi session id rather than chosen once per process.
 */

import { createHash } from "node:crypto";

import { GatewayError } from "./errors.ts";

const PREFIX = "pi";
/** Hex digits of the whole id kept on the overflow path. 64 bits of digest, so a shared head cannot share a namespace. */
const OVERFLOW_DIGEST_CHARS = 16;
/** The gateway caps a `userId`, so the whole id — prefix, head, and digest — is held to this width. */
const MAX_USER_ID_CHARS = 128;

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
  // Truncating the tail is what let two ids agreeing on the first 125 characters share one namespace,
  // which is the thing this derivation exists to prevent. So an overflow keeps a head for legibility and
  // trades the discarded tail for a digest of the whole id: stable, still capped, and still separating.
  const full = `${PREFIX}-${sanitized}`;
  if (full.length <= MAX_USER_ID_CHARS) return full;

  const digest = createHash("sha256").update(sanitized).digest("hex").slice(0, OVERFLOW_DIGEST_CHARS);
  const headWidth = MAX_USER_ID_CHARS - PREFIX.length - 1 - 1 - OVERFLOW_DIGEST_CHARS;
  return `${PREFIX}-${sanitized.slice(0, headWidth)}-${digest}`;
}
