import {
  SqlcCopyFromUnsupportedError,
  copyAuthors,
} from "../examples/node-pg/src/db/query_sql";

async function useUnsupportedPgCopyfrom(
  client: Parameters<typeof copyAuthors>[0]
) {
  await copyAuthors(client, [{ name: "Ann", bio: null }]);
}

function handleUnsupportedPgCopyfrom(error: unknown) {
  if (error instanceof SqlcCopyFromUnsupportedError) {
    const driver: "pg" = error.driver;
    const command: string = error.command;
    void [driver, command];
  }
}

void useUnsupportedPgCopyfrom;
void handleUnsupportedPgCopyfrom;
