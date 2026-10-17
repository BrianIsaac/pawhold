-- A card hold may be reauthorised as a wallet hold is (U3b): P5 (c) on
-- 17 October 2026 saw PayPal's sandbox reauthorise a card hold, against its
-- documentation, so the hourly job extends card holds too. The check that a
-- reauthorised hold was a wallet's becomes the check that it carries a new
-- authorisation id, whatever its kind. Every row passes it: the old check
-- asked that and more. The way back:
-- drizzle/revert/0016_hold_reauthorised_any_kind.sql.
ALTER TABLE "hold" DROP CONSTRAINT "hold_reauthorised_wallet_only";--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_reauthorised_new_authorisation" CHECK ("hold"."reauthorised_at" is null
        or "hold"."authorization_id" <> "hold"."original_authorization_id");