import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parsePathHints, gatherBundle } from "../bundle.ts";

test("parsePathHints: splits path:why pairs on the FIRST colon, semicolon-separated", () => {
  const hints = parsePathHints("src/a.ts:why one; src/b.ts:why two: with a colon; src/c.ts");
  assert.deepEqual(hints, [
    { path: "src/a.ts", why: "why one" },
    { path: "src/b.ts", why: "why two: with a colon" },
    { path: "src/c.ts", why: "" },
  ]);
});

test("parsePathHints: undefined/empty input yields no hints", () => {
  assert.deepEqual(parsePathHints(undefined), []);
  assert.deepEqual(parsePathHints(""), []);
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "brainstrust-bundle-test-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
  writeFileSync(join(dir, "committed.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", dir, "add", "committed.ts"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("gatherBundle: reads hinted files and reports them in filesRead", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "extra.ts"), "export const b = 2;\n");
    const bundle = gatherBundle(dir, [{ path: "src/extra.ts", why: "the thing" }]);
    assert.deepEqual(bundle.filesRead, ["src/extra.ts"]);
    assert.deepEqual(bundle.filesMissing, []);
    assert.match(bundle.text, /export const b = 2;/);
    assert.match(bundle.text, /the thing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherBundle: a working-tree change against HEAD is picked up as a diff", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "committed.ts"), "export const a = 2;\n");
    const bundle = gatherBundle(dir, []);
    assert.equal(bundle.diffIncluded, true);
    assert.match(bundle.text, /git diff HEAD/);
    assert.match(bundle.text, /-export const a = 1;/);
    assert.match(bundle.text, /\+export const a = 2;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherBundle: a clean tree with no hints produces no diff and an empty bundle", () => {
  const dir = makeRepo();
  try {
    const bundle = gatherBundle(dir, []);
    assert.equal(bundle.diffIncluded, false);
    assert.equal(bundle.text, "");
    assert.equal(bundle.bytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherBundle: a hint that resolves outside the repo is refused, not read", () => {
  const dir = makeRepo();
  try {
    const bundle = gatherBundle(dir, [{ path: "../../etc/passwd", why: "" }]);
    assert.deepEqual(bundle.filesRead, []);
    assert.deepEqual(bundle.filesMissing, ["../../etc/passwd"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherBundle: a nonexistent hinted file is reported missing, not thrown", () => {
  const dir = makeRepo();
  try {
    const bundle = gatherBundle(dir, [{ path: "does/not/exist.ts", why: "" }]);
    assert.deepEqual(bundle.filesRead, []);
    assert.deepEqual(bundle.filesMissing, ["does/not/exist.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherBundle: a tiny byte budget truncates rather than silently dropping files", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "one.ts"), "a".repeat(100));
    writeFileSync(join(dir, "src", "two.ts"), "b".repeat(100));
    const bundle = gatherBundle(dir, [
      { path: "src/one.ts", why: "" },
      { path: "src/two.ts", why: "" },
    ], 50);
    assert.equal(bundle.truncated, true);
    assert.ok(bundle.filesMissing.length >= 1, "at least one file should be reported as skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
