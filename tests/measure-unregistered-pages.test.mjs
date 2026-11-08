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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withFakeGateway } from "./helpers/fake_gateway.mjs";
import { createGatewayClient } from "../src/gateway.ts";
import {
  caseNames,
  CHECK_FLAG,
  classify,
  engineResultPrefixes,
  findDisagreements,
  HEADER_STATING,
  inventedPageText,
  pageAtIsInvented,
  pageWasInvented,
  parseProbeMarkers,
  parseReport,
  PLACES,
  PROBE_PREFIX,
  readDocFigures,
  readHeadlineFigures,
  readHeaderFigures,
  readRunSummary,
  requestedCheck,
  REPORT_FIXTURE,
  REPORT_PREFIX,
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

// The three cases below replace `a run that missed the case it must see is refused, not published as zero`,
// which asked for a case *named* `KNOWN_CASE` among the invented reads. U2 registers the page that case
// reads, so the name it gated on disappears with it — and what the name stood for (a recorder that can see
// a page, and can still tell an engine's results url when it sees one) gets asserted directly instead.

test("a published zero rests on the recorder's own probe, not on a case name", async () => {
  // Zero and "closed" look identical in the output and only one of them is a finding. The guard cannot rest
  // on which cases happen to read an invention any more — a published 0 is precisely a run where none do —
  // so it rests on the one read the recorder takes for itself: an unregistered page at an engine's own
  // results url, which the unmodified fake can only answer with its invention.
  const prefixes = await engineResultPrefixes();
  const engineUrl = `${prefixes.get("duckduckgo")}camoufox`;

  assert.doesNotThrow(
    () => assertSawTheKnownCase([{ file: "x", url: engineUrl, invented: true }], prefixes),
    "a recorder that saw its own probe may publish a run in which nothing read a results page",
  );
  assert.throws(
    () => assertSawTheKnownCase([], prefixes),
    /the recorder saw nothing/u,
    "a run with no probe read is a silence, and a silence cannot publish 0",
  );
  assert.throws(
    () => assertSawTheKnownCase([{ file: "x", url: "https://example.test/not-a-serp", invented: true }], prefixes),
    /matched no engine's results url/u,
    "a probe that never touched an engine's url proves the classification nothing",
  );
  assert.throws(
    () => assertSawTheKnownCase([{ file: "x", url: engineUrl, invented: false }], prefixes),
    /recognised none of it as an invention/u,
    "a recorder that cannot see the invention it was handed has stopped measuring, whatever it counts",
  );
});

test("the recorder's probe is flushed where no denominator can read it", () => {
  // The probe is the recorder grading itself, so it must never become a case. It sits on an engine's own
  // results url, and `classify` matches on the url alone: one line in the case stream and
  // `read it as an engine's results page` could never reach the 0 U2 is going to publish.
  const marker = `${PROBE_PREFIX}tests/x.test.mjs\thttps://duckduckgo.com/?q=rig\tinvented`;
  assert.deepEqual(parseProbeMarkers(`${marker}\n`), [
    { file: "tests/x.test.mjs", url: "https://duckduckgo.com/?q=rig", invented: true },
  ]);
  assert.deepEqual(parseReport(`${marker}\n`), [], "the probe line is not a case, and no count may be built from it");

  const caseLine = `${REPORT_PREFIX}tests/x.test.mjs\tsearches\thttps://duckduckgo.com/?q=rig`;
  assert.deepEqual(parseProbeMarkers(caseLine), [], "and a case line is not a probe, or the guard grades the suite instead of itself");
});

test("the two headline figures count different things, so one proof of life cannot grade both", async () => {
  // `read the fake's invented page` dedupes on file *and* name, `read it as an engine's results page` on name
  // alone. A guard written against one is not a guard on the other, and the two figures are published side by
  // side as though they belonged to one population — so the asymmetry is pinned here rather than left to a
  // future "simplification" that fuses them and quietly un-grades one counter.
  const prefixes = await engineResultPrefixes();
  const cases = [
    { file: "tests/a.test.mjs", name: "searches", urls: [UNREGISTERED] },
    { file: "tests/b.test.mjs", name: "searches", urls: [UNREGISTERED] },
  ];
  assert.equal(caseNames(cases).length, 2, "the invented count is keyed on file and name");
  assert.equal(
    new Set(classify(cases, prefixes).asResults.map((one) => one.name)).size,
    1,
    "the results count is keyed on name alone, so two cases with one name are one figure",
  );
});

// ---------------------------------------------------------------------------
// `--check`: the gate that is to stop the committed reading ageing silently again.
//
// The three places that restate the G.6 figures held each other to be true — the doc block, this script's
// header and the committed fixture — so the trio could agree with itself forever while the suite moved
// underneath it: measured 2026-11-02, all three said 387 cases while the suite had 407, and the suite was
// green. What was missing was not a comparison but a *refusal*: a mode that measures, writes nothing, and
// exits non-zero naming every place that no longer states the reading. That mode is the behaviour below.
// ---------------------------------------------------------------------------

/**
 * The instrument's own child run must not start a second instrument.
 *
 * `measure()` runs the shipped suite with this preload installed, and the suite runs this file. Without the
 * guard, every check case below would build a copy and spawn again from inside the measurement — and the
 * reading published would be one that had measured the instrument measuring itself.
 */
const CHECK_ONLY = process.env.CAMOUFOX_MEASURE_INVENTED === "1"
  ? "the instrument's own child run must not spawn a second instrument"
  : false;

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** The four-case suite the check cases measure; see its own header for why `npm test` never runs it. */
const PROBE = fileURLToPath(new URL("../tests/instrument-probe.mjs", import.meta.url));
/** The three-case suite the probe cases measure; registered or not is the only thing it varies. */
const RIG = fileURLToPath(new URL("../tests/instrument-rig.mjs", import.meta.url));

/**
 * Ask the copy's fake what it answers for a url nobody registered — asked of the copy, never restated here.
 *
 * A plant is only a plant if the copy agrees it landed, and the copy's fake is the only thing entitled to say
 * which pages it invents. Sent through `fake.fetch`, the same route `inventedPageText` takes, because the
 * measured child runs with `tests/helpers/fetch_guard.mjs` installed and that module throws on the global.
 */
const SERVES_PROGRAM = `
import("./tests/helpers/fake_gateway.mjs").then(async ({ createFakeGateway }) => {
  const fake = createFakeGateway();
  const url = process.env.SERVES_URL;
  const base = process.env.SERVES_BASE;
  const opened = await fake.fetch(base + "/tabs/open", {
    method: "POST",
    body: JSON.stringify({ userId: "plant", url }),
  }).then((response) => response.json());
  const page = await fake.fetch(base + "/tabs/" + opened.tabId + "/snapshot?userId=plant").then((response) => response.json());
  process.stdout.write(page.snapshot ?? "");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

/**
 * A copy of the repo the instrument can measure and rewrite with this tree out of reach.
 *
 * `--check` is only evidence if a real child measured a real suite, and the shipped suite is 14 s a run — so
 * the copy is handed the four-case probe as its suite. Everything the check reads is still a real file in the
 * copy: the committed fixture, the improvements doc, and this script's own header. That is what lets a case
 * plant a disagreement in exactly one of the three and watch the other two stay quiet, and lets the same
 * case prove afterwards that not one byte of the three moved.
 */
function scratchInstrument(t, options = {}) {
  const suite = options.suite ?? "probe";
  const root = mkdtempSync(join(tmpdir(), "g6-instrument-"));
  const dir = join(root, "repo");
  mkdirSync(join(dir, "tests", "fixtures", "measure"), { recursive: true });
  for (const entry of ["src", "scripts", "docs"]) {
    cpSync(join(REPO, entry), join(dir, entry), { recursive: true });
  }
  cpSync(join(REPO, "tests", "helpers"), join(dir, "tests", "helpers"), { recursive: true });
  cpSync(REPORT_FIXTURE, join(dir, "tests", "fixtures", "measure", "invented-page-count.txt"));
  writeFileSync(join(dir, "package.json"), readFileSync(join(REPO, "package.json")));
  // The copy runs the shipped `src/`, which imports `typebox`: node resolves up from the copy, so the one
  // thing a copy cannot afford to duplicate is the install.
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  cpSync(suite === "rig" ? RIG : PROBE, join(dir, "tests", `instrument-${suite}.test.mjs`));

  const instrument = {
    dir,
    script: join(dir, "scripts", "measure-unregistered-pages.mjs"),
    fixture: join(dir, "tests", "fixtures", "measure", "invented-page-count.txt"),
    fake: join(dir, "tests", "helpers", "fake_gateway.mjs"),
    doc: join(dir, "docs", "improvements", "2026-10-18-code.md"),
  };
  instrument.read = (path) => readFileSync(path, "utf8");
  instrument.write = (path, text) => writeFileSync(path, text, "utf8");
  /** What the copy's own fake answers for a url nobody registered, in the words it answers it in. */
  instrument.serves = (url) => {
    const run = spawnSync(process.execPath, ["-e", SERVES_PROGRAM], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, NODE_ENV: "test", SERVES_URL: url, SERVES_BASE: BASE },
      timeout: 30_000,
    });
    assert.equal(run.status, 0, `asking the copy's fake for ${url} failed:\n${run.stderr ?? ""}`);
    return run.stdout;
  };
  /** The three places the check reads, as bytes, so "it wrote nothing" is compared rather than believed. */
  instrument.bytes = () => Object.fromEntries(
    ["script", "fixture", "doc"].map((key) => [key, readFileSync(instrument[key])]),
  );
  /** Run the instrument in the copy: `--check` mode, or the default write mode when no mode is given. */
  instrument.run = (mode = "", extraEnv = {}) => {
    const env = { ...process.env, NODE_ENV: "test", ...extraEnv };
    delete env.NODE_TEST_CONTEXT; // a nested `node --test` would refuse to run any file and exit 0
    delete env.CAMOUFOX_MEASURE_INVENTED; // the copy is the measurer here, never the measured
    const run = spawnSync(process.execPath, [instrument.script, ...(mode ? [mode] : [])], {
      encoding: "utf8",
      cwd: dir,
      env,
      timeout: 180_000,
    });
    return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return instrument;
}

