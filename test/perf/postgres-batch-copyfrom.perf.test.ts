import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  batchCreateAuthor,
  batchDeleteAuthor,
  batchListAuthorsByBio,
  copyAuthors,
  createAuthor,
  deleteAuthor,
} from "../../examples/node-postgres/src/db/query_sql";
import { databaseUrl, resetAuthors } from "../integration/postgres-db";

type AuthorInput = { name: string; bio: string | null };
type AuthorRow = { id: string; name: string; bio: string | null };
type AuthorState = { count: number; checksum: string };
type Measurement = {
  scenario: string;
  strategy: string;
  items: number;
  milliseconds: number;
  itemsPerSecond: number;
};

type QueryResult = Promise<unknown> & {
  values?: () => Promise<unknown[][]>;
};

const enabled = Boolean(process.env["SQLC_PERF"] && databaseUrl);
const describePerf = enabled ? describe.sequential : describe.skip;

describePerf("postgres :batch and :copyfrom performance", () => {
  const sql = postgres(databaseUrl ?? "", { max: 16, onnotice: () => undefined });

  beforeAll(async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS authors (
        id BIGSERIAL PRIMARY KEY,
        name text NOT NULL,
        bio text
      )
    `);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("bulk insert strategies reach the same table state", async () => {
    const rows = authorRows(2_000, "bulk-insert");
    const expectedState = expectedAuthorState(rows.map((row, index) => ({ id: String(index + 1), ...row })));
    const results: Measurement[] = [];

    results.push(
      await measureInsert(sql, "bulk insert 2,000 authors", "generated copyAuthors", rows, expectedState, async () => {
        const copied = await copyAuthors(sql, rows);
        expect(copied).toBe(rows.length);
      })
    );

    results.push(
      await measureInsert(sql, "bulk insert 2,000 authors", "raw multi-row INSERT chunk=1000", rows, expectedState, async () => {
        await rawInsertAuthors(sql, rows, 1_000);
      })
    );

    results.push(
      await measureInsert(sql, "bulk insert 2,000 authors", "generated createAuthor sequential", rows, expectedState, async () => {
        for (const row of rows) {
          const inserted = await createAuthor(sql, row);
          expect(inserted).not.toBeNull();
        }
      })
    );

    console.info(JSON.stringify({ benchmark: "bulk insert equivalent final state", results }, null, 2));
  }, 60_000);

  test("batchCreateAuthor helps repeated INSERT RETURNING under per-query latency", async () => {
    const latencyMs = 5;
    const rows = authorRows(500, "batch-create-latency");
    const delayedSql = sqlWithPerQueryLatency(sql, latencyMs);
    const expectedState = expectedAuthorState(rows.map((row, index) => ({ id: String(index + 1), ...row })));
    const results: Measurement[] = [];

    results.push(
      await measureInsert(sql, `500 INSERT RETURNING calls with ${latencyMs}ms per-query latency`, "generated batchCreateAuthor batchSize=64", rows, expectedState, async () => {
        const inserted = await batchCreateAuthor(delayedSql, rows, { batchSize: 64 });
        expect(inserted).toHaveLength(rows.length);
      })
    );

    results.push(
      await measureInsert(sql, `500 INSERT RETURNING calls with ${latencyMs}ms per-query latency`, "generated createAuthor pipelined=64", rows, expectedState, async () => {
        await runGeneratedCreateAuthorPipelined(delayedSql, rows, 64);
      })
    );

    results.push(
      await measureInsert(sql, `500 INSERT RETURNING calls with ${latencyMs}ms per-query latency`, "generated createAuthor sequential", rows, expectedState, async () => {
        for (const row of rows) {
          const inserted = await createAuthor(delayedSql, row);
          expect(inserted).not.toBeNull();
        }
      })
    );

    console.info(JSON.stringify({ benchmark: "batchone repeated insert returning under latency", latencyMs, results }, null, 2));
  }, 60_000);

  test("batchDeleteAuthor helps repeated per-row commands under per-query latency", async () => {
    const latencyMs = 5;
    const rows = authorRows(1_000, "batch-delete-latency");
    const deleteIds = Array.from({ length: rows.length / 2 }, (_, index) => String(index * 2 + 1));
    const deleted = new Set(deleteIds);
    const delayedSql = sqlWithPerQueryLatency(sql, latencyMs);
    const expectedState = expectedAuthorState(
      rows.flatMap((row, index) => {
        const id = String(index + 1);
        return deleted.has(id) ? [] : [{ id, ...row }];
      })
    );
    const results: Measurement[] = [];

    results.push(
      await measureDelete(sql, `500 DELETE calls with ${latencyMs}ms per-query latency`, "generated batchDeleteAuthor batchSize=64", rows, deleteIds, expectedState, async () => {
        const deletedRows = await batchDeleteAuthor(delayedSql, deleteIds.map((id) => ({ id })), { batchSize: 64 });
        expect(deletedRows).toHaveLength(deleteIds.length);
      })
    );

    results.push(
      await measureDelete(sql, `500 DELETE calls with ${latencyMs}ms per-query latency`, "generated deleteAuthor pipelined=64", rows, deleteIds, expectedState, async () => {
        await runGeneratedDeleteAuthorPipelined(delayedSql, deleteIds, 64);
      })
    );

    results.push(
      await measureDelete(sql, `500 DELETE calls with ${latencyMs}ms per-query latency`, "generated deleteAuthor sequential", rows, deleteIds, expectedState, async () => {
        for (const id of deleteIds) {
          await deleteAuthor(delayedSql, { id });
        }
      })
    );

    console.info(JSON.stringify({ benchmark: "batchexec repeated command under latency", latencyMs, results }, null, 2));
  }, 60_000);

  test("batchListAuthorsByBio helps repeated keyed lookups under per-query latency", async () => {
    const latencyMs = 5;
    const rows = authorRows(5_000, "batch-list-latency");
    const bios = Array.from({ length: 250 }, (_, index) => `bio-${index % 10}`);
    const delayedSql = sqlWithPerQueryLatency(sql, latencyMs);
    await resetAuthors(sql);
    await rawInsertAuthors(sql, rows, 1_000);

    const expectedRows = (await Promise.all(bios.map((bio) => listAuthorsByBioOnce(sql, bio)))).flat();
    const expectedChecksum = authorRowsChecksum(expectedRows);
    const results: Measurement[] = [];

    results.push(
      await measureSelect(`250 keyed SELECT calls with ${latencyMs}ms per-query latency`, "generated batchListAuthorsByBio batchSize=64", bios.length, expectedRows.length, expectedChecksum, async () => {
        const result = await batchListAuthorsByBio(delayedSql, bios.map((bio) => ({ bio })), { batchSize: 64 });
        return result.flatMap((item) => item.rows);
      })
    );

    results.push(
      await measureSelect(`250 keyed SELECT calls with ${latencyMs}ms per-query latency`, "same SELECT pipelined=64 without batch annotation", bios.length, expectedRows.length, expectedChecksum, async () => {
        return runListAuthorsByBioPipelined(delayedSql, bios, 64);
      })
    );

    results.push(
      await measureSelect(`250 keyed SELECT calls with ${latencyMs}ms per-query latency`, "same SELECT sequential without batch annotation", bios.length, expectedRows.length, expectedChecksum, async () => {
        const batches = [];
        for (const bio of bios) {
          batches.push(await listAuthorsByBioOnce(delayedSql, bio));
        }
        return batches.flat();
      })
    );

    console.info(JSON.stringify({ benchmark: "batchmany repeated keyed lookup under latency", latencyMs, results }, null, 2));
  }, 60_000);
});

async function measureInsert(
  sql: Sql,
  scenario: string,
  strategy: string,
  rows: AuthorInput[],
  expectedState: AuthorState,
  run: () => Promise<void>
): Promise<Measurement> {
  await resetAuthors(sql);
  const measurement = await measureOperation(scenario, strategy, rows.length, run);
  await expect(authorState(sql)).resolves.toEqual(expectedState);
  return measurement;
}

async function measureDelete(
  sql: Sql,
  scenario: string,
  strategy: string,
  seedRows: AuthorInput[],
  deleteIds: string[],
  expectedState: AuthorState,
  run: () => Promise<void>
): Promise<Measurement> {
  await resetAuthors(sql);
  await rawInsertAuthors(sql, seedRows, 1_000);
  const measurement = await measureOperation(scenario, strategy, deleteIds.length, run);
  await expect(authorState(sql)).resolves.toEqual(expectedState);
  return measurement;
}

async function measureSelect(
  scenario: string,
  strategy: string,
  inputCount: number,
  expectedRows: number,
  expectedChecksum: string,
  run: () => Promise<AuthorRow[]>
): Promise<Measurement> {
  const started = performance.now();
  const rows = await run();
  const milliseconds = performance.now() - started;
  expect(rows).toHaveLength(expectedRows);
  expect(authorRowsChecksum(rows)).toBe(expectedChecksum);
  return measurement(scenario, strategy, inputCount, milliseconds);
}

async function measureOperation(
  scenario: string,
  strategy: string,
  items: number,
  run: () => Promise<void>
): Promise<Measurement> {
  const started = performance.now();
  await run();
  return measurement(scenario, strategy, items, performance.now() - started);
}

function measurement(scenario: string, strategy: string, items: number, milliseconds: number): Measurement {
  return {
    scenario,
    strategy,
    items,
    milliseconds: Number(milliseconds.toFixed(2)),
    itemsPerSecond: Number(((items / milliseconds) * 1000).toFixed(2)),
  };
}

function authorRows(count: number, prefix: string): AuthorInput[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index}`,
    bio: index % 3 === 0 ? null : `bio-${index % 10}`,
  }));
}

