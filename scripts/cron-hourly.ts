import { createDatabase } from "../src/db/client";
import { databaseEnvironment, paypalEnvironment, readEnvironment } from "../src/env";
import { runHourly } from "../src/jobs/hourly";
import { describeLiveProbe, liveHealthUrl, probeLive } from "../src/jobs/live-probe";
import { createPayPalClient } from "../src/paypal/client";

/**
 * The job's own work (plan 7.3): every part of `runHourly`, reported in one line.
 *
 * @returns Resolves once the report is logged and the database is closed.
 */
async function work(): Promise<void> {
  const database = createDatabase(readEnvironment(databaseEnvironment).DATABASE_URL, { max: 1 });
  const credentials = paypalEnvironment.safeParse(process.env);
  if (!credentials.success) {
    console.warn(
      "pawhold: hourly job without PayPal's credentials: the reauthorisation rule is skipped",
    );
  }
  const paypal = credentials.success
    ? createPayPalClient({
        clientId: credentials.data.PAYPAL_CLIENT_ID,
        clientSecret: credentials.data.PAYPAL_CLIENT_SECRET,
        environment: credentials.data.PAYPAL_ENV,
      })
    : null;
  try {
    const report = await runHourly({ db: database.db, paypal });
    console.info("pawhold: hourly job", JSON.stringify(report));
  } finally {
    await database.close();
  }
}

try {
  await work();
} catch (error) {
  console.error("pawhold: hourly job failed", error);
  process.exitCode = 1;
}

// The uptime alert (U14): Render emails the operator when a run fails, so a
// service that is not healthy at its public address fails this one, after
// the job's own work is done and logged, however that work ended. An
// address that cannot be read fails it the same way, never the work before it.
try {
  const live = await probeLive({ url: liveHealthUrl() });
  if (live.healthy) {
    console.info(describeLiveProbe(live));
  } else {
    console.error(describeLiveProbe(live));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `pawhold: live probe failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
