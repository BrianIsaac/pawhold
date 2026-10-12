/** One record of a CSV file and the row a spreadsheet shows it on. */
export interface CsvRecord {
  /**
   * The record's row as a spreadsheet shows it: the first is 1, blank rows
   * count, and a line break inside a quoted field does not start a new row.
   */
  readonly row: number;
  readonly fields: readonly string[];
}

/** CSV that cannot be read, and the row it went wrong on. */
export class CsvSyntaxError extends Error {
  override readonly name = "CsvSyntaxError";

  /**
   * @param row - The row the fault is on.
   * @param reason - What is wrong.
   */
  constructor(
    readonly row: number,
    readonly reason: string,
  ) {
    super(`row ${row}: ${reason}`);
  }
}

/**
 * Reads CSV as RFC 4180 writes it: comma-separated fields, double quotes
 * around a field holding a comma, a quote or a line break, a quote inside one
 * doubled. Rows end in CRLF or LF. A leading byte order mark is dropped, and
 * blank rows are skipped but still counted, so each record keeps the row
 * number a spreadsheet would show for it.
 *
 * @param text - The CSV text.
 * @returns The records, in order.
 * @throws CsvSyntaxError when a quote is out of place or never closed.
 */
export function readCsv(text: string): CsvRecord[] {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let row = 1;
  let quoted = false;
  let afterQuote = false;
  let index = 0;

  const endField = () => {
    fields.push(field);
    field = "";
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === "";
    if (!blank) {
      records.push({ row, fields });
    }
    fields = [];
  };

  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }

    if (char === ",") {
      endField();
    } else if (char === "\n" || (char === "\r" && source[index + 1] === "\n")) {
      endRecord();
      index += char === "\r" ? 1 : 0;
      row += 1;
    } else if (afterQuote) {
      throw new CsvSyntaxError(row, "text after a closing quote");
    } else if (char === '"') {
      if (field !== "") {
        throw new CsvSyntaxError(row, "a quote inside an unquoted field");
      }
      quoted = true;
    } else {
      field += char;
    }
    index += 1;
  }

  if (quoted) {
    throw new CsvSyntaxError(row, "a quoted field is never closed");
  }
  if (field !== "" || fields.length > 0 || afterQuote) {
    endRecord();
  }
  return records;
}
