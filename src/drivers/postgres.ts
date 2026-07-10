import {
  SyntaxKind,
  NodeFlags,
  Node,
  TypeNode,
  factory,
  FunctionDeclaration,
  createSourceFile,
  ScriptKind,
  ScriptTarget,
} from "typescript";

import { Parameter, Column, Query, Identifier } from "../gen/plugin/codegen_pb";
import { argName, colName } from "./utlis";
import { log } from "../logger";

function funcParamsDecl(iface: string | undefined, params: Parameter[]) {
  let funcParams = [
    factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier("sql"),
      undefined,
      factory.createUnionTypeNode([
        factory.createTypeReferenceNode(factory.createIdentifier("Sql"), undefined),
        factory.createTypeReferenceNode(factory.createIdentifier("TransactionSql"), undefined),
      ]),
      undefined
    ),
  ];

  if (iface && params.length > 0) {
    funcParams.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier("args"),
        undefined,
        factory.createTypeReferenceNode(
          factory.createIdentifier(iface),
          undefined
        ),
        undefined
      )
    );
  }

  return funcParams;
}

function sourceStatements(source: string): Node[] {
  return Array.from(
    createSourceFile(
      "batch.ts",
      source,
      ScriptTarget.Latest,
      false,
      ScriptKind.TS
    ).statements
  );
}

function batchFuncParamsDecl(argIface: string | undefined): string {
  return `sql: Sql, args: ${(argIface ?? "void")}[], options?: SqlcBatchOptions`;
}

function batchSupportDecls(): Node[] {
  return sourceStatements(`
/**
 * Options for generated batch queries.
 * batchSize bounds pipelined queries per reserved connection chunk; chunks run in input order.
 */
export interface SqlcBatchOptions {
    batchSize?: number;
}

export interface SqlcBatchErrorItem {
    index: number;
    error: unknown;
}

/**
 * Batch functions reject with this after the first failed chunk.
 * errors contain input indexes; later chunks are not started.
 */
export class SqlcBatchError extends Error {
    readonly errors: SqlcBatchErrorItem[];

    constructor(errors: SqlcBatchErrorItem[]) {
        super(\`Batch failed for \${errors.length} item(s)\`);
        this.name = "SqlcBatchError";
        this.errors = errors;
    }
}

function sqlcBatchSize(options: SqlcBatchOptions | undefined): number {
    const batchSize = options?.batchSize ?? 64;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new RangeError("batchSize must be a positive integer");
    }
    return batchSize;
}

async function sqlcRunBatched<TArg, TResult>(
    args: TArg[],
    options: SqlcBatchOptions | undefined,
    run: (arg: TArg, index: number) => Promise<TResult>
): Promise<TResult[]> {
    const batchSize = sqlcBatchSize(options);
    const results = new Array<TResult>(args.length);
    for (let start = 0; start < args.length; start += batchSize) {
        const chunk = args.slice(start, start + batchSize);
        const settled = await Promise.allSettled(
            chunk.map((arg, offset) => run(arg, start + offset))
        );
        const errors: SqlcBatchErrorItem[] = [];
        for (const [offset, result] of settled.entries()) {
            const index = start + offset;
            if (result.status === "fulfilled") {
                results[index] = result.value;
            } else {
                errors.push({ index, error: result.reason });
            }
        }
        if (errors.length > 0) {
            throw new SqlcBatchError(errors);
        }
    }
    return results;
}
`);
}

function valuesExpression(params: Parameter[]): string {
  if (params.length === 0) {
    return "[]";
  }
  return `[${params
    .map((param, i) => `arg.${argName(i, param.column)}`)
    .join(", ")}]`;
}

function rowExpression(columns: Column[]): string {
  if (columns.length === 0) {
    return "undefined";
  }
  const properties = columns
    .map((column, i) => `${colName(i, column)}: row[${i}]`)
    .join(",\n        ");
  return `({
        ${properties}
    })`;
}

