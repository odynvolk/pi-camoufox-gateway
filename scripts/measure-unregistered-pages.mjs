#!/usr/bin/env node
/**
 * Count which cases read the fake gateway's invented page. G.6's numbers, re-measurable.
 *
 * `tests/helpers/fake_gateway.mjs` answers any url a test did not register with an invented article whose
 * one link sits on a host no engine owns — so it parses as an organic result under either engine label, and
 * a search whose engine never navigated still returns a result (`docs/improvements/2026-10-18-code.md` →
 * G.6). Two counts are quoted there, and a count nobody outside this repo can re-measure is a claim, not a
 * measurement. This is the instrument. Like `scripts/record-fixtures.py` it never runs from `npm test`.
 *
 * Run:  node scripts/measure-unregistered-pages.mjs
 *
 * Today's reading, written to `tests/fixtures/measure/invented-page-count.txt` every time it runs: of 387
 * cases in the suite, 47 read the fake's invented page and 11 read it as an engine's results page. Those
 * three figures are restated in this comment, in that file, and in
 * `docs/improvements/2026-10-18-code.md` → G.6, and `tests/measure-unregistered-pages.test.mjs` refuses the
 * three once they disagree — a count with nothing under it is a claim, and a claim three files each keep by
 * hand is three claims.
 *
 * It drives the fake only — no gateway, no network, nothing from the environment printed — and it changes
 * nothing in order to observe: the suite runs exactly as `npm test` runs it, and the recording happens in a
 * preload this same file installs into each test process. Nothing was added to the shared fake, so the
 * fixture every test builds on is not asked to carry a measurement of someone else's problem.
 *
 * Two rules the measurement refuses to copy, which is the whole design:
 * - *Which pages are invented* is answered by the unmodified fake, which owns that decision.
 * - *Which urls are an engine's results page* is read off the shipped adapters by running them, so an engine
 *   moving its search url moves this measurement with it instead of leaving it matching the old one.
 */

import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { createGatewayClient } from "../src/gateway.ts";
import { googleEngine } from "../src/engines/google.ts";
import { duckduckgoEngine } from "../src/engines/duckduckgo.ts";

const BASE = "http://gateway.measure.test:9377";
/** The switch that turns this file into a preload; only the child test processes get it. */
const MEASURE_ENV = "CAMOUFOX_MEASURE_INVENTED";
/** One line per case that read an invented page: `INVENTED-PAGE\t<file>\t<test>\t<url url …>`. */
export const REPORT_PREFIX = "INVENTED-PAGE\t";
/** A query nothing else asks for, so the prefix cut below cannot land inside a real one. */
const PROBE_QUERY = "__measure-probe__";
/** A url nothing registers and no engine opens at, so the fake can only invent an answer for it. */
const INVENTION_PROBE = "https://invention-probe.invalid/a-page-no-test-registered";
/** Below this a "piece of the invention" is a coincidence; the article itself is ~2.5k characters. */
const MIN_INVENTED_PAGE_CHARS = 200;
/** The case that proves the recorder is running: see `assertSawTheKnownCase`. */
export const KNOWN_CASE = "duckduckgo navigates straight to its query url";
/**
 * Where the reading is committed, so the figure in the doc and the one in this file's header have something
 * to be checked against. In a directory of its own because two other tests sweep `tests/fixtures/` as though
 * every `.txt` there were a recorded page — which this is not.
 */
export const REPORT_FIXTURE = resolve(import.meta.dirname, "../tests/fixtures/measure/invented-page-count.txt");

let article; // what an untouched fake invents for INVENTION_PROBE, asked once per process

/**
 * Was this file the script that was run, rather than a preload inside one?
 *
 * Resolved with `realpathSync` on both sides, for the reason `scripts/diagnose-wall.mjs` records: Node
 * realpaths a module's own url and leaves `argv[1]` as typed, so `/tmp` and `/private/tmp` are two paths.
 */
