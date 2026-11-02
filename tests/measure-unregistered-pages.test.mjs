/**
 * The G.6 instrument, tested as code.
 *
 * `scripts/measure-unregistered-pages.mjs` is what the two counts in
 * `docs/improvements/2026-10-18-code.md` → G.6 rest on, and a count nobody outside this repo can re-measure
 * is a claim rather than a measurement — the defect the recorded fixtures exist to close. So its parts are
 * asserted here, including the two readings the counts depend on: that a page the fake invents is recognised
 * as invented, and that a page the fake *ships* (its google SERP, its consent page) is not. The script's
 * entry point is guarded, so importing it here cannot spawn a suite from inside one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import {
  caseNames,
  classify,
  engineResultPrefixes,
  inventedPageText,
  KNOWN_CASE,
  pageAtIsInvented,
  pageWasInvented,
  parseReport,
  REPORT_FIXTURE,
  readRunSummary,
  suiteFailures,
  assertSawTheKnownCase,
  suiteTotal,
} from "../scripts/measure-unregistered-pages.mjs";

const BASE = "http://gateway.test:9377";
const UNREGISTERED = "https://duckduckgo.com/?q=camoufox";
const SHIPPED = ["https://www.google.com/search?q=camoufox", "https://consent.google.com/ml?continue=x"];
/** The two-case probe that answers "who does a late read belong to", run as its own test process below. */
const ATTRIBUTION_PROBE = "tests/helpers/invented-attribution.test.mjs";
const SCRIPT = fileURLToPath(new URL("../scripts/measure-unregistered-pages.mjs", import.meta.url));
const G6_DOC = fileURLToPath(new URL("../docs/improvements/2026-10-18-code.md", import.meta.url));

/**
 * The three figures the instrument prints, read out of one of its own headline lines.
 *
 * Read from the committed reading rather than re-measured here: re-running the suite from inside the suite is
 * how an instrument ends up measuring a different run than the one it published, and the point of this
 * assertion is that the *committed* artefacts agree with each other.
 */
function figures(line) {
  const found = line.match(/(cases in the suite|read the fake's invented page|read it as an engine's results page):\s+(\d+)(?: of (\d+))?/u);
  assert.ok(found, `"${line}" is not one of the instrument's three headline lines`);
  return {
    line,
    label: found[1],
    count: Number.parseInt(found[2], 10),
    of: found[3] === undefined ? undefined : Number.parseInt(found[3], 10),
  };
}

/**
 * Run the probe under the recorder, and hand back what the recorder said.
 *
 * A child process, not this one: the recorder is a preload, and installing it here would have the suite
 * measure itself. The probe prints which case sent its read and which one it landed in, so this returns the
 * recorder's own lines next to the probe's two markers.
 */
function runAttributionProbe() {
  const env = { ...process.env, NODE_ENV: "test", CAMOUFOX_MEASURE_INVENTED: "1" };
  // `node --test` refuses to run files when it is started inside another test file, printing a warning and
  // exiting 0 — a nested runner inherits this variable from the one running it. Taken out, the child is a
  // first-run runner again and reports what it saw.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ["--test", "--import", SCRIPT, ATTRIBUTION_PROBE],
    {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 60_000,
      env,
    },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `the probe has to pass before anything it printed is evidence:\n${output}`);
  return output;
}

/** The case the probe names for itself, so no case name is copied into this file. */
function marked(output, mark) {
  const line = output.split("\n").find((one) => one.startsWith(mark));
  assert.ok(line, `the probe printed no ${mark} line, so the two cases this rests on did not both run`);
  return line.slice(mark.length);
}

test("an invented page is recognised, and the pages the fake ships are not", async () => {
  // The count G.6 publishes is "how many cases read a page nobody registered". Three wrong answers were
  // measured on the way here: comparing against "what a fresh fake answers" also counted the google SERP and
  // the consent page the fake ships on purpose (35), comparing against the un-substituted article lost every
  // whole-page read (40), and caching the verdict per url gave one case's answer to another that had
  // registered that url (17). Each assertion below is one of those three.
  assert.equal(await pageWasInvented(UNREGISTERED, await inventedPageText(UNREGISTERED)), true);

  for (const url of SHIPPED) {
    assert.equal(await pageWasInvented(url, await inventedPageText(url)), false, `${url} is the fake's own page`);
    assert.equal(await pageAtIsInvented(url), false, `${url} is served without anyone registering it`);
  }
  assert.equal(await pageAtIsInvented(UNREGISTERED), true);

  // A slice of the invention is still the invention — `/snapshot` paginates and `read` re-looks at an offset.
  const whole = await inventedPageText(UNREGISTERED);
  assert.equal(await pageWasInvented(UNREGISTERED, whole.slice(whole.indexOf("- link"))), true);

  // And these are not the invention, however long they are.
  assert.equal(await pageWasInvented(UNREGISTERED, ""), false);
  assert.equal(await pageWasInvented(UNREGISTERED, "x".repeat(500)), false);
  assert.equal(await pageWasInvented("", whole), false);
});

