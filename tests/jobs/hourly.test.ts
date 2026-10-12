import { describe, expect, it } from "vitest";

import { runHourly } from "@/jobs/hourly";

import { connectTestDatabase } from "../support/database";
import { startPayPalDouble } from "../support/paypal-double";

const database = connectTestDatabase();
const paypal = startPayPalDouble();

// A clock before every hold and webhook the other files make, so this run
// touches none of theirs.
const BEFORE_EVERYTHING = new Date("2026-10-01T00:00:00Z");

describe("the hourly job (plan 7.3: the reauthorisation rule; U3's webhook sweep)", () => {
  it("runs the reauthorisation rule and the webhook sweep, and reports what each did", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: paypal.client(),
      now: BEFORE_EVERYTHING,
    });

    expect(report).toEqual({
      databaseReached: true,
      reauthorisation: { reauthorised: [], flagged: [], tooSoon: [], refused: [], failed: [] },
      discharges: { resumed: [], failed: [] },
      webhooks: { reconciled: 0, flagged: 0, pending: 0, failed: 0 },
      sessionsPruned: 0,
      errors: [],
    });
  });

  it("runs every part even when one fails, and reports the failure", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: paypal.client(),
      now: BEFORE_EVERYTHING,
      parts: { reauthorisation: () => Promise.reject(new Error("the rule broke")) },
    });

    expect(report.reauthorisation).toBeNull();
    expect(report.errors).toEqual(["reauthorisation: the rule broke"]);
    expect(report.discharges).toEqual({ resumed: [], failed: [] });
    expect(report.webhooks).toEqual({ reconciled: 0, flagged: 0, pending: 0, failed: 0 });
  });

  it("skips the reauthorisation rule, saying so, when PayPal's credentials are not set", async () => {
    const report = await runHourly({ db: database.db, paypal: null, now: BEFORE_EVERYTHING });

    expect(report.reauthorisation).toBeNull();
    expect(report.discharges).toBeNull();
    expect(report.webhooks).toEqual({ reconciled: 0, flagged: 0, pending: 0, failed: 0 });
  });
});