function copyfromSupportDecls(): Node[] {
  return sourceStatements(String.raw`
type SqlcCopyFromEvent = "error" | "finish" | "close" | "drain";
type SqlcCopyFromListener = (error?: unknown) => void;
type SqlcCopyFromEncoder = (value: unknown) => string;

const sqlcCopyFromMaxChunkBytes = 65536;

interface SqlcCopyFromWritable {
    write(chunk: string, callback: (error?: Error | null) => void): boolean;
    end(callback: (error?: Error | null) => void): void;
    destroy?(error?: unknown): void;
    readonly writableFinished?: boolean;
    once?(event: SqlcCopyFromEvent, listener: SqlcCopyFromListener): SqlcCopyFromWritable;
    off?(event: SqlcCopyFromEvent, listener: SqlcCopyFromListener): SqlcCopyFromWritable;
    removeListener?(event: SqlcCopyFromEvent, listener: SqlcCopyFromListener): SqlcCopyFromWritable;
}

interface SqlcCopyFromQueuedWrite {
    canContinue: boolean;
    complete: Promise<void>;
    failed: Promise<void>;
}

interface SqlcCopyFromState {
    error?: Error;
    pendingWrites: Promise<void>[];
}

function sqlcCopyFromCreateState(): SqlcCopyFromState {
    return { pendingWrites: [] };
}

function sqlcCopyFromError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error ?? "COPY stream failed"));
}

function sqlcCopyFromRecordError(state: SqlcCopyFromState, error: unknown): void {
    state.error ??= sqlcCopyFromError(error);
}

function sqlcCopyFromThrowIfError(state: SqlcCopyFromState): void {
    if (state.error) {
        throw state.error;
    }
}

function sqlcCopyFromUnsupportedValue(value: unknown, expected = "null, string, number, boolean, bigint, Date, Uint8Array/Buffer, JSON-serializable values, and arrays for PostgreSQL array columns"): TypeError {
    const tag = Object.prototype.toString.call(value);
    return new TypeError(":copyfrom supports only " + expected + "; received " + tag);
}

function sqlcCopyFromScalar(value: unknown): string {
    switch (typeof value) {
        case "string":
            return value;
        case "number":
            return String(value);
        case "boolean":
            return value ? "true" : "false";
        case "bigint":
            return value.toString();
        case "object":
            if (value instanceof Date) {
                return value.toISOString();
            }
            throw sqlcCopyFromUnsupportedValue(value, "string, number, boolean, bigint, and Date values for scalar columns");
        default:
            throw sqlcCopyFromUnsupportedValue(value, "string, number, boolean, bigint, and Date values for scalar columns");
    }
}

function sqlcCopyFromBytea(value: unknown): string {
    let bytes: Uint8Array | undefined;
    if (typeof ArrayBuffer !== "undefined") {
        if (ArrayBuffer.isView(value)) {
            const view = value as ArrayBufferView;
            bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        } else if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
            bytes = new Uint8Array(value as ArrayBuffer);
        }
    }
    if (!bytes) {
        throw sqlcCopyFromUnsupportedValue(value, "Uint8Array or Buffer values for bytea columns");
    }

    let hex = "";
    for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        if (byte === undefined) {
            continue;
        }
        hex += byte.toString(16).padStart(2, "0");
    }
    return "\\x" + hex;
}

function sqlcCopyFromJson(value: unknown): string {
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    } catch {
        throw sqlcCopyFromUnsupportedValue(value, "JSON-serializable values for json/jsonb columns");
    }
    if (text === undefined) {
        throw sqlcCopyFromUnsupportedValue(value, "JSON-serializable values for json/jsonb columns");
    }
    return text;
}

function sqlcCopyFromArrayEncoder(elementEncoder: SqlcCopyFromEncoder, dimensions: number): SqlcCopyFromEncoder {
    return (value: unknown) => sqlcCopyFromArray(value, elementEncoder, dimensions);
}

function sqlcCopyFromArray(value: unknown, elementEncoder: SqlcCopyFromEncoder, dimensions: number): string {
    if (!Array.isArray(value)) {
        throw sqlcCopyFromUnsupportedValue(value, "arrays for PostgreSQL array columns");
    }
    const nestedDimensions = dimensions - 1;
    return "{" + value.map((element) => {
        if (element === null || element === undefined) {
            return "NULL";
        }
        if (nestedDimensions > 0) {
            return sqlcCopyFromArray(element, elementEncoder, nestedDimensions);
        }
        return sqlcCopyFromArrayElement(elementEncoder(element));
    }).join(",") + "}";
}

function sqlcCopyFromArrayElement(value: string): string {
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '"';
}

function sqlcCopyFromValue(value: unknown, encoder: SqlcCopyFromEncoder): string {
    if (value === null || value === undefined) {
        return "\\N";
    }
    return encoder(value)
        .replace(/\\/g, "\\\\")
        .replace(/\t/g, "\\t")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
}

function sqlcCopyFromRow(values: unknown[], encoders: SqlcCopyFromEncoder[]): string {
    if (values.length !== encoders.length) {
        throw new Error(":copyfrom row has " + values.length + " values, expected " + encoders.length);
    }
    return values.map((value, index) => {
        const encoder = encoders[index];
        if (!encoder) {
            throw new Error(":copyfrom row is missing encoder for column " + index);
        }
        return sqlcCopyFromValue(value, encoder);
    }).join("\t") + "\n";
}

function sqlcCopyFromQueueWrite(stream: SqlcCopyFromWritable, state: SqlcCopyFromState, chunk: string): SqlcCopyFromQueuedWrite {
    let canContinue = true;
    let notifyFailed!: () => void;
    const failed = new Promise<void>((resolve) => {
        notifyFailed = resolve;
    });
    const complete = new Promise<void>((resolve) => {
        const finish = (error?: unknown) => {
            if (error) {
                sqlcCopyFromRecordError(state, error);
                notifyFailed();
            }
            resolve();
        };
        try {
            canContinue = stream.write(chunk, (error?: Error | null) => finish(error ?? undefined)) !== false;
        } catch (error) {
            canContinue = false;
            finish(error);
        }
    });
    state.pendingWrites.push(complete);
    return { canContinue, complete, failed };
}

async function sqlcCopyFromWrite(stream: SqlcCopyFromWritable, state: SqlcCopyFromState, chunk: string): Promise<void> {
    if (chunk.length === 0) {
        return;
    }
    sqlcCopyFromThrowIfError(state);
    const queuedWrite = sqlcCopyFromQueueWrite(stream, state, chunk);
    sqlcCopyFromThrowIfError(state);
    if (!queuedWrite.canContinue) {
        await sqlcCopyFromDrain(stream, state, queuedWrite);
    }
    sqlcCopyFromThrowIfError(state);
}

async function sqlcCopyFromDrain(stream: SqlcCopyFromWritable, state: SqlcCopyFromState, queuedWrite: SqlcCopyFromQueuedWrite): Promise<void> {
    if (typeof stream.once !== "function") {
        await queuedWrite.complete;
        sqlcCopyFromThrowIfError(state);
        return;
    }
    await Promise.race([
        queuedWrite.failed.then(() => sqlcCopyFromThrowIfError(state)),
        new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            stream.off?.("drain", onDrain) ?? stream.removeListener?.("drain", onDrain);
            stream.off?.("error", onError) ?? stream.removeListener?.("error", onError);
            stream.off?.("close", onClose) ?? stream.removeListener?.("close", onClose);
        };
        const settle = (complete: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            complete();
        };
        const onDrain = () => settle(() => resolve());
        const onError = (error?: unknown) => settle(() => {
            sqlcCopyFromRecordError(state, error);
            reject(state.error);
        });
        const onClose = () => {
            if (stream.writableFinished === true) {
                onDrain();
                return;
            }
            onError(new Error("COPY stream closed before drain"));
        };
        stream.once?.("drain", onDrain);
        stream.once?.("error", onError);
        stream.once?.("close", onClose);
        }),
    ]);
    sqlcCopyFromThrowIfError(state);
}

async function sqlcCopyFromFlushWrites(state: SqlcCopyFromState): Promise<void> {
    while (state.pendingWrites.length > 0) {
        const pendingWrites = state.pendingWrites;
        state.pendingWrites = [];
        await Promise.all(pendingWrites);
    }
    sqlcCopyFromThrowIfError(state);
}

async function sqlcCopyFromEnd(stream: SqlcCopyFromWritable): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const hasCompletionEvents = typeof stream.once === "function";
        const cleanup = () => {
            stream.off?.("error", onError) ?? stream.removeListener?.("error", onError);
            stream.off?.("finish", onFinish) ?? stream.removeListener?.("finish", onFinish);
            stream.off?.("close", onClose) ?? stream.removeListener?.("close", onClose);
        };
        const settle = (complete: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            complete();
        };
        const onError = (error?: unknown) => settle(() => reject(sqlcCopyFromError(error)));
        const onFinish = () => settle(() => resolve());
        const onClose = () => {
            if (stream.writableFinished === true) {
                onFinish();
                return;
            }
            onError(new Error("COPY stream closed before finish"));
        };

        if (hasCompletionEvents) {
            stream.once?.("error", onError);
            stream.once?.("finish", onFinish);
            stream.once?.("close", onClose);
        }

        stream.end((error?: Error | null) => {
            if (error) {
                onError(error);
                return;
            }
            if (!hasCompletionEvents || stream.writableFinished !== false) {
                onFinish();
            }
        });
    });
}
`);
}