test("a page a case registered is not counted as one the fake invented", async (t) => {
  // The same url is the fake's invention in one case and this case's own page here. An instrument that
  // decides per url gets this wrong, and gets it wrong in the direction that hides the hole.
  const registered = "https://duckduckgo.com/?q=camoufox";
  const mine = `- heading "Mine" [level=1]\n${"x".repeat(400)}`;
  const fake = withFakeGateway(t, { pageContents: new Map([[registered, mine]]) });
  const client = createGatewayClient({ baseUrl: BASE, timeoutMs: 1000 });
  const tab = await client.openTab({ userId: "u1", url: registered });
  const page = await client.snapshot({ userId: "u1", tabId: tab.tabId });
  await client.closeTabQuietly({ userId: "u1", tabId: tab.tabId });

  assert.equal(page.text.includes("Mine"), true, "this case's own page is the one that came back");
  assert.equal(await pageWasInvented(registered, page.text), false);
  assert.equal(await pageWasInvented(registered, await inventedPageText(registered)), true, "the url alone decides nothing");
  assert.equal(fake.state.calls.some((call) => call.path === "/tabs/open"), true, "and it really went through the fake");
});

test("a read that lands after its own case ended is still credited to the case that sent it", () => {
  // The recorder takes the case name from a root `beforeEach`, and a response that arrives late — a gateway
  // still rendering long after the client gave up on it, which the hung-snapshot case in
  // `tests/engines.test.mjs` → `a gateway that hangs on both engines comes back inside the chain budget, not four deadlines`
  // is today — would otherwise be written down against whichever case was running when it finally resolved.
  // That charges a read to a case which asserts it opened nothing, and inflates the published count with a
  // case that read nothing. The probe is two cases: one fires a `/snapshot` it never waits for, the other
  // waits for it.
  const output = runAttributionProbe();
  const issued = marked(output, "PROBE-ISSUED\t");
  const settledDuring = marked(output, "PROBE-SETTLED-DURING\t");

  // The probe is only worth running if those really were two different cases.
  assert.notEqual(settledDuring, issued, "the read landed inside the case that sent it, so it tests nothing");

  const records = parseReport(output);
  assert.deepEqual(
    records.map((one) => one.name),
    [issued],
    `exactly one case read the invented page — the one that sent the request, not ${settledDuring} that merely waited for it`,
  );
  assert.equal(records[0].file.endsWith(ATTRIBUTION_PROBE), true, `recorded against ${records[0].file}`);
  assert.deepEqual(records[0].urls, [UNREGISTERED], "and it was the page nobody registered");
});

test("everywhere the G.6 count is stated states the reading the instrument committed", () => {
  // The instrument prints two counts, the doc quotes them in a fenced block, and this script's own header
  // restates them in prose. Until now none of the three was pinned to anything: the doc said 47 while the
  // script's comment said 48, and no test in this file asserted a count at all, so either could drift and the
  // suite would say nothing. There is no CI to notice. So the script writes what it measured to
  // `tests/fixtures/measure/invented-page-count.txt` and every place that repeats the figure is held to it.
  const committed = readFileSync(REPORT_FIXTURE, "utf8").replace(/\n+$/u, "").split("\n");
  const headline = committed.slice(0, 3);
  const [suite, invented, asResults] = headline.map(figures);

  // The reading has to be one reading: "11 of 384" under a total of 385 is two runs wearing one hat.
  assert.equal(invented.of, suite.count, `the invented-page count is quoted against ${invented.of}, not the ${suite.count} cases measured`);
  assert.equal(asResults.of, suite.count, `the results-page count is quoted against ${asResults.of}, not the ${suite.count} cases measured`);
  assert.ok(suite.count > 0 && invented.count > 0, "a zero here is a broken instrument, not a closed hole");
  const doc = readFileSync(G6_DOC, "utf8");
  assert.deepEqual(
    fencedBlockStartingWith(doc, "cases in the suite:"),
    headline,
    "the block in G.6 is no longer the reading the instrument committed — re-run it and copy what it prints",
  );

  const stated = readFileSync(SCRIPT, "utf8").match(
    /of (\d+)\n? \* cases in the suite, (\d+) read the fake's invented page and (\d+) read it as an engine's results page/u,
  );
  assert.ok(
    stated,
    "the script no longer states its own reading in the sentence this asserts against — say the three figures in its header, or move this assertion to wherever you said them",
  );
  assert.deepEqual(
    stated.slice(1).map((one) => Number.parseInt(one, 10)),
    [suite.count, invented.count, asResults.count],
    "the script's header and the committed reading are two different measurements of the same suite",
  );
});

