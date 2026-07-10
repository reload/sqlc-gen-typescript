import type { Sql } from "postgres";

import { createAuthor, deleteAuthor, getAuthor, listAuthors } from "../examples/node-postgres/src/db/query_sql";

async function useTransaction(client: Sql) {
  await client.begin(async (tx) => {
    const created = await createAuthor(tx, {
      name: "Octavia E. Butler",
      bio: "Earthseed",
    });
    const authors = await listAuthors(tx);
    const author = await getAuthor(tx, { id: created?.id ?? "1" });
    await deleteAuthor(tx, { id: author?.id ?? authors[0]?.id ?? "1" });
  });
}

void useTransaction;
