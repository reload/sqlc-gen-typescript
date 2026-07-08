import type { Sql } from "postgres";

import { copyAuthors } from "../examples/node-postgres/src/db/query_sql";

async function useCopyfrom(client: Sql) {
  const copiedCount: number = await copyAuthors(client, [
    { name: "Octavia E. Butler", bio: "Earthseed" },
  ]);
  void copiedCount;
}

async function useCopyfromInTransaction(client: Sql) {
  await client.begin(async (tx) => {
    const copiedCount: number = await copyAuthors(tx, [
      { name: "Octavia E. Butler", bio: "Earthseed" },
    ]);
    void copiedCount;
  });
}

void useCopyfrom;
void useCopyfromInTransaction;
