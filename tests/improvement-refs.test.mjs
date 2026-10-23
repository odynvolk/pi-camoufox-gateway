/**
 * The improvement docs make claims about code, so their refs are checked like code.
 *
 * These refs used to be line numbers, and they were wrong the way only a line number can be: still
 * shaped like a citation. Measured the day this test was written, a ref four lines off pointed at
 * `if (response.status === 404) {` and another had pointed at a blank line since the file was written,
 * and no gate in this repo could see either — `tsc` does not read markdown, and there is no CI. So a
 * ref names a *fragment* instead: it survives any commit that adds a line, and breaks on a rename,
 * which is the one a reader can do something about.
 *
 * Only the docs with open items are held to this. `docs/solutions/` and `docs/plans/archive/` record
 * what was true when written, and editing history to keep a test green is its own finding.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const DOCS = ["docs/improvements/2026-10-18-code.md", "docs/improvements/2026-10-18-functionality.md"];

const FILE = String.raw`[\w./-]+\.(?:ts|mts|js|mjs|json|md)`;
/** A ref: a file, then a fragment that must still be findable inside it. */
const ANCHOR = new RegExp("`(" + FILE + ")`\\s*\u2192\\s*`([^`]+)`", "gu");
/** Any backticked file path, anchored or not. */
const FILE_REF = new RegExp("`(" + FILE + ")`", "gu");
/** The shape this repo just deleted on purpose: a path with a line number after it. */
const LINE_REF = new RegExp("`(" + FILE + "):\\d[^`]*`", "gu");

/**
 * Where a ref written as a bare basename — which is how the older prose phrases them — is allowed to
 * live. A ref that *names* a directory is honoured exactly as written and never rescued from here:
 * falling back on `src/engine/chain.ts` would find the real `src/engines/chain.ts` and report a typo as
 * a passing ref, which is a ref that is wrong and looks right.
 */
const ROOTS = ["", "src/", "src/tools/", "src/engines/", "tests/", "tests/fixtures/", "docs/"];

function resolveRef(path) {
  if (path.includes("/")) return existsSync(path) ? path : undefined;
  return ROOTS.map((root) => `${root}${path}`).find((candidate) => existsSync(candidate));
}

/** Refs across every held doc, de-duplicated so one mistake is reported once. */
function refsIn(pattern) {
  const found = new Map();
  for (const doc of DOCS) {
    for (const match of readFileSync(doc, "utf8").matchAll(pattern)) {
      found.set(match[0], { doc, whole: match[0], path: match[1], fragment: match[2] });
    }
  }
  return [...found.values()];
}

test("no improvement-doc ref points at a line number", () => {
  // The regression this exists for. Re-adding one re-imports the defect: a ref that is silently wrong
  // looks exactly like a ref that is right, and the number has nothing to say about which it is.
  const numbered = refsIn(LINE_REF).map((ref) => `${ref.doc}: ${ref.whole}`);
  assert.deepEqual(
    numbered,
    [],
    "refs name lines again; cite a fragment instead — `path` → `a fragment of the code it means`",
  );
});

test("every anchored ref still names code that is there", () => {
  const broken = [];

  for (const ref of refsIn(ANCHOR)) {
    const path = resolveRef(ref.path);
    if (path === undefined) {
      broken.push(`${ref.doc}: ${ref.whole} — no file at ${ref.path}`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(ref.fragment)) {
      broken.push(`${ref.doc}: ${ref.whole} — ${path} no longer contains that fragment`);
    }
  }

  assert.deepEqual(broken, [], "stale refs in the improvement docs");
});

test("a file named without an anchor still resolves", () => {
  // The other half of the same failure: dropping `:74-92` from a ref is only progress if the path that
  // is left is a file a reader can open.
  const anchored = new Set(refsIn(ANCHOR).map((ref) => `\`${ref.path}\``));
  const missing = refsIn(FILE_REF)
    .filter((ref) => !anchored.has(`\`${ref.path}\``))
    .filter((ref) => resolveRef(ref.path) === undefined)
    .map((ref) => `${ref.doc}: ${ref.whole}`);

  assert.deepEqual(missing, [], "refs naming a file that does not exist, under any of the roots tried");
});