async function rawInsertAuthors(sql: Sql, rows: AuthorInput[], chunkSize: number): Promise<void> {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: Array<string | null> = [];
    const placeholders = chunk.map((row, index) => {
      values.push(row.name, row.bio);
      const parameter = index * 2 + 1;
      return `($${parameter}, $${parameter + 1})`;
    });
    await sql.unsafe(`INSERT INTO authors (name, bio) VALUES ${placeholders.join(", ")}`, values);
  }
}

async function listAuthorsByBioOnce(sql: Sql, bio: string | null): Promise<AuthorRow[]> {
  const rows = await sql.unsafe(
    "SELECT id, name, bio FROM authors WHERE bio = $1 ORDER BY name",
    [bio]
  ).values();
  return rows.map((row) => ({ id: row[0] as string, name: row[1] as string, bio: row[2] as string | null }));
}

async function runGeneratedCreateAuthorPipelined(sql: Sql, rows: AuthorInput[], pipelineSize: number): Promise<void> {
  const reserved = await sql.reserve();
  try {
    await runInChunks(rows, pipelineSize, async (row) => {
      const inserted = await createAuthor(reserved, row);
      expect(inserted).not.toBeNull();
    });
  } finally {
    reserved.release();
  }
}

async function runGeneratedDeleteAuthorPipelined(sql: Sql, ids: string[], pipelineSize: number): Promise<void> {
  const reserved = await sql.reserve();
  try {
    await runInChunks(ids, pipelineSize, async (id) => {
      await deleteAuthor(reserved, { id });
    });
  } finally {
    reserved.release();
  }
}

