#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import {
  assertTypeChecks,
  pgGeneratedFiles,
  relativePath,
} from "../test-support/driver-test-helpers.mjs";

test("generated pg :one queries guard row access", () => {
  let totalOneQueryCount = 0;

  for (const generatedFile of pgGeneratedFiles) {
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
  assertTypeChecks("Generated pg output", pgGeneratedFiles);
});
