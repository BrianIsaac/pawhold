import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/** How the Scheduler's module is sent: as the file is, or compressed. */
export type ModuleEncoding = "identity" | "gzip" | "br";

/** The module in one encoding: its bytes and an entity tag of them. */
export interface EncodedModule {
  readonly body: Buffer;
  readonly tag: string;
}

/** The Scheduler's module in the installed package, as its maker ships it. */
const MODULE_FILE = ["node_modules", "@bryntum", "scheduler", "scheduler.module.js"];

/** Each encoding, made once for the life of the server and kept. */
const kept = new Map<ModuleEncoding, Promise<EncodedModule>>();

/**
 * The encoding to answer a browser in, from what it says it accepts: Brotli
 * where taken (the module is about 1.4 MB in it, 4.6 MB as shipped), then
 * gzip, then the file as it is.
 *
 * @param acceptEncoding - The request's `Accept-Encoding`, or null when it has none.
 * @returns The encoding.
 */
export function pickEncoding(acceptEncoding: string | null): ModuleEncoding {
  const accepted = new Set(
    (acceptEncoding ?? "")
      .toLowerCase()
      .split(",")
      .map((part) =>
        part
          .trim()
          .split(";")
          .map((piece) => piece.trim()),
      )
      .filter(([, quality]) => !/^q=0(\.0*)?$/.test(quality ?? ""))
      .map(([name]) => name),
  );
  if (accepted.has("br")) {
    return "br";
  }
  return accepted.has("gzip") ? "gzip" : "identity";
}

/**
 * Makes one encoding of the module from the installed file.
 *
 * @param encoding - The encoding.
 * @returns The bytes and their tag.
 */
async function encode(encoding: ModuleEncoding): Promise<EncodedModule> {
  const file = await readFile(join(/* turbopackIgnore: true */ process.cwd(), ...MODULE_FILE));
  const body =
    encoding === "br"
      ? await promisify(brotliCompress)(file, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 9,
            [constants.BROTLI_PARAM_SIZE_HINT]: file.length,
          },
        })
      : encoding === "gzip"
        ? await promisify(gzip)(file, { level: 9 })
        : file;
  const hash = createHash("sha256").update(file).digest("base64url");
  return { body, tag: `"${hash}-${encoding}"` };
}

/**
 * The Scheduler's module from the installed package, in an encoding: read and
 * compressed on first asking, then kept. A package that is not installed
 * rejects, and is tried again on the next asking.
 *
 * @param encoding - The encoding.
 * @returns The bytes and their tag.
 */
export function schedulerModule(encoding: ModuleEncoding): Promise<EncodedModule> {
  let made = kept.get(encoding);
  if (!made) {
    made = encode(encoding);
    kept.set(encoding, made);
    made.catch(() => kept.delete(encoding));
  }
  return made;
}
