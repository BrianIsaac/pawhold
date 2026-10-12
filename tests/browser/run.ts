import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter } from "node:path";

import { migrateDatabase } from "../../src/db/migrate";
import { connectAdmin, DEFAULT_ADMIN_URL } from "../setup/database";
import { createPayPalDouble } from "../support/paypal-double-server";

/**
 * `pnpm test:browser`: makes a database for the run and migrates it, finds a
 * free port (or takes `PAWHOLD_BROWSER_PORT`, for a tunnel that must know it),
 * runs both suites of walks (the practice's and the owner's, projects of
 * playwright.config.ts) against the built server on them with the recorded
 * model double (never the live model), and drops the database whatever the
 * outcome. PayPal's sandbox values pass through when the environment has
 * them, for the owner's sandbox walks; without them those walks are skipped,
 * and the server talks instead to U3's PayPal double, started here for the
 * run (the discharge walks confirm against it; playwright.config.ts hands
 * its address to the server alone), and the server and the walks are given a
 * stand-in sandbox buyer login, which the owner's page shows in judge mode.
 * Arguments are passed to `playwright test`.
 */

/**
 * The stand-in buyer login of a run without PayPal's sandbox: never a real
 * account's, but of a sandbox login's shape and length, so the owner's page
 * is laid out as a judge will see it.
 */
const STAND_IN_BUYER = {
  PAYPAL_SANDBOX_BUYER_EMAIL: "sb-standin4buyer@personal.example.com",
  PAYPAL_SANDBOX_BUYER_PASSWORD: "Xx0@{*Yy",
} as const;

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
    const port = process.env.PAWHOLD_BROWSER_PORT ?? String(await freePort());
    const secret = randomBytes(32).toString("base64url");
    const sandbox = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
    const double = sandbox ? null : createPayPalDouble({ liveClock: true });
    const doubleUrl = double ? await double.listen() : null;
    try {
      return await walk(url.toString(), port, secret, doubleUrl);
    } finally {
      await double?.close();
    }
  } finally {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

/**
 * Runs `playwright test` against the run's database, port and secret.
 *
 * @param databaseUrl - The run's database.
 * @param port - The server's port.
 * @param secret - The session secret.
 * @param doubleUrl - The PayPal double's address, when the run has no sandbox credentials.
 * @returns The exit code.
 */
function walk(
  databaseUrl: string,
  port: string,
  secret: string,
  doubleUrl: string | null,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: secret,
        PAWHOLD_BROWSER_SECRET: secret,
        PAWHOLD_BROWSER_PORT: port,
        AGENT_RECORDED_DIR: ["evals/recorded", "tests/browser/recorded"].join(delimiter),
        AGENT_DRAFTS_PER_HOUR: "off",
        OPENAI_API_KEY: "",
        PAYPAL_ENV: "sandbox",
        ...(doubleUrl ? { PAWHOLD_BROWSER_PAYPAL_DOUBLE_URL: doubleUrl, ...STAND_IN_BUYER } : {}),
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
