import { createDatabase } from "../src/db/client";
import { databaseEnvironment, paypalEnvironment, readEnvironment } from "../src/env";
import { runHourly } from "../src/jobs/hourly";
import { createPayPalClient } from "../src/paypal/client";

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
} finally {
  await database.close();
}