function copyfromIdent(name: string): string {
  return `"${name.replace(/"/g, `""`)}"`;
}

function copyfromTableName(table: Identifier | undefined): string {
  if (!table?.name) {
    throw new Error(":copyfrom requires an INSERT INTO table");
  }
  const parts = [table.schema, table.name].filter((part) => part.length > 0);
  return parts.map(copyfromIdent).join(".");
}

function copyfromColumnName(param: Parameter, index: number): string {
  return param.column?.originalName || param.column?.name || argName(index, param.column);
}

function copyfromSql(table: Identifier | undefined, params: Parameter[]): string {
  const columnNames = params.map(copyfromColumnName).map(copyfromIdent).join(", ");
  return `COPY ${copyfromTableName(table)} (${columnNames}) FROM STDIN`;
}

function copyfromColumnTypeName(column: Column | undefined): string {
  let typeName = column?.type?.name ?? "";
  const pgCatalog = "pg_catalog.";
  if (typeName.startsWith(pgCatalog)) {
    typeName = typeName.slice(pgCatalog.length);
  }
  if (typeName.startsWith("_")) {
    typeName = typeName.slice(1);
  }
  return typeName;
}

function copyfromArrayDimensions(column: Column | undefined): number {
  if (!column?.isArray && !column?.arrayDims) {
    return 0;
  }
  return Math.max(column.arrayDims || 1, 1);
}

