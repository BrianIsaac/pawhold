-- The way back from 0015 (U17), second of two steps, run once the service is
-- on the code from before 0015, which never reads the species. Every case is
-- kept; only its species goes. Migration 0015's row in drizzle's journal goes
-- with it, so the next deploy that carries 0015 runs it again (every case
-- then becomes "other", as on the first run).
--   corepack pnpm db:revert drizzle/revert/0015_case_species.2-drop.sql
ALTER TABLE "patient_case" DROP COLUMN "species";--> statement-breakpoint
DROP TYPE "public"."animal_species";--> statement-breakpoint
-- 1791902508659 is 0015's "when" in drizzle/meta/_journal.json.
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791902508659;
