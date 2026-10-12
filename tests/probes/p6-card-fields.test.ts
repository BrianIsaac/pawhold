import { describe, expect, it } from "vitest";

import { cardPageHtml, serveCardPage } from "../../probes/card-page";

import { replayRecorded } from "./support";

describe("P6, card fields in GBP, over the sandbox's recorded answers", () => {
  it("authorises three card holds, repeats P2 and P3 on them and leaves one standing for P5 (c)", async () => {
    const { replayed } = await replayRecorded("P6");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "card.p2: submit state": "succeeded",
        "card.p2: authorisation status": "CREATED",
        "card.p2: capture status": "COMPLETED",
        "card.p2: captured (pence)": 6_400,
        "card.p2: authorisation status after": "CAPTURED",
        "card.p3: first capture": "COMPLETED",
        "card.p3: second capture": "COMPLETED",
        "card.p3: authorisation status after": "CAPTURED",
        "card.p5c: authorisation status": "CREATED",
      },
    });
    const kept = replayed.cleanup?.rows.filter((r) => r.kept !== null) ?? [];
    expect(kept.map((r) => r.status)).toEqual(["CREATED"]);
    expect(replayed.cleanup?.clean).toBe(true);
  });
});

describe("P6's local card page", () => {
  it("loads the v6 SDK from PayPal's sandbox and writes the client id as a string that cannot close the script", () => {
    const html = cardPageHtml('id"</script><script>alert(1)//');

    expect(html).toContain('src="https://www.sandbox.paypal.com/web-sdk/v6/core"');
    expect(html).toContain('clientId: "id\\"\\u003c/script>\\u003cscript>alert(1)//"');
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain('components: ["card-fields"]');
  });

  it("serves the page on localhost and nothing else", async () => {
    const server = await serveCardPage("CLIENT");
    try {
      expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      const page = await fetch(server.url.replace("localhost", "127.0.0.1"));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('clientId: "CLIENT"');
      expect((await fetch(`${server.url.replace("localhost", "127.0.0.1")}other`)).status).toBe(
        404,
      );
    } finally {
      await server.close();
    }
  });
});