function copyfromScalarEncoderExpression(column: Column | undefined): string {
  switch (copyfromColumnTypeName(column)) {
    case "bytea":
      return "sqlcCopyFromBytea";
    case "json":
    case "jsonb":
      return "sqlcCopyFromJson";
    default:
      return "sqlcCopyFromScalar";
  }
}

function copyfromEncoderExpression(param: Parameter): string {
  const scalarEncoder = copyfromScalarEncoderExpression(param.column);
  const dimensions = copyfromArrayDimensions(param.column);
  if (dimensions === 0) {
    return scalarEncoder;
  }
  return `sqlcCopyFromArrayEncoder(${scalarEncoder}, ${dimensions})`;
}

function copyfromEncodersExpression(params: Parameter[]): string {
  if (params.length === 0) {
    return "[]";
  }
  return `[${params.map(copyfromEncoderExpression).join(", ")}]`;
}

export class Driver {
  columnType(column?: Column): TypeNode {
    if (column === undefined || column.type === undefined) {
      return factory.createKeywordTypeNode(SyntaxKind.AnyKeyword);
    }
    // Some of the type names have the `pgcatalog.` prefix. Remove this.
    let typeName = column.type.name;
    const pgCatalog = "pg_catalog.";
    if (typeName.startsWith(pgCatalog)) {
      typeName = typeName.slice(pgCatalog.length);
    }
    let typ: TypeNode = factory.createKeywordTypeNode(SyntaxKind.StringKeyword);
    switch (typeName) {
      case "aclitem": {
        // string
        break;
      }
      case "bigserial": {
        // string
        break;
      }
      case "bit": {
        // string
        break;
      }
      case "bool": {
        typ = factory.createKeywordTypeNode(SyntaxKind.BooleanKeyword);
        break;
      }
      case "box": {
        // string
        break;
      }
      case "bpchar": {
        // string
        break;
      }
      case "bytea": {
        // TODO: Is this correct or node-specific?
        typ = factory.createTypeReferenceNode(
          factory.createIdentifier("Buffer"),
          undefined
        );
        break;
      }
      case "cid": {
        // string
        break;
      }
      case "cidr": {
        // string
        break;
      }
      case "circle": {
        // string
        break;
      }
      case "date": {
        typ = factory.createTypeReferenceNode(
          factory.createIdentifier("Date"),
          undefined
        );
        break;
      }
      case "float4": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "float8": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "inet": {
        // string
        break;
      }
      case "int2": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "int4": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "int8": {
        // string
        break;
      }
      case "interval": {
        // string
        break;
      }
      case "json": {
        typ = factory.createKeywordTypeNode(SyntaxKind.AnyKeyword);
        break;
      }
      case "jsonb": {
        typ = factory.createKeywordTypeNode(SyntaxKind.AnyKeyword);
        break;
      }
      case "line": {
        // string
        break;
      }
      case "lseg": {
        // string
        break;
      }
      case "madaddr": {
        // string
        break;
      }
      case "madaddr8": {
        // string
        break;
      }
      case "money": {
        // string
        break;
      }
      case "oid": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "path": {
        // string
        break;
      }
      case "pg_node_tree": {
        // string
        break;
      }
      case "pg_snapshot": {
        // string
        break;
      }
      case "point": {
        // string
        break;
      }
      case "polygon": {
        // string
        break;
      }
      case "regproc": {
        // string
        break;
      }
      case "regrole": {
        // string
        break;
      }
      case "serial": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "serial2": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "serial4": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "serial8": {
        // string
        break;
      }
      case "smallserial": {
        typ = factory.createKeywordTypeNode(SyntaxKind.NumberKeyword);
        break;
      }
      case "tid": {
        // string
        break;
      }
      case "text": {
        // string
        break;
      }
      case "time": {
        // string
        break;
      }
      case "timetz": {
        // string
        break;
      }
      case "timestamp": {
        typ = factory.createTypeReferenceNode(
          factory.createIdentifier("Date"),
          undefined
        );
        break;
      }
      case "timestamptz": {
        typ = factory.createTypeReferenceNode(
          factory.createIdentifier("Date"),
          undefined
        );
        break;
      }
      case "tsquery": {
        // string
        break;
      }
      case "tsvector": {
        // string
        break;
      }
      case "txid_snapshot": {
        // string
        break;
      }
      case "uuid": {
        // string
        break;
      }
      case "varbit": {
        // string
        break;
      }
      case "varchar": {
        // string
        break;
      }
      case "xid": {
        // string
        break;
      }
      case "xml": {
        // string
        break;
      }
      default: {
        log(`unknown type ${column.type?.name}`);
        break;
      }
    }
    if (column.isArray || column.arrayDims > 0) {
      let dims = Math.max(column.arrayDims || 1);
      for (let i = 0; i < dims; i++) {
        typ = factory.createArrayTypeNode(typ);
      }
    }
    if (column.notNull) {
      return typ;
    }
    return factory.createUnionTypeNode([
      typ,
      factory.createLiteralTypeNode(factory.createNull()),
    ]);
  }

