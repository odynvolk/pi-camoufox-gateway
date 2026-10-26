/**
 * A release is a version plus everything that has to say it.
 *
 * The regression is real and sitting in the diff history: the lockfile still read 0.1.0 across two
 * fields while `package.json` had moved to 0.1.1, so an install through the lock resolved a package
 * that no longer existed as a published version — and no gate here could see it, because nothing read
 * the two files together. A version bump is a hand-edited set of four places, so the set is checked
 * rather than remembered.
 */

import "./helpers/fetch_guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const readme = read("README.md");
const changelog = read("CHANGELOG.md");

/** Version-shaped strings only, so a dependency's `1.1.0` range in the lock is not mistaken for ours. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

test("the lockfile carries the version package.json ships", () => {
  // npm writes both of these; either can be hand-edited, and the one that gets missed is the one a
  // reader cannot see, because `npm ci` stays green on a lock that merely disagrees.
  assert.equal(lock.version, pkg.version, "package-lock.json (top level) is stale");
  assert.equal(lock.packages[""].version, pkg.version, 'package-lock.json packages[""] is stale');
  assert.match(pkg.version, SEMVER);
});

test("the lockfile still matches the dependencies package.json declares", () => {
  // The other half of a stale lock: a version field that was hand-fixed while a dependency range was
  // added to one file and not the other.
  const declared = (section) => Object.entries(pkg[section] ?? {}).sort();
  const recorded = (section) => Object.entries(lock.packages[""][section] ?? {}).sort();

  for (const section of ["devDependencies", "peerDependencies", "engines"]) {
    assert.deepEqual(recorded(section), declared(section), `package-lock.json is out of date on "${section}"`);
  }
});

test("the README installs the version this package is", () => {
  // A pinned tag is the line a reader copies, so a stale one is a working command that installs an
  // old package. One pinned example is expected — a second one is a decision this test cannot make.
  const tags = [...readme.matchAll(/github\.com\/odynvolk\/pi-camoufox-gateway@v([0-9][\w.+-]*)/gu)].map(
    (match) => match[1],
  );
  assert.equal(tags.length, 1, `expected one pinned install tag, found ${tags.length}: ${tags.join(", ")}`);
  assert.equal(tags[0], pkg.version, "the README pins a tag this release does not name");
});

test("the changelog leads with the version being shipped", () => {
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gmu)].map((match) => match[1]);
  assert.ok(headings.length > 0, "no versioned heading in CHANGELOG.md");
  assert.equal(headings[0], pkg.version, "the top CHANGELOG.md section is not the version package.json ships");
  assert.ok(
    new Set(headings).size === headings.length,
    "a version appears twice in CHANGELOG.md — its entries are ambiguous about what shipped when",
  );
});

test("the changelog ships with the package", () => {
  // `files` is a whitelist, so a changelog left out of it is a file that exists in git and nowhere in
  // the published tarball — the one place a user looking for "what changed" would read it.
  assert.ok(pkg.files.includes("CHANGELOG.md"), "CHANGELOG.md is not in package.json files");
});
