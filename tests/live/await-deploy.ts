import { z } from "zod";

import { awaitDeployment } from "./support/deployment";
import { liveBaseUrl } from "./support/target";

/*
 * `pnpm live:await-deploy`: the live smoke's first job after a push to
 * `main` (.github/workflows/live-smoke.yml). Waits up to ten minutes for the
 * deployment (`PAWHOLD_LIVE_URL`, else https://pawhold.onrender.com) to
 * report the pushed commit (`PAWHOLD_LIVE_COMMIT`) on its health check, and
 * fails the job when it does not.
 */

/** U10's brief: the walk waits up to ten minutes for the deploy. */
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** How often the health check is asked. */
const EVERY_MS = 15_000;

const commit = z.object({ PAWHOLD_LIVE_COMMIT: z.string().regex(/^[0-9a-f]{40}$/) });

/**
 * Waits, and answers the exit code.
 *
 * @returns 0 when the pushed commit is deployed, else 1.
 */
async function main(): Promise<number> {
  const parsed = commit.safeParse(process.env);
  if (!parsed.success) {
    console.error("pawhold live: PAWHOLD_LIVE_COMMIT must be the pushed commit's full SHA");
    return 1;
  }
  const baseUrl = liveBaseUrl();
  const result = await awaitDeployment({
    baseUrl,
    commit: parsed.data.PAWHOLD_LIVE_COMMIT,
    timeoutMs: TEN_MINUTES_MS,
    everyMs: EVERY_MS,
  });
  if (result.deployed) {
    console.info(
      `pawhold live: ${baseUrl} reports ${result.commit} after ${Math.round(result.waitedMs / 1000)} s`,
    );
    return 0;
  }
  console.error(
    `pawhold live: ${baseUrl} did not report ${parsed.data.PAWHOLD_LIVE_COMMIT} in ${Math.round(result.waitedMs / 1000)} s (${result.asks} asks); last: ${result.last}`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
