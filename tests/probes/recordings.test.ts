import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const directory = new URL("../../probes/recorded/", import.meta.url);
const files = readdirSync(directory).filter((f) => f.endsWith(".json"));

describe("the committed probe recordings", () => {
  it.each(files)("%s holds no email address, token or authorisation header value", (file) => {
    const text = readFileSync(new URL(file, directory), "utf8");

    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/access_token|A21AA|Bearer |Basic /);
  });
});
