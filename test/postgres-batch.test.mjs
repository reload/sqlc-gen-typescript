#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import {
  assertTypeChecks,
  batchUsageFile,
  deferred,
  flushAsync,
  loadGeneratedModule,
  postgresDriverTemplateFile,
  postgresGeneratedFiles,
  relativePath,
} from "../test-support/driver-test-helpers.mjs";

test("generated postgres batch queries use bounded helpers", () => {
  for (const generatedFile of postgresGeneratedFiles) {
    assert.ok(
      existsSync(generatedFile),
      `Missing generated postgres output: ${generatedFile}`
    );

    const source = readFileSync(generatedFile, "utf8");

    assert.match(
      source,
      /-- name: BatchCreateAuthor :batchone\b/,
      `${relativePath(generatedFile)} must include a generated :batchone example.`
    );
    assert.match(
      source,
      /-- name: BatchListAuthorsByBio :batchmany\b/,
      `${relativePath(generatedFile)} must include a generated :batchmany example.`
    );
    assert.match(
      source,
      /-- name: BatchDeleteAuthor :batchexec\b/,
      `${relativePath(generatedFile)} must include a generated :batchexec example.`
    );
    assert.match(
      source,
      /interface SqlcBatchOptions \{\n\s+batchSize\?: number;\n\}/,
      `${relativePath(generatedFile)} must expose bounded batch options.`
    );
    assert.match(
      source,
      /class SqlcBatchError extends Error/,
      `${relativePath(generatedFile)} must expose a rejecting batch error type.`
    );
    assert.match(
      source,
      /Promise\.allSettled\(chunk\.map/,
      `${relativePath(generatedFile)} must settle bounded chunks.`
    );
    assert.match(
      source,
      /interface BatchCreateAuthorBatchResult \{\n\s+index: number;\n\s+row: BatchCreateAuthorRow \| null;\n\}/,
      `${relativePath(generatedFile)} must expose an ordered :batchone result.`
    );
    assert.match(
      source,
      /interface BatchListAuthorsByBioBatchResult \{\n\s+index: number;\n\s+rows: BatchListAuthorsByBioRow\[\];\n\}/,
      `${relativePath(generatedFile)} must expose an ordered :batchmany result.`
    );
    assert.match(
      source,
      /interface BatchDeleteAuthorBatchResult \{\n\s+index: number;\n\}/,
      `${relativePath(generatedFile)} must expose an ordered :batchexec result.`
    );
    assert.equal(
      [...source.matchAll(/options\?: SqlcBatchOptions/g)].length,
      3,
      `${relativePath(generatedFile)} must accept bounded batch options for every batch function.`
    );
    assert.equal(
      [...source.matchAll(/const batchSql = await sql\.reserve\(\);/g)].length,
      3,
      `${relativePath(generatedFile)} must reserve one postgres.js connection per batch.`
    );
    assert.equal(
      [...source.matchAll(/batchSql\.release\(\);/g)].length,
      3,
      `${relativePath(generatedFile)} must release each reserved postgres.js connection.`
    );
    assert.doesNotMatch(
      source,
      /return Promise\.all\(promises\);/,
      `${relativePath(generatedFile)} must not use unbounded Promise.all.`
    );
    assert.doesNotMatch(
      source,
      /const promises = args\.map/,
      `${relativePath(generatedFile)} must not map the whole input to promises.`
    );
    assert.doesNotMatch(
      source,
      /error: unknown \| null/,
      `${relativePath(generatedFile)} must reject batch failures instead of hiding per-item errors.`
    );
  }
});

test("postgres batch generator template uses bounded helpers", () => {
  const source = readFileSync(postgresDriverTemplateFile, "utf8");
  assert.match(
    source,
    /function batchSupportDecls\(\): Node\[\]/,
    "postgres driver must generate shared batch support."
  );
  assert.match(
    source,
    /Promise\.allSettled\(/,
    "postgres driver must generate bounded chunk settling."
  );
  assert.match(
    source,
    /const batchSql = await sql\.reserve\(\);/,
    "postgres driver must reserve one connection for pipelined batch work."
  );
  assert.doesNotMatch(
    source,
    /return Promise\.all\(promises\);/,
    "postgres driver must not generate unbounded Promise.all."
  );
  assert.doesNotMatch(
    source,
    /const promises = args\.map/,
    "postgres driver must not generate whole-input promise maps."
  );
  assert.doesNotMatch(
    source,
    /error: unknown \| null/,
    "postgres driver must generate rejecting batch errors instead of per-item error results."
  );
  assert.match(
    source,
    /return `\(\{\n\s+\$\{properties\}\n\s+\}\)`;/,
    "postgres driver must generate parenthesized batch row object literals."
  );
});

test("generated postgres batch functions reserve one connection and reject failures", async () => {
  const { SqlcBatchError, batchListAuthorsByBio } = loadGeneratedModule(
    postgresGeneratedFiles[0],
    { postgres: { Sql: class Sql {} } }
  );
  const pending = [deferred(), deferred(), deferred()];
  const calls = [];
  let reserveCount = 0;
  let releaseCount = 0;
  const reservedSql = {
    unsafe(query, values) {
      const request = pending[calls.length];
      calls.push({ query, values });
      return { values: () => request.promise };
    },
    release() {
      releaseCount++;
    },
  };
  const sql = {
    reserve() {
      reserveCount++;
      return Promise.resolve(reservedSql);
    },
  };

  const resultPromise = batchListAuthorsByBio(
    sql,
    [{ bio: "a" }, { bio: "b" }, { bio: "c" }],
    { batchSize: 2 }
  );
  await flushAsync();

  assert.equal(reserveCount, 1);
  assert.equal(calls.length, 2, "postgres must only queue the first bounded chunk.");
  assert.deepEqual(
    calls.map((call) => Array.from(call.values)),
    [["a"], ["b"]]
  );

  pending[1].resolve([["2", "Bea", "b"]]);
  pending[0].resolve([["1", "Ann", "a"]]);
  await flushAsync();

  assert.equal(calls.length, 3, "postgres must queue the next chunk after settling.");
  assert.deepEqual(Array.from(calls[2].values), ["c"]);
  pending[2].resolve([["3", "Ada", "c"]]);

  const results = await resultPromise;
  assert.equal(releaseCount, 1);
  assert.deepEqual(
    Array.from(results, (result) => result.index),
    [0, 1, 2]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(results[0].rows)), [
    { id: "1", name: "Ann", bio: "a" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(results[2].rows)), [
    { id: "3", name: "Ada", bio: "c" },
  ]);

  const failed = [deferred(), deferred(), deferred()];
  const failedCalls = [];
  let failedReleaseCount = 0;
  const failedSql = {
    reserve() {
      return Promise.resolve({
        unsafe(query, values) {
          const request = failed[failedCalls.length];
          failedCalls.push({ query, values });
          return { values: () => request.promise };
        },
        release() {
          failedReleaseCount++;
        },
      });
    },
  };
  const failure = new Error("list failed");
  const failedPromise = batchListAuthorsByBio(
    failedSql,
    [{ bio: "a" }, { bio: "b" }, { bio: "c" }],
    { batchSize: 2 }
  );
  await flushAsync();
  assert.equal(failedCalls.length, 2);
  failed[0].resolve([["1", "Ann", "a"]]);
  failed[1].reject(failure);

  await assert.rejects(failedPromise, (error) => {
    assert.ok(error instanceof SqlcBatchError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].index, 1);
    assert.equal(error.errors[0].error, failure);
    assert.equal(failedCalls.length, 2, "postgres must not start a later chunk after failure.");
    assert.equal(failedReleaseCount, 1, "postgres must release on failure.");
    return true;
  });
});

test("generated postgres batch output type-checks with strict noUncheckedIndexedAccess", () => {
  assertTypeChecks("Generated postgres batch output", [
    ...postgresGeneratedFiles,
    batchUsageFile,
  ]);
});
