import { z } from "zod";

import { migrateDatabase } from "../src/db/migrate";

const databaseUrl = z
  .url({ protocol: /^postgres(ql)?$/ })
  .parse(process.env.DATABASE_URL, { error: () => "DATABASE_URL must be a Postgres URL" });

await migrateDatabase(databaseUrl);
console.info("pawhold: migrations applied");
