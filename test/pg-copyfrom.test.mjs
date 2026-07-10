#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import {
  assertTypeChecks,
  loadGeneratedModule,
  pgDriverTemplateFile,
  pgGeneratedFiles,
  pgUnsupportedCopyfromUsageFile,
  relativePath,
} from "../test-support/driver-test-helpers.mjs";

test("generated pg copyfrom queries fail with an unsupported-driver error", async () => {
  for (const generatedFile of pgGeneratedFiles) {
    assert.ok(
      existsSync(generatedFile),
      `Missing generated pg output: ${generatedFile}`
    );

    const source = readFileSync(generatedFile, "utf8");

    assert.match(
      source,
      /class SqlcCopyFromUnsupportedError extends Error/,
      `${relativePath(generatedFile)} must expose an explicit unsupported copyfrom error.`
    );
    assert.match(
      source,
      /use the postgres driver for :copyfrom annotations/,
      `${relativePath(generatedFile)} must point copyfrom users to the supported driver.`
    );
    assert.match(
      source,
      /throw new SqlcCopyFromUnsupportedError\(":copyfrom"\);/,
      `${relativePath(generatedFile)} must reject generated pg copyfrom functions.`
    );
  }

  const { SqlcCopyFromUnsupportedError, copyAuthors } = loadGeneratedModule(
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
    copyAuthors(client, [{ name: "Ann", bio: null }]),
    (error) => {
      assert.ok(error instanceof SqlcCopyFromUnsupportedError);
      assert.equal(error.driver, "pg");
      assert.equal(error.command, ":copyfrom");
      assert.equal(calls.length, 0, "pg must not send queries for unsupported copyfrom annotations.");
      return true;
    }
  );
});

test("pg copyfrom generator template rejects unsupported copyfrom annotations", () => {
  const source = readFileSync(pgDriverTemplateFile, "utf8");
  assert.match(
    source,
    /function copyfromUnsupportedDecls\(\): Node\[\]/,
    "pg driver must generate explicit unsupported copyfrom support."
  );
  assert.match(
    source,
    /SqlcCopyFromUnsupportedError/,
    "pg driver must expose a generated unsupported-driver copyfrom error."
  );
  assert.match(
    source,
    /use the postgres driver for :copyfrom annotations/,
    "pg driver must direct copyfrom users to the postgres driver."
  );
  assert.match(
    source,
    /throw new SqlcCopyFromUnsupportedError\(":copyfrom"\);/,
    "pg driver must reject copyfrom annotations."
  );
});

test("generated pg copyfrom output type-checks with strict noUncheckedIndexedAccess", () => {
  assertTypeChecks("Generated pg copyfrom output", [
    ...pgGeneratedFiles,
    pgUnsupportedCopyfromUsageFile,
  ]);
});
