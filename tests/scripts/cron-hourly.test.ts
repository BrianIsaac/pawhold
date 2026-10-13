import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { migrateDatabase } from "@/db/migrate";

/*
 * The hourly job as Render runs it (`pnpm cron:hourly`, U14): its exit code
 * is what Render reads, and a failed run is Render's email to the operator.
 * Each run here is the real script in its own process, against a database
 * of its own (the job's sweeps act on every practice, so never the other
 * files' database) and a stand-in for the live service on the loopback.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const HEALTHY = { status: "ok", database: "reached", commit: "0233063".padEnd(40, "0") };

/** What the stand-in answers `/api/health` with; each test sets its own. */
let answer: (response: ServerResponse) => void = (response) => response.end();
let asked: string[] = [];
let standIn: Server | undefined;
let liveUrl: string;

let admin: postgres.Sql | undefined;
let databaseName: string;
let databaseUrl: string;

beforeAll(async () => {
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    answer(response);
  });
  standIn = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  liveUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  databaseName = `pawhold_test_${randomBytes(6).toString("hex")}`;
  admin = postgres(inject("databaseUrl"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${databaseName}`);
  const url = new URL(inject("databaseUrl"));
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  await migrateDatabase(databaseUrl);
});

afterAll(async () => {
  await new Promise<void>((resolve) => (standIn ? standIn.close(() => resolve()) : resolve()));
  if (admin) {
    await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
    await admin.end();
  }
});

/** How one run of the job ended. */
interface Run {
  readonly code: number | null;
  readonly lines: string[];
}

/** Longer than any run here takes; a run still going then is stopped and the test fails. */
const RUN_LIMIT_MS = 45_000;

/**
 * Runs the job as Render's start command does, with nothing in its
 * environment but what is given (so never this machine's PayPal credentials).
 * Both of its streams are read as one, in the order it wrote them.
 *
 * @param environment - The job's variables.
 * @returns Its exit code and every line it wrote.
 */
function runJob(environment: Record<string, string>): Promise<Run> {
  asked = [];
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", "exec pnpm cron:hourly 2>&1"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        ...environment,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const limit = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pnpm cron:hourly was still running after ${RUN_LIMIT_MS} ms`));
    }, RUN_LIMIT_MS);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(limit);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(limit);
      resolve({ code, lines: output.split("\n") });
    });
  });
}

/**
 * The lines the probe wrote.
 *
 * @param run - The run.
 * @returns Each line that starts with the probe's words.
 */
function probeLines(run: Run): string[] {
  return run.lines.filter((line) => line.startsWith("pawhold: live probe"));
}

describe("pnpm cron:hourly, as Render's cron runs it (U14)", () => {
  it("succeeds when the live service is healthy, saying what it saw", async () => {
    answer = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(HEALTHY));
    };

    const run = await runJob({ DATABASE_URL: databaseUrl, PAWHOLD_LIVE_URL: liveUrl });

    expect(run.lines.find((line) => line.startsWith("pawhold: hourly job {"))).toContain(
      '"databaseReached":true',
    );
    expect(probeLines(run)).toEqual([
      `pawhold: live probe: GET ${liveUrl}/api/health answered healthy on attempt 1, commit ${HEALTHY.commit}`,
    ]);
    expect(asked).toEqual(["GET /api/health"]);
    expect(run.code).toBe(0);
  }, 60_000);

  it("fails when the live service answers 503, in one line, after its own work is logged", async () => {
    answer = (response) => {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<html><body>Service Suspended</body></html>");
    };

    const run = await runJob({ DATABASE_URL: databaseUrl, PAWHOLD_LIVE_URL: liveUrl });

    const report = run.lines.findIndex((line) => line.startsWith("pawhold: hourly job {"));
    const probe = run.lines.findIndex((line) => line.startsWith("pawhold: live probe"));
    expect(run.lines[report]).toContain('"databaseReached":true');
    expect(probe).toBeGreaterThan(report);
    expect(probeLines(run)).toEqual([
      `pawhold: live probe failed: GET ${liveUrl}/api/health answered HTTP 503 with a body that is not the health check's JSON, after 2 attempts`,
    ]);
    expect(asked).toEqual(["GET /api/health", "GET /api/health"]);
    expect(run.code).toBe(1);
  }, 60_000);

  it("still probes, and fails, when its own work cannot reach the database or has none to reach", async () => {
    answer = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(HEALTHY));
    };

    for (const database of [
      { DATABASE_URL: "postgres://pawhold:pawhold@127.0.0.1:1/pawhold" },
      {},
    ]) {
      const run = await runJob({ ...database, PAWHOLD_LIVE_URL: liveUrl });

      const failed = run.lines.findIndex((line) => line.startsWith("pawhold: hourly job failed"));
      const probe = run.lines.findIndex((line) => line.startsWith("pawhold: live probe"));
      expect(failed, JSON.stringify(database)).toBeGreaterThanOrEqual(0);
      expect(probe).toBeGreaterThan(failed);
      expect(probeLines(run)).toHaveLength(1);
      expect(probeLines(run)[0]).toContain("answered healthy on attempt 1");
      expect(run.code).toBe(1);
    }
  }, 120_000);

  it("does its own work whatever the probe's address is, then fails on one that is not an origin", async () => {
    const run = await runJob({
      DATABASE_URL: databaseUrl,
      PAWHOLD_LIVE_URL: "https://pawhold.onrender.com/api/health",
    });

    const report = run.lines.findIndex((line) => line.startsWith("pawhold: hourly job {"));
    const probe = run.lines.findIndex((line) => line.startsWith("pawhold: live probe"));
    expect(run.lines[report]).toContain('"databaseReached":true');
    expect(probe).toBeGreaterThan(report);
    expect(probeLines(run)).toEqual([
      "pawhold: live probe failed: PAWHOLD_LIVE_URL must be an http or https origin: must be an origin, with no path, query or fragment",
    ]);
    expect(asked).toEqual([]);
    expect(run.code).toBe(1);
  }, 60_000);
});
