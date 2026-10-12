import { describe, expect, it } from "vitest";

import { storeConnectionOptions } from "../../probes/webhook-store";

describe("P8's read of the deployed listener's store", () => {
  it("asks for TLS off this machine: Render's external connections require it", () => {
    expect(
      storeConnectionOptions("postgresql://u:p@dpg-abc.frankfurt-postgres.render.com/pawhold"),
    ).toMatchObject({ ssl: "require", connection: { default_transaction_read_only: true } });
  });

  it("does not on this machine's own Postgres", () => {
    expect(storeConnectionOptions("postgres://u:p@127.0.0.1:54329/pawhold").ssl).toBe(false);
    expect(storeConnectionOptions("postgres://u:p@localhost/pawhold").ssl).toBe(false);
  });
});
