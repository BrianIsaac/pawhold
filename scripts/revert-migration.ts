import { z } from "zod";

import { revertMigration } from "../src/db/revert";

const databaseUrl = z
  .url({ protocol: /^postgres(ql)?$/ })
  .parse(process.env.DATABASE_URL, { error: () => "DATABASE_URL must be a Postgres URL" });

const file = z
  .string({ error: () => "name the step: pnpm db:revert drizzle/revert/<file>.sql" })
  .parse(process.argv[2]);

await revertMigration(databaseUrl, file);
console.info(`pawhold: ${file} applied`);
