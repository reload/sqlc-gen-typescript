#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedFiles = [
  "examples/node-pg/src/db/query_sql.ts",
  "examples/bun-pg/src/db/query_sql.ts",
].map((path) => resolve(root, path));
const tsc = resolve(root, "node_modules/.bin/tsc");

function relativePath(path) {
  return relative(root, path);
}

test("generated pg :one queries guard row access", () => {
  let totalOneQueryCount = 0;

  for (const generatedFile of generatedFiles) {
    assert.ok(
      existsSync(generatedFile),
      `Missing generated pg output: ${generatedFile}`
    );

    const source = readFileSync(generatedFile, "utf8");
    const oneQueryCount = [...source.matchAll(/-- name:\s+\w+\s+:one\b/g)]
      .length;

    assert.ok(
      oneQueryCount > 0,
      `Expected at least one generated pg :one query to validate in ${relativePath(generatedFile)}.`
    );

    const guardedRowAccessCount = [
      ...source.matchAll(
        /if \(result\.rows\.length !== 1\) \{\n\s+return null;\n\s+\}\n\s+const row = result\.rows\[0\];\n\s+if \(!row\) \{\n\s+return null;\n\s+\}/g
      ),
    ].length;

    assert.equal(
      guardedRowAccessCount,
      oneQueryCount,
      `${relativePath(generatedFile)} must guard \`result.rows[0]\` after the exact row-count guard for every :one query.`
    );

    assert.doesNotMatch(
      source,
      /const row = result\.rows\[0\]!;/,
      `${relativePath(generatedFile)} must not use non-null row assertions.`
    );

    totalOneQueryCount += oneQueryCount;
  }

  assert.ok(totalOneQueryCount > 0, "Expected at least one pg :one query.");
});

test("generated pg output type-checks with strict noUncheckedIndexedAccess", () => {
  assert.ok(
    existsSync(tsc),
    "Missing TypeScript compiler. Install project dependencies before running validation."
  );

  const result = spawnSync(
    tsc,
    [
      "--ignoreConfig",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--module",
      "commonjs",
      "--target",
      "es2020",
      "--esModuleInterop",
      "--skipLibCheck",
      "--noEmit",
      ...generatedFiles,
    ],
    { cwd: root, encoding: "utf8" }
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    [
      "Generated pg output failed strict noUncheckedIndexedAccess type-check.",
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n")
  );
});
