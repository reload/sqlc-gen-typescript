import {
  SqlcBatchError,
  batchCreateAuthor,
  batchDeleteAuthor,
  batchListAuthorsByBio,
} from "../examples/node-postgres/src/db/query_sql";

async function useBatchResults(client: Parameters<typeof batchCreateAuthor>[0]) {
  const created = await batchCreateAuthor(
    client,
    [{ name: "Ursula K. Le Guin", bio: null }],
    { batchSize: 1 }
  );
  const firstCreated = created[0];
  if (firstCreated) {
    const index: number = firstCreated.index;
    const id: string | undefined = firstCreated.row?.id;
    void [index, id];
  }

  const listed = await batchListAuthorsByBio(client, [{ bio: null }]);
  const firstList = listed[0];
  if (firstList) {
    const index: number = firstList.index;
    const id: string | undefined = firstList.rows[0]?.id;
    void [index, id];
  }

  const deleted = await batchDeleteAuthor(client, [{ id: "1" }], {
    batchSize: 1,
  });
  const firstDeleted = deleted[0];
  if (firstDeleted) {
    const index: number = firstDeleted.index;
    void index;
  }
}

function handleBatchError(error: unknown) {
  if (error instanceof SqlcBatchError) {
    const failedIndex: number | undefined = error.errors[0]?.index;
    const cause: unknown | undefined = error.errors[0]?.error;
    void [failedIndex, cause];
  }
}

void useBatchResults;
void handleBatchError;