  preamble(queries: Query[]) {
    const hasBatch = queries.some((query) => query.cmd.startsWith(":batch"));
    const hasTransactionCompatibleQueries = queries.some((query) => !query.cmd.startsWith(":batch"));
    const importSpecifiers = [
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier("Sql")
      ),
    ];

    if (hasTransactionCompatibleQueries) {
      importSpecifiers.push(
        factory.createImportSpecifier(
          false,
          undefined,
          factory.createIdentifier("TransactionSql")
        )
      );
    }

    const imports: Node[] = [
      factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
          true,
          undefined,
          factory.createNamedImports(importSpecifiers)
        ),
        factory.createStringLiteral("postgres"),
        undefined
      ),
    ];

    if (queries.some((query) => query.cmd === ":copyfrom")) {
      imports.push(...copyfromSupportDecls());
    }

    if (hasBatch) {
      imports.push(...batchSupportDecls());
    }

    return imports;
  }

  execDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    params: Parameter[]
  ) {
    const funcParams = funcParamsDecl(argIface, params);

    return factory.createFunctionDeclaration(
      [
        factory.createToken(SyntaxKind.ExportKeyword),
        factory.createToken(SyntaxKind.AsyncKeyword),
      ],
      undefined,
      factory.createIdentifier(funcName),
      undefined,
      funcParams,
      factory.createTypeReferenceNode(factory.createIdentifier("Promise"), [
        factory.createKeywordTypeNode(SyntaxKind.VoidKeyword),
      ]),
      factory.createBlock(
        [
          factory.createExpressionStatement(
            factory.createAwaitExpression(
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier("sql"),
                  factory.createIdentifier("unsafe")
                ),
                undefined,
                [
                  factory.createIdentifier(queryName),
                  factory.createArrayLiteralExpression(
                    params.map((param, i) =>
                      factory.createPropertyAccessExpression(
                        factory.createIdentifier("args"),
                        factory.createIdentifier(argName(i, param.column))
                      )
                    ),
                    false
                  ),
                ]
              )
            )
          ),
        ],
        true
      )
    );
  }

  manyDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    params: Parameter[],
    columns: Column[]
  ) {
    const funcParams = funcParamsDecl(argIface, params);

    return factory.createFunctionDeclaration(
      [
        factory.createToken(SyntaxKind.ExportKeyword),
        factory.createToken(SyntaxKind.AsyncKeyword),
      ],
      undefined,
      factory.createIdentifier(funcName),
      undefined,
      funcParams,
      factory.createTypeReferenceNode(factory.createIdentifier("Promise"), [
        factory.createArrayTypeNode(
          factory.createTypeReferenceNode(
            factory.createIdentifier(returnIface),
            undefined
          )
        ),
      ]),
      factory.createBlock(
        [
          factory.createReturnStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createAwaitExpression(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createCallExpression(
                        factory.createPropertyAccessExpression(
                          factory.createIdentifier("sql"),
                          factory.createIdentifier("unsafe")
                        ),
                        undefined,
                        [
                          factory.createIdentifier(queryName),
                          factory.createArrayLiteralExpression(
                            params.map((param, i) =>
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("args"),
                                factory.createIdentifier(
                                  argName(i, param.column)
                                )
                              )
                            ),
                            false
                          ),
                        ]
                      ),
                      factory.createIdentifier("values")
                    ),
                    undefined,
                    undefined
                  )
                ),
                factory.createIdentifier("map")
              ),
              undefined,
              [
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [
                    factory.createParameterDeclaration(
                      undefined,
                      undefined,
                      "row"
                    ),
                  ],
                  undefined,
                  factory.createToken(SyntaxKind.EqualsGreaterThanToken),
                  factory.createObjectLiteralExpression(
                    columns.map((col, i) =>
                      factory.createPropertyAssignment(
                        factory.createIdentifier(colName(i, col)),
                        factory.createElementAccessExpression(
                          factory.createIdentifier("row"),
                          factory.createNumericLiteral(`${i}`)
                        )
                      )
                    ),
                    true
                  )
                ),
              ]
            )
          ),
        ],
        true
      )
    );
  }

  oneDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    params: Parameter[],
    columns: Column[]
  ) {
    const funcParams = funcParamsDecl(argIface, params);

    return factory.createFunctionDeclaration(
      [
        factory.createToken(SyntaxKind.ExportKeyword),
        factory.createToken(SyntaxKind.AsyncKeyword),
      ],
      undefined,
      factory.createIdentifier(funcName),
      undefined,
      funcParams,
      factory.createTypeReferenceNode(factory.createIdentifier("Promise"), [
        factory.createUnionTypeNode([
          factory.createTypeReferenceNode(
            factory.createIdentifier(returnIface),
            undefined
          ),
          factory.createLiteralTypeNode(factory.createNull()),
        ]),
      ]),
      factory.createBlock(
        [
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createIdentifier("rows"),
                  undefined,
                  undefined,
                  factory.createAwaitExpression(
                    factory.createCallExpression(
                      factory.createPropertyAccessExpression(
                        factory.createCallExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier("sql"),
                            factory.createIdentifier("unsafe")
                          ),
                          undefined,
                          [
                            factory.createIdentifier(queryName),
                            factory.createArrayLiteralExpression(
                              params.map((param, i) =>
                                factory.createPropertyAccessExpression(
                                  factory.createIdentifier("args"),
                                  factory.createIdentifier(
                                    argName(i, param.column)
                                  )
                                )
                              ),
                              false
                            ),
                          ]
                        ),
                        factory.createIdentifier("values")
                      ),
                      undefined,
                      undefined
                    )
                  )
                ),
              ],
              NodeFlags.Const |
                // ts.NodeFlags.Constant |
                NodeFlags.AwaitContext |
                // ts.NodeFlags.Constant |
                NodeFlags.ContextFlags |
                NodeFlags.TypeExcludesFlags
            )
          ),
          factory.createIfStatement(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("rows"),
                factory.createIdentifier("length")
              ),
              factory.createToken(SyntaxKind.ExclamationEqualsEqualsToken),
              factory.createNumericLiteral("1")
            ),
            factory.createBlock(
              [factory.createReturnStatement(factory.createNull())],
              true
            ),
            undefined
          ),
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  "row",
                  undefined,
                  undefined,
                  factory.createElementAccessExpression(
                    factory.createIdentifier("rows"),
                    factory.createNumericLiteral("0")
                  )
                ),
              ],
              NodeFlags.Const
            )
          ),
          factory.createIfStatement(
            factory.createPrefixUnaryExpression(
              SyntaxKind.ExclamationToken,
              factory.createIdentifier("row")
            ),
            factory.createBlock(
              [factory.createReturnStatement(factory.createNull())],
              true
            ),
            undefined
          ),
          factory.createReturnStatement(
            factory.createObjectLiteralExpression(
              columns.map((col, i) =>
                factory.createPropertyAssignment(
                  factory.createIdentifier(colName(i, col)),
                  factory.createElementAccessExpression(
                    factory.createIdentifier("row"),
                    factory.createNumericLiteral(`${i}`)
                  )
                )
              ),
              true
            )
          ),
        ],
        true
      )
    );
  }

  batchexecDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    resultIface: string,
    params: Parameter[]
  ): Node[] {
    return sourceStatements(`
export interface ${resultIface} {
    index: number;
}

export async function ${funcName}(${batchFuncParamsDecl(argIface)}): Promise<${resultIface}[]> {
    const batchSql = await sql.reserve();
    try {
        return await sqlcRunBatched(args, options, async (arg, index): Promise<${resultIface}> => {
            await batchSql.unsafe(${queryName}, ${valuesExpression(params)});
            return { index };
        });
    } finally {
        batchSql.release();
    }
}
`);
  }

  batchmanyDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    resultIface: string,
    params: Parameter[],
    columns: Column[]
  ): Node[] {
    return sourceStatements(`
export interface ${resultIface} {
    index: number;
    rows: ${returnIface}[];
}

export async function ${funcName}(${batchFuncParamsDecl(argIface)}): Promise<${resultIface}[]> {
    const batchSql = await sql.reserve();
    try {
        return await sqlcRunBatched(args, options, async (arg, index): Promise<${resultIface}> => {
            const rows = await batchSql.unsafe(${queryName}, ${valuesExpression(params)}).values();
            return {
                index,
                rows: rows.map(row => ${rowExpression(columns)})
            };
        });
    } finally {
        batchSql.release();
    }
}
`);
  }

  batchoneDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    resultIface: string,
    params: Parameter[],
    columns: Column[]
  ): Node[] {
    return sourceStatements(`
export interface ${resultIface} {
    index: number;
    row: ${returnIface} | null;
}

export async function ${funcName}(${batchFuncParamsDecl(argIface)}): Promise<${resultIface}[]> {
    const batchSql = await sql.reserve();
    try {
        return await sqlcRunBatched(args, options, async (arg, index): Promise<${resultIface}> => {
            const rows = await batchSql.unsafe(${queryName}, ${valuesExpression(params)}).values();
            if (rows.length !== 1) {
                return { index, row: null };
            }
            const row = rows[0];
            if (!row) {
                return { index, row: null };
            }
            return {
                index,
                row: ${rowExpression(columns)}
            };
        });
    } finally {
        batchSql.release();
    }
}
`);
  }

  copyfromDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    params: Parameter[],
    table: Identifier | undefined
  ): Node[] {
    return sourceStatements(`
export async function ${funcName}(sql: Sql | TransactionSql, args: ${(argIface ?? "void")}[]): Promise<number> {
    const copyStream = await sql.unsafe(${JSON.stringify(copyfromSql(table, params))}).writable() as SqlcCopyFromWritable;
    const copyStreamState = sqlcCopyFromCreateState();
    const copyEncoders: SqlcCopyFromEncoder[] = ${copyfromEncodersExpression(params)};
    const onCopyStreamError = (error?: unknown) => {
        sqlcCopyFromRecordError(copyStreamState, error);
    };
    copyStream.once?.("error", onCopyStreamError);
    try {
        let copyRowBatch = "";
        for (const arg of args) {
            sqlcCopyFromThrowIfError(copyStreamState);
            const copyRow = sqlcCopyFromRow(${valuesExpression(params)}, copyEncoders);
            if (copyRowBatch.length > 0 && copyRowBatch.length + copyRow.length > sqlcCopyFromMaxChunkBytes) {
                await sqlcCopyFromWrite(copyStream, copyStreamState, copyRowBatch);
                copyRowBatch = "";
            }
            copyRowBatch += copyRow;
        }
        await sqlcCopyFromWrite(copyStream, copyStreamState, copyRowBatch);
        await sqlcCopyFromFlushWrites(copyStreamState);
        await sqlcCopyFromEnd(copyStream);
        sqlcCopyFromThrowIfError(copyStreamState);
        return args.length;
    } catch (error) {
        copyStream.destroy?.(error);
        throw error;
    } finally {
        copyStream.off?.("error", onCopyStreamError) ?? copyStream.removeListener?.("error", onCopyStreamError);
    }
}
`);
  }

  execlastidDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    params: Parameter[]
  ): FunctionDeclaration {
    throw new Error("postgres driver currently does not support :execlastid");
  }
}
