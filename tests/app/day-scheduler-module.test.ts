import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { pickEncoding, schedulerModule } from "../../app/(practice)/day/scheduler/module";

/*
 * The Scheduler's module as the day's route serves it (U8b): the installed
 * package's own file, byte for byte, compressed for the browser that asks,
 * each form with a tag of its own.
 */

const INSTALLED = readFileSync(
  new URL("../../node_modules/@bryntum/scheduler/scheduler.module.js", import.meta.url),
);

describe("the encoding the browser is answered in", () => {
  it("prefers Brotli, then gzip, then the file as it is", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip, deflate")).toBe("gzip");
    expect(pickEncoding("deflate")).toBe("identity");
    expect(pickEncoding(null)).toBe("identity");
  });

  it("leaves out an encoding the browser refuses", () => {
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip;q=0.0")).toBe("identity");
    expect(pickEncoding("BR ; q=0.5")).toBe("br");
  });
});

describe("the Scheduler's module, read from the installed package", () => {
  it("is the package's own file, whichever way it is sent", async () => {
    const plain = await schedulerModule("identity");
    const gzip = await schedulerModule("gzip");
    const brotli = await schedulerModule("br");

    expect(plain.body.equals(INSTALLED)).toBe(true);
    expect(gunzipSync(gzip.body).equals(INSTALLED)).toBe(true);
    expect(brotliDecompressSync(brotli.body).equals(INSTALLED)).toBe(true);
    expect(gzip.body.length).toBeLessThan(INSTALLED.length / 2);
    expect(brotli.body.length).toBeLessThan(gzip.body.length);
  });

  it("tags each form differently, and the same form the same each time", async () => {
    const tags = await Promise.all(
      (["identity", "gzip", "br"] as const).map(async (one) => (await schedulerModule(one)).tag),
    );

    expect(new Set(tags).size).toBe(3);
    for (const tag of tags) {
      expect(tag).toMatch(/^"[\w-]+"$/);
    }
    expect((await schedulerModule("br")).tag).toBe(tags[2]);
  });
});
