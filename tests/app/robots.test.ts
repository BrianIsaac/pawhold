import { describe, expect, it } from "vitest";

import robots from "../../app/robots";

describe("robots.txt", () => {
  it("keeps crawlers off the doors, the owners' links and the API", () => {
    expect(robots().rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/try/", "/e/", "/api/"],
    });
  });
});
