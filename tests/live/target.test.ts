import { describe, expect, it } from "vitest";

import { DEPLOYMENT_URL, healthAnswer, liveBaseUrl, smokeBuyer } from "./support/target";

describe("the live smoke's target (U10)", () => {
  it("walks the deployment unless a base URL is given", () => {
    expect(DEPLOYMENT_URL).toBe("https://pawhold.onrender.com");
    expect(liveBaseUrl({})).toBe("https://pawhold.onrender.com");
    expect(liveBaseUrl({ PAWHOLD_LIVE_URL: "" })).toBe("https://pawhold.onrender.com");
    expect(liveBaseUrl({ PAWHOLD_LIVE_URL: "https://pawhold-gone.onrender.com/" })).toBe(
      "https://pawhold-gone.onrender.com",
    );
  });

  it("reads a base URL as its origin, whatever its case or default port", () => {
    expect(liveBaseUrl({ PAWHOLD_LIVE_URL: "https://Pawhold.onrender.com" })).toBe(
      "https://pawhold.onrender.com",
    );
    expect(liveBaseUrl({ PAWHOLD_LIVE_URL: "https://pawhold.onrender.com:443/" })).toBe(
      "https://pawhold.onrender.com",
    );
    expect(liveBaseUrl({ PAWHOLD_LIVE_URL: "http://127.0.0.1:3000" })).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("refuses a base URL that is not an http or https origin", () => {
    expect(() => liveBaseUrl({ PAWHOLD_LIVE_URL: "pawhold.onrender.com" })).toThrow(
      /PAWHOLD_LIVE_URL/,
    );
    expect(() => liveBaseUrl({ PAWHOLD_LIVE_URL: "ftp://pawhold.onrender.com" })).toThrow(
      /PAWHOLD_LIVE_URL/,
    );
    expect(() => liveBaseUrl({ PAWHOLD_LIVE_URL: "https://pawhold.onrender.com/today" })).toThrow(
      /an origin/,
    );
    expect(() => liveBaseUrl({ PAWHOLD_LIVE_URL: "https://pawhold.onrender.com/?x=1" })).toThrow(
      /an origin/,
    );
  });

  it("reads the sandbox buyer's login from the repository's secrets, and never says it", () => {
    expect(
      smokeBuyer({
        PAWHOLD_SMOKE_BUYER_EMAIL: "sb-standin4buyer@personal.example.com",
        PAWHOLD_SMOKE_BUYER_PASSWORD: "Xx0@{*Yy",
      }),
    ).toEqual({ email: "sb-standin4buyer@personal.example.com", password: "Xx0@{*Yy" });

    const refused = (): unknown =>
      smokeBuyer({
        PAWHOLD_SMOKE_BUYER_EMAIL: "not-an-email-Xx0@{*Yy",
        PAWHOLD_SMOKE_BUYER_PASSWORD: "Xx0@{*Yy",
      });
    expect(refused).toThrow(
      "the live walk needs PAWHOLD_SMOKE_BUYER_EMAIL (an email) and PAWHOLD_SMOKE_BUYER_PASSWORD",
    );
    expect(() => smokeBuyer({})).toThrow(/PAWHOLD_SMOKE_BUYER_EMAIL/);
  });

  it("reads the health check's answer, up and down", () => {
    const commit = "9f9fb1c0853532e7c153df42036168b9bac38ef7";

    expect(healthAnswer.parse({ status: "ok", database: "reached", commit })).toEqual({
      status: "ok",
      database: "reached",
      commit,
    });
    expect(
      healthAnswer.parse({ status: "unavailable", database: "unreachable", commit: null }),
    ).toEqual({ status: "unavailable", database: "unreachable", commit: null });
    expect(
      healthAnswer.parse({ status: "ok", database: "reached", commit, region: "frankfurt" }),
    ).toEqual({ status: "ok", database: "reached", commit });
    expect(() => healthAnswer.parse({ status: "ok" })).toThrow();
    expect(() =>
      healthAnswer.parse({ status: "ok", database: "reached", commit: "main" }),
    ).toThrow();
  });
});