export function isEntryScript(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

/**
 * What an untouched fake answers for this url, asked of the helper rather than restated here — the fake owns
 * which urls it invents a page for, and a second copy of that rule would be free to disagree with it.
 */
export async function inventedPageText(url) {
  const { createFakeGateway } = await import("../tests/helpers/fake_gateway.mjs");
  const fake = createFakeGateway();
  const opened = await fake
    .fetch(`${BASE}/tabs/open`, { method: "POST", body: JSON.stringify({ userId: "measure", url }) })
    .then((response) => response.json());
  const page = await fake
    .fetch(`${BASE}/tabs/${opened.tabId}/snapshot?userId=measure`)
    .then((response) => response.json());
  return typeof page?.snapshot === "string" ? page.snapshot : null;
}

/** The article the fake invents for this url, or null when it cannot say. */
async function inventionForUrl(url) {
  article ??= inventedPageText(INVENTION_PROBE);
  const template = await article;
  return template === null ? null : template.split(INVENTION_PROBE).join(url);
}

/**
 * Did the fake invent this page, or did someone put it there?
 *
 * The text has to be a piece of the article the fake invents *for this url* — a whole one, or one page of
 * one, since `/snapshot` paginates and `read` re-looks at an offset. Three shortcuts were tried and each
 * reported a different wrong number: "what a fresh fake answers for this url" also accepts the google SERP
 * and the consent page the fake ships on purpose (35), comparing against the un-substituted article loses
 * every whole-page read (40, against the figure pinned in the header), and memoising the verdict per url hands
 * one case's verdict to the next case that registered that same url (17, also against the figure pinned above).
 */
export async function pageWasInvented(url, text) {
  if (!isText(url) || !isText(text)) return false;
  const invention = await inventionForUrl(url);
  return invention !== null && text.length >= MIN_INVENTED_PAGE_CHARS && invention.includes(text);
}

/**
 * Was the page at this url an invention? For `/links` and `/extract`, which hand back something derived from
 * the page rather than the page, so there is no text to compare. Still asked of the fake, never of a rule
 * copied from it.
 */
export async function pageAtIsInvented(url) {
  if (!isText(url)) return false;
  const [invention, served] = await Promise.all([inventionForUrl(url), inventedPageText(url)]);
  return invention !== null && served === invention;
}

const isText = (value) => typeof value === "string" && value !== "";

/**
 * Record, inside each test process, which case read a page the fake invented.
 *
 * A root `beforeEach` yields the case name and a property setter wraps whatever fetch a test installs, which
 * is how the observation reaches the responses while the fake stays exactly as it is. Lines go to stderr so
 * they cannot be read as reporter output. `node:test` and the helper are imported here rather than at the
 * top: the parent process must stay out of both, or node prints a summary for a suite of zero.
 */
export async function installRecorder() {
  const { beforeEach } = await import("node:test");
  const byCase = new Map();
  const tabUrls = new Map(); // so a snapshot that will not name its destination can still be placed
  let current = "(unnamed)";

  beforeEach(function () {
    current = this?.name ?? "(unnamed)";
  });

  /** The fake's responses are plain objects whose `json()` reads again, so the body is never consumed. */
  const peek = async (response) =>
    (await (response.clone ? response.clone().json() : response.json()).catch(() => null));

  const observe = (fetch) => async (requestUrl, init = {}) => {
    // The case that *sent* this, taken before the first await. `current` belongs to the root `beforeEach`
    // and is rewritten by the next case, so a response that lands after its own caller stopped waiting — the
    // hung `/snapshot` of `tests/engines.test.mjs` → `a gateway that hangs on both engines comes back inside the chain budget, not four deadlines`
    // is one, held for 6 s while the client gives up at its deadline — would otherwise be recorded against
    // whichever case happened to be running when it finally resolved. Keying on the sender is what keeps a
    // case that opens nothing from being charged with someone else's read.
    const issuer = current;
    const response = await fetch(requestUrl, init);
    const path = new URL(String(requestUrl)).pathname;
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "POST" && path === "/tabs/open") {
      const opened = await peek(response);
      if (isText(opened?.tabId) && isText(opened?.url)) tabUrls.set(opened.tabId, opened.url);
      return response;
    }

    // Only a read is evidence: `/snapshot` for the page itself, `/links` and `/extract` for what was taken
    // from it. `/snapshot` is the request the client sends as a GET, and `method` is always set — defaulting
    // it is what made the first version of this record nothing at all.
    const read = method === "GET" && path.endsWith("/snapshot") ? "snapshot"
      : method === "GET" && path.endsWith("/links") ? "links"
        : method === "POST" && path.endsWith("/extract") ? "extract"
          : null;
    if (read === null) return response;

    const page = await peek(response);
    const url = isText(page?.url) ? page.url : tabUrls.get(path.split("/")[2]);
    const invented = read === "snapshot"
      ? await pageWasInvented(url, page?.snapshot)
      : await pageAtIsInvented(url);
    if (invented) {
      const key = `${process.argv[1] ?? "?"}\t${issuer}`;
      if (!byCase.has(key)) byCase.set(key, new Set());
      byCase.get(key).add(url);
    }
    return response;
  };

  let installed = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    get: () => installed,
    set: (fetch) => {
      installed = observe(fetch);
    },
  });

  process.on("beforeExit", () => {
    for (const [key, urls] of byCase) console.error(`${REPORT_PREFIX}${key}\t${[...urls].join(" ")}`);
  });
}

