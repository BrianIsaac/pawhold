import { describe, expect, it } from "vitest";

import { CsvSyntaxError, readCsv } from "@/estimate/csv";

describe("reading CSV (RFC 4180)", () => {
  it("numbers each record as a spreadsheet numbers its rows, the header row 1", () => {
    expect(readCsv("code,name\nA,One\nB,Two\n")).toEqual([
      { row: 1, fields: ["code", "name"] },
      { row: 2, fields: ["A", "One"] },
      { row: 3, fields: ["B", "Two"] },
    ]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    const records = readCsv('a,"Scale, polish","He said ""yes""","two\r\nlines"\r\nb,c,d,e');

    expect(records).toEqual([
      { row: 1, fields: ["a", "Scale, polish", 'He said "yes"', "two\r\nlines"] },
      { row: 2, fields: ["b", "c", "d", "e"] },
    ]);
  });

  it("drops a byte order mark and skips blank rows, keeping the row numbers", () => {
    expect(readCsv("﻿a,b\r\n\r\nc,d\r\n")).toEqual([
      { row: 1, fields: ["a", "b"] },
      { row: 3, fields: ["c", "d"] },
    ]);
  });

  it("keeps an empty last field", () => {
    expect(readCsv("a,b,\n")).toEqual([{ row: 1, fields: ["a", "b", ""] }]);
  });

  it("refuses an unclosed quote with the row it opened on", () => {
    expect(() => readCsv('a,b\nc,"open\n')).toThrow(
      new CsvSyntaxError(2, "a quoted field is never closed"),
    );
  });

  it("refuses a quote inside an unquoted field with its row", () => {
    expect(() => readCsv('a,b\nc,d"e\n')).toThrow(
      new CsvSyntaxError(2, "a quote inside an unquoted field"),
    );
  });

  it("refuses text straight after a closing quote with its row", () => {
    expect(() => readCsv('a,"b"c\n')).toThrow(new CsvSyntaxError(1, "text after a closing quote"));
  });
});

describe("reading CSV as spreadsheets write it", () => {
  it("ends a row at a lone carriage return, as old Mac spreadsheets write", () => {
    expect(readCsv("a,b\rc,d\r")).toEqual([
      { row: 1, fields: ["a", "b"] },
      { row: 2, fields: ["c", "d"] },
    ]);
  });

  it("keeps a row whose one field is a quoted empty string", () => {
    expect(readCsv('a\n""\nb\n')).toEqual([
      { row: 1, fields: ["a"] },
      { row: 2, fields: [""] },
      { row: 3, fields: ["b"] },
    ]);
  });

  it("says so when a space comes before an opening quote", () => {
    expect(() => readCsv('a, "b"\n')).toThrow(
      new CsvSyntaxError(1, "a space before an opening quote"),
    );
  });
});