/** The header sentence the script states its own reading in, spelled the way the script spells it. */
const headerStating = (total, invented, asResults) =>
  `of ${total}\n * cases in the suite, ${invented} read the fake's invented page and ${asResults} read it as an engine's results page`;

/**
 * Bring the copy's two restatements up to the reading its instrument just committed.
 *
 * This is the same two edits a person makes by hand after a re-measure — the doc's fenced block and the
 * sentence in this script's header — which is why the block is copied out of the fixture rather than
 * retyped: the fixture's first three lines *are* the block, and a second spelling of them here would be a
 * fourth place to keep in agreement.
 */
function restate(instrument) {
  const headline = instrument.read(instrument.fixture).replace(/\n+$/u, "").split("\n").slice(0, 3);
  const stated = readHeadlineFigures(headline.join("\n"));
  assert.ok(stated, "the copy's fixture no longer carries three headline lines this can restate from");

  const doc = instrument.read(instrument.doc).split("\n");
  const at = doc.findIndex((line) => line.startsWith("cases in the suite:"));
  assert.ok(at >= 0, "the copy's doc carries no G.6 block to restate");
  doc.splice(at, 3, ...headline);
  instrument.write(instrument.doc, doc.join("\n"));

  const script = instrument.read(instrument.script);
  const restated = script.replace(HEADER_STATING, headerStating(stated.total, stated.invented, stated.asResults));
  assert.notEqual(restated, script, "the header sentence moved, so this restatement silently did nothing");
  instrument.write(instrument.script, restated);

  // The plant is only a plant if the reader agrees it landed, or a case below could pass on a no-op.
  assert.deepEqual(readDocFigures(instrument.read(instrument.doc)), stated, "the doc does not now state the fixture's reading");
  assert.deepEqual(readHeaderFigures(instrument.read(instrument.script)), stated, "the header does not now state the fixture's reading");
}

