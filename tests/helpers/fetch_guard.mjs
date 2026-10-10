/**
 * Blocks accidental live traffic from the test suite.
 *
 * Every gateway-touching test installs the fake via withFakeGateway(). This module makes the
 * failure mode loud: forget the stub and you get a named error instead of a real request to the LAN.
 */

const original = globalThis.fetch;

globalThis.fetch = async function blockedFetch(url, init) {
  const target = String(url);
  const detail = init?.method ? ` (${init.method})` : "";
  throw new Error(
    `BLOCKED live request from tests: ${target}${detail}. ` +
      "Install withFakeGateway(t) from tests/helpers/fake_gateway.mjs for this test.",
  );
};

export const restoreFetch = () => {
  globalThis.fetch = original;
};