/** One fenced block in a doc whose first line begins with `anchor`, and only one. */
function fencedBlockStartingWith(doc, anchor) {
  const blocks = [];
  let open;
  for (const line of doc.split("\n")) {
    if (line.trim() === "```") {
      if (open) blocks.push(open);
      open = open ? undefined : [];
      continue;
    }
    if (open) open.push(line);
  }
  const found = blocks.filter((one) => one[0]?.startsWith(anchor));
  assert.equal(found.length, 1, `expected exactly one fenced block starting "${anchor}" in the doc, found ${found.length}`);
  return found[0];
}

test("the run is read back case by case, reporter noise and all", () => {
  const cases = parseReport([
    "✔ some test (1.0ms)",
    `INVENTED-PAGE\ttests/engines.test.mjs\tsearches\t${UNREGISTERED} https://duckduckgo.com/?q=late`,
    "ℹ tests 3",
    `INVENTED-PAGE\ttests/engines.test.mjs\tsearches\t${UNREGISTERED}`,
    `INVENTED-PAGE\ttests/search-tool.test.mjs\tsearches\t${UNREGISTERED}`,
  ].join("\n"));

  assert.equal(cases.length, 3, "one line per fake, so a case installing two appears twice");
  assert.deepEqual(cases[0].urls, [UNREGISTERED, "https://duckduckgo.com/?q=late"]);
  assert.equal(caseNames(cases).length, 2, "but the count is cases, not fakes — same name, two files, two cases");
  assert.equal(suiteTotal("…\nℹ tests 0\nℹ tests 384\n"), 384, "the suite's total, not a stray summary of zero");
  assert.equal(suiteTotal("nothing at all"), 0, "and no summary at all is 0, which the caller refuses to publish");
});

test("a run is only published if the runner survived it, and the worst failure count is the one believed", () => {
  // Both of these were the shape that lets a broken instrument look like a good one. Reading the *first*
  // `ℹ fail` line meant any stray summary before the suite's could report "384, all passing" over a run that
  // had failures; and not asking the exit status meant a runner that died — a preload that could not be found
  // at a relative `--import`, say — was indistinguishable from a suite that printed no summary.
  assert.equal(suiteFailures("…\nℹ fail 0\nℹ fail 3\n"), 3, "the highest seen, not the first seen");
  assert.equal(suiteFailures("nothing at all"), 0, "and no failure line anywhere is 0, not NaN");

  assert.deepEqual(readRunSummary("ℹ tests 385\nℹ fail 0\n", 0), { total: 385, failed: 0 });
  assert.deepEqual(
    readRunSummary("ℹ tests 385\nℹ fail 0\nℹ fail 2\n", 0).failed,
    2,
    "the headline cannot say all passing while a summary says otherwise",
  );
  assert.throws(() => readRunSummary("nothing at all", 0), /produced no summary/u);
  assert.throws(
    () => readRunSummary("Cannot find module '/nowhere/fetch_guard.mjs'", 1),
    /exited with status 1/u,
    "a runner that died is a broken instrument, not a suite with nothing in it",
  );
});

test("a page is attributed to the engine whose results url it is, and to no other", async () => {
  const prefixes = await engineResultPrefixes();
  assert.deepEqual(
    [...prefixes.entries()].map(([engine, prefix]) => `${engine} ${prefix}`),
    ["google https://www.google.com/search?q=", "duckduckgo https://duckduckgo.com/?q="],
    "derived by running the shipped adapters, so an engine moving its url moves this assertion with it",
  );

  const { asResults } = classify(
    [
      { file: "a", name: "reads a document", urls: ["https://example.test/article"] },
      { file: "a", name: "searches", urls: [UNREGISTERED] },
      { file: "a", name: "searches", urls: [UNREGISTERED] },
    ],
    prefixes,
  );
  assert.deepEqual(asResults, [{ file: "a", name: "searches", engine: "duckduckgo", url: UNREGISTERED }]);
});

test("a run that missed the case it must see is refused, not published as zero", async () => {
  // Zero and "closed" look identical in the output and only one of them is a finding. The case named here
  // opens the engine's own query page through the fake, registers nothing, and asserts `results.length > 0`,
  // so any recorder that works sees it — that is the reading this guard rests on, and the reason a silent 0
  // cannot be reported as good news.
  const prefixes = await engineResultPrefixes();
  const seen = [{ file: "tests/engines.test.mjs", name: KNOWN_CASE, urls: ["https://duckduckgo.com/?q=camoufox%20anti-detect"] }];
  assert.doesNotThrow(() => assertSawTheKnownCase(seen, classify(seen, prefixes).asResults));

  assert.throws(() => assertSawTheKnownCase([], []), /the recorder saw nothing/u);
  const elsewhere = [{ file: "x", name: KNOWN_CASE, urls: ["https://example.test/not-a-serp"] }];
  assert.throws(
    () => assertSawTheKnownCase(elsewhere, classify(elsewhere, prefixes).asResults),
    /matched no engine's results url/u,
  );
});
