import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter } from "node:path";

import { migrateDatabase } from "../../src/db/migrate";
import { connectAdmin, DEFAULT_ADMIN_URL } from "../setup/database";

/**
 * `pnpm test:browser`: makes a database for the run and migrates it, finds a
 * free port, runs the Playwright walks against the built server on them with
 * the recorded model double (never the live model), and drops the database
 * whatever the outcome. Arguments are passed to `playwright test`.
 */

/**
 * A port nothing is listening on, from the operating system.
 *
 * @returns The port.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port was given")),
      );
    });
  });
}

/**
 * Runs the walks and answers their exit code.
 *
 * @returns The exit code of `playwright test`.
 */
async function main(): Promise<number> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const admin = await connectAdmin(adminUrl);
  const name = `pawhold_browser_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  try {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    await migrateDatabase(url.toString());
    const port = await freePort();
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          "--config",
          "tests/browser/playwright.config.ts",
          ...process.argv.slice(2),
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: url.toString(),
            SESSION_SECRET: randomBytes(32).toString("base64url"),
            AGENT_RECORDED_DIR: ["evals/recorded", "tests/browser/recorded"].join(delimiter),
            AGENT_DRAFTS_PER_HOUR: "off",
            BROWSER_TEST_PORT: String(port),
            OPENAI_API_KEY: "",
            PAYPAL_CLIENT_ID: "",
            PAYPAL_CLIENT_SECRET: "",
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
