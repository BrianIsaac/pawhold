-- The unique keys the money tables' foreign keys name come first: drizzle-kit
-- emits them after the foreign keys, which Postgres would refuse.
ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_priced_key" UNIQUE("id","unit_price_pence");
--> statement-breakpoint
ALTER TABLE "estimate_version" ADD CONSTRAINT "estimate_version_hold_key" UNIQUE("id","case_id","number","total_high_pence");
--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('completed', 'pending', 'declined', 'partially_refunded', 'refunded', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('ordered', 'authorised', 'captured', 'voided', 'expired', 'withdrawn', 'declined');
--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('paypal', 'card');
--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'pending', 'completed', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TABLE "allocation" (
	"bill_line_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"amount_pence" integer NOT NULL,
	CONSTRAINT "allocation_pkey" PRIMARY KEY("bill_line_id","hold_id"),
	CONSTRAINT "allocation_amount_positive" CHECK ("allocation"."amount_pence" > 0)
);
--> statement-breakpoint
CREATE TABLE "bill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"currency_code" char(3) NOT NULL,
	"total_pence" integer NOT NULL,
	"signed_off_by" "audit_actor" NOT NULL,
	"signed_off_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "bill_case_id_key" UNIQUE("case_id"),
	CONSTRAINT "bill_currency_code" CHECK ("bill"."currency_code" in ('GBP', 'USD')),
	CONSTRAINT "bill_total_non_negative" CHECK ("bill"."total_pence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bill_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"estimate_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_pence" integer NOT NULL,
	"amount_pence" integer GENERATED ALWAYS AS (unit_price_pence * quantity) STORED NOT NULL,
	CONSTRAINT "bill_line_position_key" UNIQUE("bill_id","position"),
	CONSTRAINT "bill_line_estimate_line_key" UNIQUE("bill_id","estimate_line_id"),
	CONSTRAINT "bill_line_position_positive" CHECK ("bill_line"."position" >= 1),
	CONSTRAINT "bill_line_quantity_positive" CHECK ("bill_line"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "capture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"paypal_capture_id" text NOT NULL,
	"authorization_id" text NOT NULL,
	"amount_pence" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"final_capture" boolean NOT NULL,
	"status" "capture_status" NOT NULL,
	"paypal_fee_pence" integer,
	"net_pence" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_paypal_capture_id_key" UNIQUE("paypal_capture_id"),
	CONSTRAINT "capture_sequence_key" UNIQUE("hold_id","sequence"),
	CONSTRAINT "capture_sequence_positive" CHECK ("capture"."sequence" >= 1),
	CONSTRAINT "capture_amount_positive" CHECK ("capture"."amount_pence" > 0),
	CONSTRAINT "capture_currency_code" CHECK ("capture"."currency_code" in ('GBP', 'USD')),
	CONSTRAINT "capture_fee_non_negative" CHECK ("capture"."paypal_fee_pence" is null or "capture"."paypal_fee_pence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hold" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"version_high_pence" integer NOT NULL,
	"held_before_pence" integer NOT NULL,
	"amount_pence" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"status" "hold_status" DEFAULT 'ordered' NOT NULL,
	"paypal_order_id" text NOT NULL,
	"authorization_id" text,
	"original_authorization_id" text,
	"payment_kind" "payment_kind",
	"authorised_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"reauthorised_at" timestamp with time zone,
	"reauthorise_refused_at" timestamp with time zone,
	"honour_period_flagged_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hold_paypal_order_id_key" UNIQUE("paypal_order_id"),
	CONSTRAINT "hold_authorization_id_key" UNIQUE("authorization_id"),
	CONSTRAINT "hold_original_authorization_id_key" UNIQUE("original_authorization_id"),
	CONSTRAINT "hold_currency_code" CHECK ("hold"."currency_code" in ('GBP', 'USD')),
	CONSTRAINT "hold_held_before_non_negative" CHECK ("hold"."held_before_pence" >= 0),
	CONSTRAINT "hold_amount_is_increase" CHECK ("hold"."amount_pence" > 0 and "hold"."amount_pence" = "hold"."version_high_pence" - "hold"."held_before_pence"),
	CONSTRAINT "hold_authorisation_with_status" CHECK (("hold"."status" in ('ordered', 'withdrawn', 'declined')) = ("hold"."authorization_id" is null)),
	CONSTRAINT "hold_authorisation_complete" CHECK (("hold"."authorization_id" is null) = ("hold"."original_authorization_id" is null)
        and ("hold"."authorization_id" is null) = ("hold"."payment_kind" is null)
        and ("hold"."authorization_id" is null) = ("hold"."authorised_at" is null)),
	CONSTRAINT "hold_reauthorised_wallet_only" CHECK ("hold"."reauthorised_at" is null
        or ("hold"."payment_kind" = 'paypal' and "hold"."authorization_id" <> "hold"."original_authorization_id")),
	CONSTRAINT "hold_closed_with_status" CHECK (("hold"."status" in ('ordered', 'authorised')) = ("hold"."closed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"amount_pence" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"reason" text NOT NULL,
	"requested_by" "audit_actor" NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"paypal_refund_id" text,
	"refunded_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_paypal_refund_id_key" UNIQUE("paypal_refund_id"),
	CONSTRAINT "refund_sequence_key" UNIQUE("capture_id","sequence"),
	CONSTRAINT "refund_sequence_positive" CHECK ("refund"."sequence" >= 1),
	CONSTRAINT "refund_amount_positive" CHECK ("refund"."amount_pence" > 0),
	CONSTRAINT "refund_currency_code" CHECK ("refund"."currency_code" in ('GBP', 'USD')),
	CONSTRAINT "refund_reason_length" CHECK (char_length("refund"."reason") between 1 and 500),
	CONSTRAINT "refund_answered_with_id" CHECK (("refund"."status" = 'requested') = ("refund"."paypal_refund_id" is null))
);
--> statement-breakpoint
ALTER TABLE "webhook_event" ADD COLUMN "transmission_sig" text;
--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_bill_line_id_bill_line_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_line"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_hold_id_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."hold"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bill" ADD CONSTRAINT "bill_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_bill_id_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bill"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_priced_from_estimate_fk" FOREIGN KEY ("estimate_line_id","unit_price_pence") REFERENCES "public"."estimate_line"("id","unit_price_pence") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_hold_id_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."hold"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_version_fk" FOREIGN KEY ("id","case_id","version_number","version_high_pence") REFERENCES "public"."estimate_version"("id","case_id","number","total_high_pence") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_capture_id_capture_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."capture"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "allocation_hold_id_idx" ON "allocation" USING btree ("hold_id");
--> statement-breakpoint
CREATE INDEX "hold_case_id_idx" ON "hold" USING btree ("case_id","version_number");