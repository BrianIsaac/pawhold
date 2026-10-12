import { execFileSync, spawn } from "node:child_process";

import postgres from "postgres";

import { migrateDatabase } from "../../src/db/migrate";

import { browserDatabaseUrl, testAdminUrl } from "./database";

/*
 * The browser suite's server: makes the run's database, migrates it, serves
 * the application on it with `next dev`, and on SIGTERM (Playwright's
 * shutdown) stops the server and drops the database. PayPal's sandbox
 * credentials and the webhook id pass through from the environment when set;
 * the session secret is the run's.
 */

const port = process.env.PAWHOLD_BROWSER_PORT ?? "3061";
const name = process.env.PAWHOLD_BROWSER_DATABASE;
const secret = process.env.PAWHOLD_BROWSER_SECRET;
if (!name || !/^pawhold_browser_[0-9a-f]{12}$/.test(name) || !secret) {
  throw new Error("serve.ts runs under playwright.config.ts, which names the run's database");
}

const admin = await connectAdmin();
await admin.unsafe(`create database ${name}`);
const databaseUrl = browserDatabaseUrl();
await migrateDatabase(databaseUrl);

const server = spawn("pnpm", ["exec", "next", "dev", "--port", port], {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: secret,
    PAYPAL_ENV: "sandbox",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

let stopping = false;

/**
 * Connects to the admin database, starting the development Postgres in
 * Docker first when it is not reachable outside CI (as the unit suite's
 * setup does).
 *
 * @returns The connection.
 */
async function connectAdmin(): Promise<postgres.Sql> {
  const tryConnect = async (): Promise<postgres.Sql> => {
    const sql = postgres(testAdminUrl(), { max: 1, onnotice: () => {} });
    await sql`select 1`;
    return sql;
  };
  try {
    return await tryConnect();
  } catch (error) {
    if (process.env.CI) {
      throw error;
    }
    execFileSync("docker", ["compose", "up", "-d", "--wait", "db"], { stdio: "inherit" });
    return tryConnect();
  }
}

/**
 * Stops the server, drops the run's database and exits.
 *
 * @param code - The exit code.
 */
async function stop(code: number): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  if (server.exitCode === null) {
    const exited = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    await exited;
  }
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
  process.exit(code);
}

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
server.on("exit", (code) => void stop(code ?? 1));
