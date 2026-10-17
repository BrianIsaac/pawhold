-- The way back from 0016 (U3b), one step, run once the service is on the code
-- from before 0016, which never reauthorises a card hold. The wallet-only
-- check comes back for every row written from then on; a card hold already
-- reauthorised is kept as it is (the check is added NOT VALID, so it is not
-- held to it), and the old code captures and voids it against its new
-- authorisation as it would a wallet hold's. Migration 0016's row in
-- drizzle's journal goes with it, so the next deploy that carries 0016 runs
-- it again. Take the way back from any later migration first, newest first:
-- drizzle runs a migration again only when it is newer than the last it ran.
--   corepack pnpm db:revert drizzle/revert/0016_hold_reauthorised_any_kind.sql
ALTER TABLE "hold" DROP CONSTRAINT "hold_reauthorised_new_authorisation";--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_reauthorised_wallet_only" CHECK ("hold"."reauthorised_at" is null
        or ("hold"."payment_kind" = 'paypal' and "hold"."authorization_id" <> "hold"."original_authorization_id")) NOT VALID;--> statement-breakpoint
-- 1792202745759 is 0016's "when" in drizzle/meta/_journal.json.
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792202745759;
