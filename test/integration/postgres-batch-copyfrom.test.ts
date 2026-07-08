import { expect, test } from "vitest";

import {
  SqlcBatchError,
  batchCreateAuthor,
  batchDeleteAuthor,
  batchListAuthorsByBio,
  copyAuthors,
} from "../../examples/node-postgres/src/db/query_sql";
import { countAuthors, describePostgresIntegration, listAuthorRows } from "./postgres-db";

describePostgresIntegration(":batch postgres integration", ({ sql }) => {
  test("batchCreateAuthor inserts rows and preserves input order", async () => {
    const results = await batchCreateAuthor(
      sql,
      [
        { name: "Octavia E. Butler", bio: "Earthseed" },
        { name: "Ursula K. Le Guin", bio: "Ekumen" },
        { name: "N. K. Jemisin", bio: "Stillness" },
      ],
      { batchSize: 2 }
    );

    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.row && { name: result.row.name, bio: result.row.bio })).toEqual([
      { name: "Octavia E. Butler", bio: "Earthseed" },
      { name: "Ursula K. Le Guin", bio: "Ekumen" },
      { name: "N. K. Jemisin", bio: "Stillness" },
    ]);
    await expect(listAuthorRows(sql)).resolves.toEqual([
      { id: "1", name: "Octavia E. Butler", bio: "Earthseed" },
      { id: "2", name: "Ursula K. Le Guin", bio: "Ekumen" },
      { id: "3", name: "N. K. Jemisin", bio: "Stillness" },
    ]);
  });

  test("batchListAuthorsByBio returns rows scoped to each input", async () => {
    await batchCreateAuthor(
      sql,
      [
        { name: "Ann", bio: "shared" },
        { name: "Bea", bio: "solo" },
        { name: "Ada", bio: "shared" },
      ],
      { batchSize: 3 }
    );

    const results = await batchListAuthorsByBio(
      sql,
      [{ bio: "shared" }, { bio: "missing" }, { bio: "solo" }],
      { batchSize: 2 }
    );

    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.rows.map((row) => row.name))).toEqual([
      ["Ada", "Ann"],
      [],
      ["Bea"],
    ]);
  });

  test("batchDeleteAuthor deletes rows and preserves result indexes", async () => {
    const created = await batchCreateAuthor(
      sql,
      [
        { name: "Delete A", bio: null },
        { name: "Keep", bio: null },
        { name: "Delete B", bio: null },
      ],
      { batchSize: 3 }
    );
    const firstDeleteId = created[0]?.row?.id;
    const secondDeleteId = created[2]?.row?.id;
    expect(firstDeleteId).toBeDefined();
    expect(secondDeleteId).toBeDefined();

    const results = await batchDeleteAuthor(
      sql,
      [{ id: firstDeleteId ?? "" }, { id: secondDeleteId ?? "" }],
      { batchSize: 1 }
    );

    expect(results.map((result) => result.index)).toEqual([0, 1]);
    await expect(listAuthorRows(sql)).resolves.toEqual([
      { id: "2", name: "Keep", bio: null },
    ]);
  });

  test("batchCreateAuthor rejects failed chunks with indexed SqlcBatchError", async () => {
    let caught: unknown;
    try {
      await batchCreateAuthor(
        sql,
        [
          { name: "ok", bio: null },
          { name: null, bio: "invalid" } as never,
          { name: "not-started", bio: null },
        ],
        { batchSize: 2 }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SqlcBatchError);
    expect((caught as SqlcBatchError).errors).toEqual([
      expect.objectContaining({ index: 1 }),
    ]);
    await expect(sql.unsafe("SELECT 1 AS ok")).resolves.toMatchObject([{ ok: 1 }]);
  });

  test("batchSize must be a positive integer", async () => {
    await expect(
      batchCreateAuthor(sql, [{ name: "Ann", bio: null }], { batchSize: 0 })
    ).rejects.toThrow(RangeError);
  });
});

describePostgresIntegration(":copyfrom postgres integration", ({ sql }) => {
  test("copyAuthors inserts rows and returns the copied count", async () => {
    const count = await copyAuthors(sql, [
      { name: "Octavia E. Butler", bio: "Earthseed" },
      { name: "Ursula K. Le Guin", bio: "Ekumen" },
      { name: "N. K. Jemisin", bio: "Stillness" },
    ]);

    expect(count).toBe(3);
    await expect(listAuthorRows(sql)).resolves.toEqual([
      { id: "1", name: "Octavia E. Butler", bio: "Earthseed" },
      { id: "2", name: "Ursula K. Le Guin", bio: "Ekumen" },
      { id: "3", name: "N. K. Jemisin", bio: "Stillness" },
    ]);
  });

  test("copyAuthors round-trips COPY text escaping", async () => {
    const rows = [
      { name: "tab\tname", bio: "line\nnext" },
      { name: "carriage\rreturn", bio: "literal\\N" },
      { name: "back\\slash", bio: null },
      { name: "emoji 🦕", bio: "snowman ☃" },
    ];

    expect(await copyAuthors(sql, rows)).toBe(rows.length);
    await expect(listAuthorRows(sql)).resolves.toEqual(
      rows.map((row, index) => ({ id: String(index + 1), ...row }))
    );
  });

  test("copyAuthors accepts empty input without inserting rows", async () => {
    await expect(copyAuthors(sql, [])).resolves.toBe(0);
    await expect(countAuthors(sql)).resolves.toBe(0);
  });
});