/**
 * Where each shipped engine asks to go, as a url prefix.
 *
 * Derived by running the adapter, not by copying its constant: a prefix pasted here would keep matching
 * after the engine moved, and a measurement that matches the old url while the engine serves a new one
 * reports the hole as closed. The fetch stub is this script's own so the adapters are asked, not the fake.
 */
export async function engineResultPrefixes() {
  const prefixes = new Map();
  const encodedProbe = encodeURIComponent(PROBE_QUERY);
  for (const engine of [googleEngine(), duckduckgoEngine()]) {
    const opened = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (init.method === "POST") opened.push(body.url);
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true, tabId: "probe", targetId: "probe", url: body.url, snapshot: "", totalChars: 0 }),
        text: async () => "{}",
      };
    };
    const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 1000 });
    try {
      await engine.search(PROBE_QUERY, { client, userId: "measure" });
    } catch {
      // Whatever it makes of the empty page it was handed is beside the point: only the request it made is
      // evidence here, and that request happens before anything can fail.
    } finally {
      globalThis.fetch = original;
    }
    const at = (opened[0] ?? "").indexOf(encodedProbe);
    if (at > 0) prefixes.set(engine.name, opened[0].slice(0, at));
  }
  return prefixes;
}

/** Reported lines, one per case: `{ file, name, urls }`. Reporter noise is ignored. */
export function parseReport(output) {
  const cases = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    const [file = "", name = "", urls = ""] = line.slice(REPORT_PREFIX.length).split("\t");
    if (name) cases.push({ file, name, urls: urls.split(" ").filter(Boolean) });
  }
  return cases;
}

/** Distinct cases among reported lines — a case is a test, not a fake, and one test may install two. */
export function caseNames(cases) {
  return [...new Set(cases.map((one) => `${one.file}\u0000${one.name}`))];
}

/**
 * `ℹ tests 379` from the reporter: the highest seen, so a stray summary of zero from anywhere in the run
 * can never be read as the suite's total.
 */
export function suiteTotal(output) {
  const counts = [...output.matchAll(/ℹ tests (\d+)/gu)].map((match) => Number.parseInt(match[1], 10));
  return counts.length > 0 ? Math.max(...counts) : 0;
}

/**
 * `ℹ fail 2` from the reporter, the highest seen — the same reason as above.
 *
 * Taking the *first* match instead was the bug: a stray summary of zero from anywhere before the suite's own
 * would have been read as "nothing failed", and the headline still printed *all passing* over a red run.
 */
export function suiteFailures(output) {
  const counts = [...output.matchAll(/ℹ fail (\d+)/gu)].map((match) => Number.parseInt(match[1], 10));
  return counts.length > 0 ? Math.max(...counts) : 0;
}

/**
 * The run's two headline numbers, or a refusal.
 *
 * A runner that died — a bad flag, a preload that threw, a suite not found at the path given — says nothing
 * at all, which looks exactly like a suite that failed to print a summary line. Telling them apart needs the
 * exit status, so the caller hands it over and a death is thrown on instead of published.
 */
export function readRunSummary(output, status) {
  const total = suiteTotal(output);
  if (total === 0) {
    throw new Error(
      status === 0
        ? "the suite produced no summary, so these counts would be meaningless"
        : `the test runner exited with status ${status} and produced no summary — nothing was measured`,
    );
  }
  return { total, failed: suiteFailures(output) };
}

