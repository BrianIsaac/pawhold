import { describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { createHealthHandler } from "@/health/handler";

import { connectTestDatabase } from "../support/database";

const database = connectTestDatabase();

describe("GET /api/health", () => {
  it("answers 200 with the database reached", async () => {
    const health = createHealthHandler({ database: () => database });

    const answer = await health();

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "ok", database: "reached", commit: null });
  });

  it("answers 503 when the database cannot be reached", async () => {
    const unreachable = createDatabase("postgres://pawhold:pawhold@127.0.0.1:1/pawhold", {
      max: 1,
    });
    const health = createHealthHandler({ database: () => unreachable, timeoutMs: 2_000 });

    const answer = await health();

    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({
      status: "unavailable",
      database: "unreachable",
      commit: null,
    });
    await unreachable.close();
  });

  it("answers 503 when no database is configured", async () => {
    const health = createHealthHandler({
      database: () => {
        throw new Error("missing or malformed environment: DATABASE_URL");
      },
    });

    const answer = await health();

    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ database: "unconfigured" });
  });
});
