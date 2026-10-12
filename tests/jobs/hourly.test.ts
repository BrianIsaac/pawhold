import { describe, expect, it } from "vitest";

import { runHourly } from "@/jobs/hourly";

import { connectTestDatabase } from "../support/database";

const database = connectTestDatabase();

describe("the hourly job (a stub until U3 and U9)", () => {
  it("reaches the database and reports that it did nothing", async () => {
    expect(await runHourly(database.db)).toEqual({
      databaseReached: true,
      reauthorised: 0,
      sessionsPruned: 0,
    });
  });
});
