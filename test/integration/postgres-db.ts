import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

export const databaseUrl = process.env["DATABASE_URL"];

export function describePostgresIntegration(
  name: string,
  fn: (context: { sql: Sql }) => void
) {
  const describeFn = databaseUrl ? describe.sequential : describe.skip;

  describeFn(name, () => {
    const sql = postgres(databaseUrl ?? "", { max: 8, onnotice: () => undefined });

    beforeAll(async () => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS authors (
          id BIGSERIAL PRIMARY KEY,
          name text NOT NULL,
          bio text
        )
      `);
    });

    beforeEach(async () => {
      await resetAuthors(sql);
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    fn({ sql });
  });
}

export async function resetAuthors(sql: Sql): Promise<void> {
  await sql.unsafe("TRUNCATE authors RESTART IDENTITY");
}

export async function listAuthorRows(sql: Sql): Promise<Array<{ id: string; name: string; bio: string | null }>> {
  const rows = await sql.unsafe("SELECT id::text AS id, name, bio FROM authors ORDER BY id");
  return rows.map((row) => ({ id: row.id, name: row.name, bio: row.bio }));
}

export async function countAuthors(sql: Sql): Promise<number> {
  const rows = await sql.unsafe("SELECT count(*)::int AS count FROM authors");
  return rows[0]?.count ?? 0;
}
