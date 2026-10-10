/**
 * Tab-leak invariant.
 *
 * Registered with node:test's file-level `after()` hook, which runs *after* every per-test
 * `t.after` — so a production path that fails to close its own tab is caught here, and a test's own
 * cleanup gets its normal chance first.
 */

import { after } from "node:test";

const tracked = new Set();

/** Called by withFakeGateway for every fake created by a test. */
export function trackTabLeaks(fake) {
  tracked.add(fake);
}

after(() => {
  const leaked = [...tracked].flatMap((fake) => fake.liveTabs());
  tracked.clear();
  if (leaked.length > 0) {
    throw new Error(
      `tab leak: ${leaked.length} tab(s) still open when the file finished: ${JSON.stringify(leaked)}`,
    );
  }
});
