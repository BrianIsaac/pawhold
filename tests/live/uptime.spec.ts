import { expect, test } from "@playwright/test";

import { healthAnswer } from "./support/target";

/*
 * The uptime check (plan 7.4, D8; U10): the deployment answers its health
 * check with the database reached, and its landing page draws the heading
 * and both doors. It asks with plain requests, opens no browser and follows
 * no door, since each door seeds a practice (U9's "To U10"). A failed run
 * is GitHub's workflow-failure email to the operator.
 */

/** Section 6's landing heading. */
const HEADING = "Estimates your clients can say yes to.";

test("the deployment answers its health check with the database reached", async ({ request }) => {
  const response = await request.get("/api/health", { timeout: 30_000 });

  expect(response.status(), "GET /api/health").toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const health = healthAnswer.parse(await response.json());
  expect(health).toMatchObject({ status: "ok", database: "reached" });
  test.info().annotations.push({ type: "deployed commit", description: String(health.commit) });
  console.info(`pawhold live: deployed commit ${String(health.commit)}`);
});

test("the landing page draws its heading and both doors, without opening one", async ({
  request,
}) => {
  const response = await request.get("/", { timeout: 30_000 });

  expect(response.status(), "GET /").toBe(200);
  const html = await response.text();
  expect(html).toContain(`<h1`);
  expect(html).toContain(HEADING);
  expect(html).toContain('href="/try/practice"');
  expect(html).toContain('href="/try/owner"');
});