/**
 * A place counts as named only when the check lists it as a disagreement — its path alone on a line.
 *
 * A whole-output `includes` would also match the footer, which prints this script's own path inside the
 * instruction to re-measure. Every assertion about the header below would then pass whether the check had
 * found the header stale or not — a gate whose positive case is satisfied by the gate's own help text.
 */
const named = (output, place) => output.split("\n").some((line) => line.trim() === place);

/** The line the check prints for one figure, so both numbers it cites can be read back rather than assumed. */
function cited(output, label) {
  const found = output.match(new RegExp(`${label}:\\s+committed (\\d+)(?: of \\d+)?\\s+measured (\\d+)`, "u"));
  assert.ok(found, `the check never cited ${label} as committed against measured:\n${output}`);
  return { committed: Number.parseInt(found[1], 10), measured: Number.parseInt(found[2], 10) };
}

test("case 13: --check refuses the reading the repo committed, names all three places that still state it, and writes nothing", { skip: CHECK_ONLY }, (t) => {
  // The gate's own proof, and the point of the unit: nothing here has been re-measured, so the copy carries
  // exactly what this repo commits today — whatever figure the fixture carries right now — against a suite
  // that says otherwise. It is run against a copy rather than this tree on purpose: an assertion that the
  // tree *is* stale would go green the day somebody refreshes it, and a gate that can be satisfied is not
  // a gate.
  const instrument = scratchInstrument(t);
  const committed = readHeadlineFigures(instrument.read(instrument.fixture));
  assert.ok(committed && committed.total > 0, "the committed reading this case plants has no figures to be stale");
  const before = instrument.bytes();

  const run = instrument.run(CHECK_FLAG);

  assert.notEqual(run.status, 0, `--check accepted a copy whose three places were never re-measured:\n${run.output}`);
  for (const place of Object.values(PLACES)) {
    assert.ok(named(run.output, place), `the check did not name ${place} as a place that disagrees:\n${run.output}`);
  }
  // The committed figure against the reading just taken — and the two have to be different numbers, or
  // naming one of them twice would look exactly like the gate working.
  const total = cited(run.output, "cases in the suite");
  assert.equal(total.committed, committed.total, "the figure it named is not the one the copy had committed");
  assert.notEqual(total.measured, total.committed, "it cited the committed figure against itself");
  assert.deepEqual(instrument.bytes(), before, `--check wrote to one of the three places it was asked only to read:\n${run.output}`);
});

