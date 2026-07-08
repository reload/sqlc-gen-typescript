#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import {
  assertTypeChecks,
  loadGeneratedModule,
  pgDriverTemplateFile,
  pgGeneratedFiles,
  pgUnsupportedBatchUsageFile,
  relativePath,
} from "../test-support/driver-test-helpers.mjs";

test("generated pg batch queries fail with an unsupported-driver error", async () => {
  for (const generatedFile of pgGeneratedFiles) {
    assert.ok(
      existsSync(generatedFile),
      `Missing generated pg output: ${generatedFile}`
    );

    const source = readFileSync(generatedFile, "utf8");

    assert.match(
      source,
      /class SqlcBatchUnsupportedError extends Error/,
      `${relativePath(generatedFile)} must expose an explicit unsupported batch error.`
    );
    assert.match(
      source,
      /use the postgres driver for batch annotations/,
      `${relativePath(generatedFile)} must point users to the supported driver.`
    );
    assert.equal(
      [...source.matchAll(/throw new SqlcBatchUnsupportedError\(":batch(?:one|many|exec)"\);/g)].length,
      3,
      `${relativePath(generatedFile)} must reject every generated pg batch function.`
    );
    assert.match(
      source,
      /interface SqlcBatchOptions \{\n\s+batchSize\?: number;\n\}/,
      `${relativePath(generatedFile)} must keep batch options source-compatible for unsupported pg stubs.`
    );
    assert.equal(
      [...source.matchAll(/_options\?: SqlcBatchOptions/g)].length,
      3,
      `${relativePath(generatedFile)} must accept old pg batch options without using them.`
    );
    assert.doesNotMatch(
      source,
      /Promise\.allSettled/,
      `${relativePath(generatedFile)} must not emulate batching with queued node-postgres queries.`
    );
    assert.doesNotMatch(
      source,
      /client\.query\(\{\n\s+text: batch/,
      `${relativePath(generatedFile)} must not issue per-item node-postgres queries for batch annotations.`
    );
  }

  const { SqlcBatchUnsupportedError, batchDeleteAuthor } = loadGeneratedModule(
    pgGeneratedFiles[0]
  );
  const calls = [];
  const client = {
    query(config) {
      calls.push(config);
      return Promise.resolve({ rows: [] });
    },
  };

  await assert.rejects(
    batchDeleteAuthor(client, [{ id: "1" }], { batchSize: 1 }),
    (error) => {
      assert.ok(error instanceof SqlcBatchUnsupportedError);
      assert.equal(error.driver, "pg");
      assert.equal(error.command, ":batchexec");
      assert.equal(calls.length, 0, "pg must not send queries for unsupported batch annotations.");
      return true;
    }
  );
});

test("pg batch generator template rejects unsupported batch annotations", () => {
  const source = readFileSync(pgDriverTemplateFile, "utf8");
  assert.match(
    source,
    /function batchUnsupportedDecls\(\): Node\[\]/,
    "pg driver must generate explicit unsupported batch support."
  );
  assert.match(
    source,
    /SqlcBatchUnsupportedError/,
    "pg driver must expose a generated unsupported-driver error."
  );
  assert.match(
    source,
    /use the postgres driver for batch annotations/,
    "pg driver must direct batch users to the postgres driver."
  );
  assert.equal(
    [...source.matchAll(/throw new SqlcBatchUnsupportedError\(":batch(?:one|many|exec)"\);/g)].length,
    3,
    "pg driver must reject all batch annotation variants."
  );
  assert.doesNotMatch(
    source,
    /Promise\.allSettled\(/,
    "pg driver must not emulate batching with node-postgres query queues."
  );
  assert.doesNotMatch(
    source,
    /client\.query\(\{\n\s+text: \$\{queryName\}/,
    "pg driver must not generate per-item node-postgres batch queries."
  );
});

test("generated pg batch output type-checks with strict noUncheckedIndexedAccess", () => {
  assertTypeChecks("Generated pg batch output", [
    ...pgGeneratedFiles,
    pgUnsupportedBatchUsageFile,
  ]);
});
