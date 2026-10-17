-- The way back from 0015 (U17), first of two steps, run while the code with
-- the species still serves: a case opened without a species becomes "other"
-- again, so the code from before 0015, which never names one, can open cases
-- once the service is rolled back. Changes no case. Take the way back from
-- any later migration first (0016's), newest first: drizzle runs a migration
-- again only when it is newer than the last it ran.
--   corepack pnpm db:revert drizzle/revert/0015_case_species.1-allow-unset.sql
-- Then roll the service back to the deploy before U17, then run step 2.
ALTER TABLE "patient_case" ALTER COLUMN "species" SET DEFAULT 'other';