test("case 14: after a re-measure --check drops the fixture it refreshed, and passes outright once the doc and the header carry the same reading", { skip: CHECK_ONLY }, (t) => {
  // Which of the three this covers, stated because it is not all three at once: the fixture is the
  // instrument's own output, so a write-mode run makes it true again by itself. The doc and this script's
  // header are restated by hand, so until they follow, the check must still refuse — and must say so about
  // those two only. Both halves are asserted, because a check that went quiet about everything after a
  // re-measure would be a gate that had simply stopped checking.
  const instrument = scratchInstrument(t);

  const measured = instrument.run();
  assert.equal(measured.status, 0, `the default mode has to keep working, untouched:\n${measured.output}`);
  const fresh = readHeadlineFigures(measured.output);
  assert.ok(fresh && fresh.total > 0, `the re-measure published no figures:\n${measured.output}`);

  const halfDone = instrument.run(CHECK_FLAG);
  assert.notEqual(halfDone.status, 0, `--check passed with only the fixture refreshed and the two hand-restated places left behind:\n${halfDone.output}`);
  assert.ok(!named(halfDone.output, PLACES.fixture), "it named the fixture, which the re-measure had just made correct");
  for (const place of [PLACES.doc, PLACES.header]) {
    assert.ok(named(halfDone.output, place), `it stayed quiet about ${place}, which still stated the old reading:\n${halfDone.output}`);
  }

  restate(instrument);
  const before = instrument.bytes();
  const passing = instrument.run(CHECK_FLAG);

  assert.equal(passing.status, 0, `--check refused a copy whose three places all stated the reading:\n${passing.output}`);
  assert.deepEqual(instrument.bytes(), before, `--check wrote to a place after all:\n${passing.output}`);
});

