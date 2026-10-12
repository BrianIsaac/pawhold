ALTER TABLE "refund" DROP CONSTRAINT "refund_answered_with_id";--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_answered_with_id" CHECK (("refund"."status" <> 'requested' or "refund"."paypal_refund_id" is null)
        and ("refund"."status" not in ('pending', 'completed') or "refund"."paypal_refund_id" is not null));