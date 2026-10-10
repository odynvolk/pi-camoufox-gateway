/**
 * Gateway session naming.
 *
 * The gateway namespaces tabs by `userId`. If two pi sessions used the same id they would fight over
 * tabs, so it is derived from the pi session id rather than chosen once per process.
 */

const PREFIX = "pi";

export function gatewaySessionId(piSessionId: string): string {
  const sanitized = piSessionId.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!sanitized) {
    throw new Error("cannot derive a gateway session id from an empty pi session id");
  }
  return `${PREFIX}-${sanitized}`.slice(0, 128);
}