test("case 15: a header planted one figure off is named, and the instrument leaves the file it wrote no part in", { skip: CHECK_ONLY }, (t) => {
  // The other half of the gate: a disagreement has to be *said*, with both figures, in the place it lives.
  // The alternative is the behaviour this mode replaces — an instrument that quietly rewrote whatever
  // disagreed with it, which is what the default mode does and the reason the drift was never visible.
  const instrument = scratchInstrument(t);
  const fresh = readHeadlineFigures(instrument.run().output);
  assert.ok(fresh && fresh.total > 0, "the re-measure published no figures to plant a drift against");
  restate(instrument);

  const script = instrument.read(instrument.script);
  const drifted = script.replace(HEADER_STATING, headerStating(fresh.total + 1, fresh.invented, fresh.asResults));
  assert.notEqual(drifted, script, "the planted drift silently did not land, so nothing below is evidence");
  instrument.write(instrument.script, drifted);
  const before = instrument.bytes();

  const run = instrument.run(CHECK_FLAG);

  assert.notEqual(run.status, 0, `--check passed over a header off by one:\n${run.output}`);
  assert.ok(named(run.output, PLACES.header), `the header was not named:\n${run.output}`);
  for (const place of [PLACES.fixture, PLACES.doc]) {
    assert.ok(!named(run.output, place), `it named ${place}, which stated the fresh reading:\n${run.output}`);
  }
  const total = cited(run.output, "cases in the suite");
  assert.equal(total.committed, fresh.total + 1, "the figure it named is not the one planted");
  assert.equal(total.measured, fresh.total, "it did not cite the reading the suite actually gave");
  assert.deepEqual(instrument.bytes(), before, `the check rewrote the place it was asked to name:\n${run.output}`);
});

test("--check is the only thing that turns the instrument into a gate", () => {
  // Two behaviours in one file, and the suite must never reach the measuring one. Which mode runs is the
  // whole difference between a reading and a refusal, so it is asserted at the seam rather than inferred.
  assert.equal(requestedCheck(["node", "scripts/measure-unregistered-pages.mjs"]), false);
  assert.equal(requestedCheck(["node", "scripts/measure-unregistered-pages.mjs", CHECK_FLAG]), true);
  assert.equal(requestedCheck(["node", "scripts/measure-unregistered-pages.mjs", "--checked"]), false);
});

test("the check reads the three figures out of each of the three places, in the shape each one states them", () => {
  // The fixture holds the printed lines; the doc holds the same three inside a fence; the header holds them
  // in a sentence. One reader per shape, because a single reader loose enough to read all three is loose
  // enough to read a figure that is not there — and to report the place as agreeing.
  const printedLines = [
    "cases in the suite:                   407, all passing",
    "read the fake's invented page:        47 of 407",
    "read it as an engine's results page:  11 of 407",
  ];
  const printed = printedLines.join("\n");
  assert.deepEqual(readHeadlineFigures(printed), { total: 407, invented: 47, inventedOf: 407, asResults: 11, asResultsOf: 407 });
  assert.deepEqual(readHeadlineFigures(printed.replace(/^cases in the suite.*$/mu, "")), null, "a reading missing a figure is not a reading");
  assert.deepEqual(readHeadlineFigures("the doc, rewritten, no longer quotes the instrument"), null);

  const block = ["", "```", ...printedLines, "```", ""].join("\n");
  assert.deepEqual(readDocFigures(block), { total: 407, invented: 47, inventedOf: 407, asResults: 11, asResultsOf: 407 });
  assert.deepEqual(readDocFigures("a version of the doc with the block taken out"), null, "a doc that stopped quoting the reading is one that disagrees");

  assert.deepEqual(readHeaderFigures(`runs: of 407\n * cases in the suite, 47 read the fake's invented page and 11 read it as an engine's results page.`), {
    total: 407, invented: 47, inventedOf: 407, asResults: 11, asResultsOf: 407,
  });
  assert.deepEqual(readHeaderFigures("a header that stopped stating its own reading"), null);
});

test("the check names the place whose figures differ, and stays quiet about the ones that do not", () => {
  const measured = readHeadlineFigures([
    "cases in the suite:                   407",
    "read the fake's invented page:        47 of 407",
    "read it as an engine's results page:  11 of 407",
  ].join("\n"));
  const agrees = { ...measured };
  const staleTotal = { ...measured, total: 387, inventedOf: 387, asResultsOf: 387 };
  const staleOneFigure = { ...measured, asResults: 12 };
  // One figure quoted against the wrong denominator is the shape a hand-edited block actually takes, and it
  // is the shape a comparison of the three headline *lines* would wave through.
  const wrongDenominator = { ...measured, inventedOf: 384 };

  assert.deepEqual(findDisagreements(measured, new Map([["a", agrees]])), []);
  assert.deepEqual(
    findDisagreements(measured, new Map([["fixture", staleTotal], ["doc", agrees], ["header", staleOneFigure]])).map((one) => one.place),
    ["fixture", "header"],
    "the places named are not the two that were perturbed",
  );
  assert.deepEqual(
    findDisagreements(measured, new Map([["doc", wrongDenominator]]))[0].labels,
    ["read the fake's invented page"],
    "a figure quoted against an outdated total is not the reading",
  );
  assert.deepEqual(
    findDisagreements(measured, new Map([["doc", null]])).map((one) => one.place),
    ["doc"],
    "a place that no longer states the reading at all is a disagreement, not a pass",
  );
});

