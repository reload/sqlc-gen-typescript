import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import ts from "typescript";

export { ts };

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pgGeneratedFiles = [
  "examples/node-pg/src/db/query_sql.ts",
  "examples/bun-pg/src/db/query_sql.ts",
].map((path) => resolve(root, path));
export const postgresGeneratedFiles = [
  "examples/node-postgres/src/db/query_sql.ts",
  "examples/bun-postgres/src/db/query_sql.ts",
].map((path) => resolve(root, path));
export const batchUsageFile = resolve(root, "test-support/pg-batch-usage.ts");
export const pgUnsupportedBatchUsageFile = resolve(
  root,
  "test-support/pg-unsupported-batch-usage.ts"
);
export const copyfromUsageFile = resolve(
  root,
  "test-support/postgres-copyfrom-usage.ts"
);
export const transactionUsageFile = resolve(
  root,
  "test-support/postgres-transaction-usage.ts"
);
export const pgUnsupportedCopyfromUsageFile = resolve(
  root,
  "test-support/pg-unsupported-copyfrom-usage.ts"
);
export const pgDriverTemplateFile = resolve(root, "src/drivers/pg.ts");
export const postgresDriverTemplateFile = resolve(root, "src/drivers/postgres.ts");
export const copyfromValidationFile = resolve(root, "src/copyfrom-validation.ts");
export const appFile = resolve(root, "src/app.ts");

const tsc = resolve(root, "node_modules/.bin/tsc");
const nodeRequire = createRequire(import.meta.url);

export function relativePath(path) {
  return relative(root, path);
}

export function loadGeneratedModule(generatedFile, requireMap = {}, footer = "") {
  const source = readFileSync(generatedFile, "utf8") + footer;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  const context = createContext({
    module,
    exports: module.exports,
    Date,
    Error,
    TypeError,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      if (specifier.startsWith("node:")) {
        return nodeRequire(specifier);
      }
      throw new Error(`Unexpected require: ${specifier}`);
    },
  });
  new Script(outputText, { filename: generatedFile }).runInContext(context);
  return module.exports;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

export function loadCopyfromTestHelpers() {
  return loadGeneratedModule(
    postgresGeneratedFiles[0],
    { postgres: { Sql: class Sql {} } },
    `
export const __copyfromTest = {
  sqlcCopyFromValue,
  sqlcCopyFromRow,
  sqlcCopyFromScalar,
  sqlcCopyFromBytea,
  sqlcCopyFromJson,
  sqlcCopyFromArrayEncoder,
};
`
  ).__copyfromTest;
}

export function printTsNodes(nodes) {
  const resultFile = ts.createSourceFile(
    "file.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return nodes.map((node) => printer.printNode(ts.EmitHint.Unspecified, node, resultFile)).join("\n\n");
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
    [
      `${label} failed strict noUncheckedIndexedAccess type-check.`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n")
  );
}
