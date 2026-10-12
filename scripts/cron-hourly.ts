import { createDatabase } from "../src/db/client";
import { databaseEnvironment, readEnvironment } from "../src/env";
import { runHourly } from "../src/jobs/hourly";

const database = createDatabase(readEnvironment(databaseEnvironment).DATABASE_URL, { max: 1 });
try {
  console.info("pawhold: hourly job", await runHourly(database.db));
} finally {
  await database.close();
}