// ---------------------------------------------------------------------------
// The two figures a shipped suite cannot produce on demand: a run in which one case reads an engine's results
// page nobody registered, and the same run with that page registered, where the honest reading is zero. Both
// are measured in a scratch copy over `tests/instrument-rig.mjs`, against a fake this file plants — planted,
// never assumed, because which pages the fake invents is the fake's decision to make.
// ---------------------------------------------------------------------------

/** The invented article as the fake's own source spells it, from its heading to its closing `].join(`. */
function inventedArticle(source) {
  const start = source.indexOf('- heading "Page: ');
  assert.ok(start > 0, "the fake no longer builds its invented page off a heading, so there is nothing here to edit");
  const end = source.indexOf("].join(", start);
  assert.ok(end > start, "the fake's invented page is no longer an array a line can be cut out of");
  return { start, end, text: source.slice(start, end) };
}

/** A url under an engine's own results prefix that no rig case registers, so only the fake can answer it. */
const plantUrl = (prefixes) => `${prefixes.get("duckduckgo")}plant-check`;

/** Give the copy's invention a `/url:` line — the one shape that made a single link a result set. */
function withLinkedInvention(instrument, url) {
  const source = instrument.read(instrument.fake);
  const block = inventedArticle(source);
  if (!/\/url:/u.test(block.text)) {
    const afterHeading = source.indexOf("\n", block.start) + 1;
    instrument.write(instrument.fake, `${source.slice(0, afterHeading)}      "  - /url: https://camoufox.com/docs",\n${source.slice(afterHeading)}`);
  }
  assert.match(inventedArticle(instrument.read(instrument.fake)).text, /\/url:/u, "the planted /url: line did not land");
  assert.match(instrument.serves(url), /\/url:/u, `the copy does not answer ${url} with a linked page`);
  assert.match(instrument.serves("https://www.google.com/search?q=plant"), /google\.com\/goto/u, "and the page the fake ships is still the page it ships");
  return instrument;
}

