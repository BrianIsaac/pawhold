import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/*
 * The day's board is Bryntum's Scheduler on its trial (plan 7.3, D5 (b) and
 * its 13 October addendum): installed under an alias, so a licensed package
 * later is one line, and nothing of the package itself committed (plan 5,
 * U8b's acceptance: "the alias in `package.json` only"). The trial's install
 * date and both readings of its expiry stand in a comment at the alias.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const manifest = z
  .object({
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
  })
  .loose()
  .parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));

/** What the package's own files carry: its bundle's copyright line, and its stylesheets' version property. */
const VENDOR_MARKS = [/Copyright © \d{4}-\d{4}, Bryntum/, /--bryntum-version\s*:/];

/** This file, which names the trial's package to check for it. */
const THIS_FILE = "tests/hosting/board-package.test.ts";

/** What the repository may hold of the package: its name in the manifest and the lockfile. */
const NAMED_IN = ["package.json", "pnpm-lock.yaml"];

/**
 * Every file git tracks or has staged, from the repository's root.
 *
 * @returns The paths.
 */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.length > 0);
}

describe("the Scheduler's trial in the manifest", () => {
  it("is installed under an alias of the trial, pinned, with its React wrapper", () => {
    expect(manifest.dependencies["@bryntum/scheduler"]).toBe("npm:@bryntum/scheduler-trial@7.3.7");
    expect(manifest.dependencies["@bryntum/scheduler-react"]).toBe("7.3.7");
    const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => /bryntum/i.test(name),
    );
    expect(named.sort()).toEqual(["@bryntum/scheduler", "@bryntum/scheduler-react"]);
  });

  it("carries the trial's install date and both readings of its expiry at the alias", () => {
    const comment = (manifest as Record<string, unknown>)["//@bryntum/scheduler"];
    expect(typeof comment).toBe("string");
    expect(comment).toContain("installed 13 October 2026");
    expect(comment).toContain("12 November 2026");
    expect(comment).toContain("27 November 2026");
  });

  it("is resolved from the public registry's trial package, never a local copy", () => {
    const lock = z
      .object({
        importers: z.record(
          z.string(),
          z
            .object({
              dependencies: z.record(
                z.string(),
                z.object({ specifier: z.string(), version: z.string() }),
              ),
            })
            .loose(),
        ),
      })
      .loose()
      .parse(parse(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8")));
    const resolved = lock.importers["."]!.dependencies;
    expect(resolved["@bryntum/scheduler"]).toEqual({
      specifier: "npm:@bryntum/scheduler-trial@7.3.7",
      version: "@bryntum/scheduler-trial@7.3.7",
    });
    expect(resolved["@bryntum/scheduler-react"]?.specifier).toBe("7.3.7");
  });
});

describe("the tree", () => {
  const files = trackedFiles();

  it("holds no file of the package: no path names it", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((path) => /bryntum/i.test(path))).toEqual([]);
  });

  it("holds no file of the package: none carries its marks, and only the manifest and the lockfile name the trial", () => {
    const carrying: string[] = [];
    const naming: string[] = [];
    for (const path of files) {
      let text: string;
      try {
        text = readFileSync(`${ROOT}${path}`, "utf8");
      } catch {
        continue;
      }
      if (VENDOR_MARKS.some((mark) => mark.test(text))) {
        carrying.push(path);
      }
      if (/scheduler-trial/.test(text) && !NAMED_IN.includes(path) && path !== THIS_FILE) {
        naming.push(path);
      }
    }
    expect(carrying).toEqual([]);
    expect(naming).toEqual([]);
  });
});
