import type { Query } from "./gen/plugin/codegen_pb";

const simpleInsertPattern = /^\s*insert\s+into\s+((?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?)\s*\(([\s\S]+)\)\s*values\s*\(([\s\S]+)\)\s*;?\s*$/i;
const identifierPattern = /^(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/;
const positionalParameterPattern = /^\$(\d+)$/;

function failCopyfromValidation(query: Query, reason: string): never {
  throw new Error(
    `:copyfrom query ${query.name} must be a simple INSERT INTO table (columns...) VALUES ($1, ...) statement: ${reason}`
  );
}

function splitSqlDelimited(text: string, delimiter: string, query: Query, label: string): string[] {
  const items: string[] = [];
  let start = 0;
  let inQuotedIdentifier = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotedIdentifier && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotedIdentifier = !inQuotedIdentifier;
      continue;
    }
    if (char === delimiter && !inQuotedIdentifier) {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  if (inQuotedIdentifier) {
    failCopyfromValidation(query, `${label} contains an unterminated quoted identifier`);
  }

  items.push(text.slice(start).trim());
  if (items.some((item) => item.length === 0)) {
    failCopyfromValidation(query, `${label} contains an empty item`);
  }
  return items;
}

function splitSqlList(text: string, query: Query, label: string): string[] {
  return splitSqlDelimited(text, ",", query, label);
}

function sqlIdentifierText(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function validateCopyfromTable(tableText: string, query: Query): void {
  const tableParts = splitSqlDelimited(tableText, ".", query, "table name").map(sqlIdentifierText);
  const expectedParts = [query.insertIntoTable?.schema, query.insertIntoTable?.name]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.toLowerCase());

  if (tableParts.length !== expectedParts.length) {
    failCopyfromValidation(query, "INSERT table must match sqlc table metadata");
  }
  for (const [index, tablePart] of tableParts.entries()) {
    if (tablePart !== expectedParts[index]) {
      failCopyfromValidation(query, "INSERT table must match sqlc table metadata");
    }
  }
}

export function validateCopyfromQuery(query: Query): void {
  if (!query.insertIntoTable?.name) {
    failCopyfromValidation(query, "missing INSERT INTO table metadata");
  }

  const match = simpleInsertPattern.exec(query.text);
  if (!match) {
    failCopyfromValidation(query, "unsupported INSERT shape");
  }

  const tableText = match[1];
  const columnsText = match[2];
  const valuesText = match[3];
  if (tableText === undefined || columnsText === undefined || valuesText === undefined) {
    failCopyfromValidation(query, "missing table, column, or VALUES list");
  }

  validateCopyfromTable(tableText, query);
  const columns = splitSqlList(columnsText, query, "column list");
  const values = splitSqlList(valuesText, query, "VALUES list");

  if (columns.length !== query.params.length) {
    failCopyfromValidation(query, "column count must match parameter count");
  }
  if (values.length !== query.params.length) {
    failCopyfromValidation(query, "VALUES count must match parameter count");
  }

  for (const column of columns) {
    if (!identifierPattern.test(column)) {
      failCopyfromValidation(query, `column ${column} is not a simple identifier`);
    }
  }

  for (const [index, value] of values.entries()) {
    const paramMatch = positionalParameterPattern.exec(value);
    if (!paramMatch) {
      failCopyfromValidation(query, `VALUES item ${index + 1} is not a positional parameter`);
    }
    const paramNumber = Number(paramMatch[1]);
    if (paramNumber !== index + 1) {
      failCopyfromValidation(query, "VALUES parameters must be contiguous and in order");
    }
    if (query.params[index]?.number !== paramNumber) {
      failCopyfromValidation(query, "sqlc parameter metadata does not match VALUES order");
    }
  }
}
