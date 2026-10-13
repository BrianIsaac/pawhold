import { createDatabase } from "../src/db/client";
import { databaseEnvironment, paypalEnvironment, readEnvironment } from "../src/env";
import { runHourly } from "../src/jobs/hourly";
import { describeLiveProbe, liveHealthUrl, probeLive } from "../src/jobs/live-probe";
import { createPayPalClient } from "../src/paypal/client";

const healthUrl = liveHealthUrl();
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
  console.info("pawhold: hourly job", JSON.stringify(await runHourly({ db: database.db, paypal })));
} catch (error) {
  console.error("pawhold: hourly job failed", error);
  process.exitCode = 1;
} finally {
  await database.close();
}

// The uptime alert (U14): Render emails the operator when a run fails, so a
// service that is not healthy at its public address fails this one, after
// the job's own work is done and logged.
const live = await probeLive({ url: healthUrl });
if (live.healthy) {
  console.info(describeLiveProbe(live));
} else {
  console.error(describeLiveProbe(live));
  process.exitCode = 1;
}
