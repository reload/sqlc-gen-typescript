#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const postgresGeneratedFiles = [
  "examples/node-postgres/src/db/query_sql.ts",
  "examples/bun-postgres/src/db/query_sql.ts",
].map((path) => resolve(root, path));
const transactionUsageFile = resolve(root, "test-support/postgres-transaction-usage.ts");
const postgresDriverTemplateFile = resolve(root, "src/drivers/postgres.ts");
const tsc = resolve(root, "node_modules/.bin/tsc");

function relativePath(path) {
  return relative(root, path);
}

test("generated postgres queries accept transaction clients", () => {
  for (const generatedFile of postgresGeneratedFiles) {
    assert.ok(
      existsSync(generatedFile),
      `Missing generated postgres output: ${generatedFile}`
    );

    const source = readFileSync(generatedFile, "utf8");

    assert.match(
      source,
      /import type \{ Sql, TransactionSql \} from "postgres";/,
      `${relativePath(generatedFile)} must import postgres client types as type-only.`
    );
    assert.doesNotMatch(
      source,
      /type QuerySql = Pick<Sql, "unsafe">;/,
      `${relativePath(generatedFile)} must not emit a local QuerySql alias.`
    );
    assert.match(
      source,
      /export async function getAuthor\(sql: Sql \| TransactionSql, args: GetAuthorArgs\)/,
      `${relativePath(generatedFile)} must accept transaction-capable query clients.`
    );
  }
});

test("postgres driver template types regular queries as Sql or TransactionSql", () => {
  const source = readFileSync(postgresDriverTemplateFile, "utf8");

  assert.match(
    source,
    /factory\.createIdentifier\("TransactionSql"\)/,
    "postgres regular query parameters must allow TransactionSql."
  );
  assert.doesNotMatch(
    source,
    /factory\.createIdentifier\("QuerySql"\)|type QuerySql = Pick<Sql, "unsafe">;/,
    "postgres driver must emit explicit postgres.js client types instead of a local QuerySql alias."
  );
});

test("generated postgres query output type-checks with transaction clients", () => {
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
      ...postgresGeneratedFiles,
      transactionUsageFile,
    ],
    { cwd: root, encoding: "utf8" }
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    [
      "Generated postgres transaction output failed strict noUncheckedIndexedAccess type-check.",
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n")
  );
});
