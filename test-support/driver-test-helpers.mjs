import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pgGeneratedFiles = [
  "examples/node-pg/src/db/query_sql.ts",
  "examples/bun-pg/src/db/query_sql.ts",
].map((path) => resolve(root, path));

const tsc = resolve(root, "node_modules/.bin/tsc");

export function relativePath(path) {
  return relative(root, path);
}

export function assertTypeChecks(label, files) {
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
      ...files,
    ],
    { cwd: root, encoding: "utf8" }
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    [`${label} failed strict noUncheckedIndexedAccess type-check.`, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
  );
}