/** The cases that read an invented page *as an engine's results page* — the ones G.6 is about. */
export function classify(cases, prefixes) {
  const asResults = [];
  const seen = new Set();
  for (const one of cases) {
    for (const url of one.urls) {
      const key = `${one.file}\u0000${one.name}\u0000${url}`;
      if (seen.has(key)) continue;
      const owner = [...prefixes.entries()].find(([, prefix]) => url.startsWith(prefix));
      if (!owner) continue;
      seen.add(key);
      asResults.push({ file: one.file, name: one.name, engine: owner[0], url });
    }
  }
  return { asResults };
}

/**
 * A count of zero is a broken instrument, not a closed hole, so refuse it.
 *
 * `tests/engines.test.mjs` → `duckduckgo navigates straight to its query url` opens the engine's own query
 * page through the fake, registers nothing, and asserts `results.length > 0` — so a recorder that works
 * cannot miss it, and one that does must not be allowed to print 0 as the hole having been closed.
 */
export function assertSawTheKnownCase(cases, asResults) {
  if (!cases.some((one) => one.name === KNOWN_CASE)) {
    throw new Error(`no case reported an invented page, though "${KNOWN_CASE}" must — the recorder saw nothing`);
  }
  if (!asResults.some((one) => one.name === KNOWN_CASE)) {
    throw new Error(`"${KNOWN_CASE}" was recorded but matched no engine's results url — the prefixes are wrong`);
  }
}

export async function measure() {
  // Built from this file's own location, not from the working directory: the natural way to run this script is
  // by path from somewhere else, and a relative `--import` then resolves against that other cwd and is never
  // found. The failure it produced was a misleading one — "the suite produced no summary", which reads like a
  // broken recorder and is really a preload that was not there.
  const here = import.meta.dirname;
  const repoRoot = resolve(here, "..");
  const env = { ...process.env, NODE_ENV: "test", [MEASURE_ENV]: "1" };
  // A nested `node --test` inherits this from a runner already in progress and then refuses to run any file,
  // warning and exiting 0. Out, and the child runs the suite for real.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    [
      "--test",
      "--import",
      resolve(here, "../tests/helpers/fetch_guard.mjs"),
      "--import",
      join(here, "measure-unregistered-pages.mjs"),
      "tests/*.test.mjs",
    ],
    { encoding: "utf8", cwd: repoRoot, env },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const { total, failed } = readRunSummary(output, run.status);

  const cases = parseReport(output);
  const prefixes = await engineResultPrefixes();
  const { asResults } = classify(cases, prefixes);
  assertSawTheKnownCase(cases, asResults);

  // The three lines G.6 quotes, built once so what gets printed and what gets committed cannot disagree on
  // the figures. The pass/fail tail is print-only, on purpose: the one run in which these figures legitimately
  // move is a run whose only failure is the assertion reading the stale fixture, and a reading taken from a red
  // run must not become the reading anybody publishes. Whether the suite passes is `npm test`'s to say, and it
  // is said by being green — not by a word committed by a run that could not have been green.
  const published = [
    `cases in the suite:                   ${total}`,
    `read the fake's invented page:        ${caseNames(cases).length} of ${total}`,
    `read it as an engine's results page:  ${new Set(asResults.map((one) => one.name)).size} of ${total}`,
  ];
  const printed = [
    `${published[0]}${failed > 0 ? `  (${failed} FAILING — fix that before believing any of this)` : ", all passing"}`,
    ...published.slice(1),
  ];
  const detail = [];
  for (const [engine, prefix] of prefixes) {
    const hits = asResults.filter((one) => one.engine === engine);
    detail.push(`  ${engine.padEnd(11)} ${prefix}  ${hits.length} case(s)`);
    // Repo-relative, so the committed reading says the same thing on the machine that measured it as on the
    // one reading it back a month later.
    for (const hit of hits) detail.push(`      ${hit.name}\n        ${relative(repoRoot, hit.file)}  <${hit.url}>`);
  }
  for (const line of [...printed, ...detail]) console.log(line);

  // Committed alongside the number it produced: the doc and this file's own header both restate these
  // figures, and `tests/measure-unregistered-pages.test.mjs` holds all three to the one reading written here.
  mkdirSync(dirname(REPORT_FIXTURE), { recursive: true });
  writeFileSync(REPORT_FIXTURE, `${[...published, ...detail].join("\n")}\n`, "utf8");
  return { total, failed, cases, asResults, prefixes, printed, published, detail };
}

if (isEntryScript(process.argv[1], import.meta.url)) {
  await measure();
} else if (process.env[MEASURE_ENV] === "1") {
  await installRecorder();
}