async function runListAuthorsByBioPipelined(sql: Sql, bios: string[], pipelineSize: number): Promise<AuthorRow[]> {
  const reserved = await sql.reserve();
  try {
    const batches: AuthorRow[][] = [];
    for (let start = 0; start < bios.length; start += pipelineSize) {
      const chunk = bios.slice(start, start + pipelineSize);
      batches.push(...await Promise.all(chunk.map((bio) => listAuthorsByBioOnce(reserved, bio))));
    }
    return batches.flat();
  } finally {
    reserved.release();
  }
}

async function runInChunks<T>(items: T[], chunkSize: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    await Promise.all(chunk.map((item) => run(item)));
  }
}

function sqlWithPerQueryLatency<T extends Sql>(sql: T, milliseconds: number): T {
  return new Proxy(sql as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (...args: unknown[]) => withPerQueryLatency((target.unsafe as (...args: unknown[]) => QueryResult)(...args), milliseconds);
      }
      if (property === "reserve") {
        return async (...args: unknown[]) => {
          const reserved = await (target.reserve as (...args: unknown[]) => Promise<Sql>)(...args);
          return sqlWithPerQueryLatency(reserved, milliseconds);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as T;
}

function withPerQueryLatency(result: QueryResult, milliseconds: number): QueryResult {
  const delayed = sleep(milliseconds).then(() => result) as QueryResult;
  if (typeof result.values === "function") {
    delayed.values = () => sleep(milliseconds).then(() => result.values?.() ?? []);
  }
  return delayed;
}

async function authorState(sql: Sql): Promise<AuthorState> {
  const rows = await sql.unsafe(`
    SELECT
      count(*)::int AS count,
      md5(coalesce(string_agg(id::text || ':' || name || ':' || coalesce(bio, ''), ',' ORDER BY id), '')) AS checksum
    FROM authors
  `);
  const row = rows[0];
  return { count: row.count, checksum: row.checksum };
}

function expectedAuthorState(rows: AuthorRow[]): AuthorState {
  return { count: rows.length, checksum: authorRowsChecksum(rows) };
}

function authorRowsChecksum(rows: AuthorRow[]): string {
  const input = [...rows]
    .sort((left, right) => Number(left.id) - Number(right.id) || left.name.localeCompare(right.name))
    .map((row) => `${row.id}:${row.name}:${row.bio ?? ""}`)
    .join(",");
  return createHash("md5").update(input).digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