/** Take every `/url:` line out of the copy's invention, and leave the pages it ships alone. */
function withLinklessInvention(instrument, url) {
  const source = instrument.read(instrument.fake);
  const block = inventedArticle(source);
  const linkless = block.text.replace(/^[ \t]*["'][^"']*\/url:[^"']*?["'],\n/gmu, "");
  instrument.write(instrument.fake, `${source.slice(0, block.start)}${linkless}${source.slice(block.end)}`);

  assert.doesNotMatch(inventedArticle(instrument.read(instrument.fake)).text, /\/url:/u, "a /url: line survived the plant");
  assert.doesNotMatch(instrument.serves(url), /\/url:/u, `the copy still answers ${url} with a link`);
  assert.match(instrument.serves("https://www.google.com/search?q=plant"), /google\.com\/goto/u, "and the plant left the shipped SERP alone");
  return instrument;
}

/** Make the copy's fake *ship* a page at the engine's results url, so nothing there can be recognised as invented. */
function withTheInventionHidden(instrument, url) {
  const source = instrument.read(instrument.fake);
  const anchor = 'if (url.includes("google.com/search")) {';
  assert.ok(source.includes(anchor), "the fake no longer ships a page by url shape, so this plant has nothing to widen");
  instrument.write(instrument.fake, source.replace(anchor, 'if (url.includes("google.com/search") || url.includes("duckduckgo.com")) {'));
  assert.match(instrument.serves(url), /google\.com\/goto/u, `${url} is still answered with an invention, so the plant did not land`);
  return instrument;
}

/** How many of the recorder's own probe reads it recognised as inventions, out of how many it took. */
function probeSaw(output) {
  const found = output.match(/^probe:\s+(\d+) of (\d+)/mu);
  assert.ok(found, `the run printed no probe line, so nothing here proves the recorder saw anything:\n${output}`);
  return { invented: Number.parseInt(found[1], 10), of: Number.parseInt(found[2], 10) };
}

test("the results-page count still fires when nothing is registered at the engine's url", { skip: CHECK_ONLY }, async (t) => {
  // The row that keeps `read it as an engine's results page` falsifiable. Once the shipped suite reports 0 —
  // which is U2's whole acceptance bar — a 1 has to be reachable on demand somewhere, or the published 0 is a
  // figure nothing can contradict. The fake here carries the linked article G.6 is about, and the case
  // registers nothing: that is the hole, reproduced to order.
  const instrument = scratchInstrument(t, { suite: "rig" });
  const url = plantUrl(await engineResultPrefixes());
  withLinkedInvention(instrument, url);

  const run = instrument.run("", { CAMOUFOX_MEASURE_RIG_REGISTER: "0" });
  assert.equal(run.status, 0, `the instrument refused a run it should have published:\n${run.output}`);
  assert.equal(readHeadlineFigures(run.output).asResults, 1, "one case read an invented page as an engine's results page");
  assert.ok(probeSaw(run.output).invented > 0, "and the recorder saw its own probe, which is what makes the 1 a reading");
});

test("a case that registers the engine's own results page takes that count to zero, and the zero publishes", { skip: CHECK_ONLY }, async (t) => {
  // The end state U2 has to reach, proven reachable here rather than hoped for across the shipped suite: the
  // instrument must publish, not throw. Two things are being asserted at once, and the second is the whole
  // point of the rig — had the recorder's own probe been flushed as a case, `classify` would have credited
  // this run with an engine read at its own probe url and 0 would have been out of reach forever.
  const instrument = scratchInstrument(t, { suite: "rig" });
  const url = plantUrl(await engineResultPrefixes());
  withLinklessInvention(instrument, url);

  const run = instrument.run("", { CAMOUFOX_MEASURE_RIG_REGISTER: "1" });
  assert.equal(run.status, 0, `the instrument refused to publish a zero it had every right to publish:\n${run.output}`);
  const figures = readHeadlineFigures(run.output);
  assert.equal(figures.asResults, 0, "the only engine read in the run was a page somebody registered");
  assert.ok(figures.invented > 0, "the other count moved, so this is a closed hole rather than a silent recorder");
  assert.ok(probeSaw(run.output).invented > 0, "and the probe still saw an invention, which is what licenses the zero");
});

test("the count is the url and not the page, so a linkless invention is still counted", { skip: CHECK_ONLY }, async (t) => {
  // Removing the link is U3's job, and this says why the order is forced: `classify` matches on the url alone,
  // so no edit to the invented page can move this figure. A plan that deleted the link first would have landed
  // a suite still reporting 11 and an instrument nobody believed.
  const instrument = scratchInstrument(t, { suite: "rig" });
  const url = plantUrl(await engineResultPrefixes());
  withLinklessInvention(instrument, url);

  const run = instrument.run("", { CAMOUFOX_MEASURE_RIG_REGISTER: "0" });
  assert.equal(run.status, 0, `the instrument refused a run it should have published:\n${run.output}`);
  assert.equal(readHeadlineFigures(run.output).asResults, 1, "a page with no link in it is still read at an engine's results url");
});

test("a recorder that cannot recognise its own probe read is refused, though the suite reported its total", { skip: CHECK_ONLY }, async (t) => {
  // The blindness this guard exists for, in the only shape it can take once the probe is unconditional: not an
  // empty case list — that is what a closed hole looks like now — but a recorder handed a page and unable to
  // say it was invented. Here the fake ships a page at the engine's url, the suite runs green, and the
  // instrument must still refuse rather than print a number it cannot see.
  const instrument = scratchInstrument(t, { suite: "rig" });
  const url = plantUrl(await engineResultPrefixes());
  withTheInventionHidden(instrument, url);

  const run = instrument.run("", { CAMOUFOX_MEASURE_RIG_REGISTER: "0" });
  assert.notEqual(run.status, 0, `the instrument published a reading its own recorder could not see:\n${run.output}`);
  assert.match(run.output, /recognised none of it as an invention/u, "it refused for the probe, which is the reason");
  assert.match(run.output, /reported [1-9]\d* cases/u, "and the suite it refused really ran");
  assert.match(run.output, /0 failing/u, "with nothing red in it, so no failing test is doing the refusing");
});
