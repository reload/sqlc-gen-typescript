import {
  SqlcBatchUnsupportedError,
  batchDeleteAuthor,
} from "../examples/node-pg/src/db/query_sql";

async function useUnsupportedPgBatch(
  client: Parameters<typeof batchDeleteAuthor>[0]
) {
  await batchDeleteAuthor(client, [{ id: "1" }], { batchSize: 1 });
}

function handleUnsupportedPgBatch(error: unknown) {
  if (error instanceof SqlcBatchUnsupportedError) {
    const driver: "pg" = error.driver;
    const command: string = error.command;
    void [driver, command];
  }
}

void useUnsupportedPgBatch;
void handleUnsupportedPgBatch;
