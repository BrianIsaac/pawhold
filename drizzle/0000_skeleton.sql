CREATE TYPE "public"."audit_actor" AS ENUM('vet', 'owner', 'system', 'schedule_agent', 'paypal_webhook');--> statement-breakpoint
CREATE TYPE "public"."money_state" AS ENUM('estimate_draft', 'awaiting_owner', 'held', 'update_awaiting_owner', 'update_declined', 'captured', 'released', 'refunded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."practice_kind" AS ENUM('showcase', 'judge');--> statement-breakpoint
CREATE TYPE "public"."session_door" AS ENUM('practice', 'owner');--> statement-breakpoint
CREATE TYPE "public"."webhook_verification" AS ENUM('signature', 'postback');--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"practice_id" uuid,
	"case_id" uuid,
	"actor" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"money_state_before" "money_state",
	"money_state_after" "money_state",
	"amount_pence" integer,
	"currency_code" char(3),
	"paypal_order_id" text,
	"paypal_authorization_id" text,
	"paypal_capture_id" text,
	"paypal_refund_id" text,
	"paypal_debug_id" text,
	"webhook_event_id" text,
	"webhook_verified" boolean,
	"model_id" text,
	"model_input_sha256" text,
	"model_output" jsonb,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_event_action_shape" CHECK ("audit_event"."action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$'),
	CONSTRAINT "audit_event_amount_with_currency" CHECK (("audit_event"."amount_pence" is null) = ("audit_event"."currency_code" is null)),
	CONSTRAINT "audit_event_amount_non_negative" CHECK ("audit_event"."amount_pence" is null or "audit_event"."amount_pence" >= 0),
	CONSTRAINT "audit_event_currency_code" CHECK ("audit_event"."currency_code" is null or "audit_event"."currency_code" in ('GBP', 'USD')),
	CONSTRAINT "audit_event_case_needs_practice" CHECK ("audit_event"."case_id" is null or "audit_event"."practice_id" is not null),
	CONSTRAINT "audit_event_model_step_complete" CHECK (("audit_event"."model_id" is null and "audit_event"."model_input_sha256" is null and "audit_event"."model_output" is null)
        or ("audit_event"."model_id" is not null and "audit_event"."model_input_sha256" is not null)),
	CONSTRAINT "audit_event_model_input_sha256" CHECK ("audit_event"."model_input_sha256" is null or "audit_event"."model_input_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "patient_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_name" text NOT NULL,
	"owner_name" text NOT NULL,
	"procedure" text NOT NULL,
	"money_state" "money_state" DEFAULT 'estimate_draft' NOT NULL,
	"currency_code" char(3) DEFAULT 'GBP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_case_id_practice_id_key" UNIQUE("id","practice_id"),
	CONSTRAINT "patient_case_currency_code" CHECK ("patient_case"."currency_code" in ('GBP', 'USD'))
);
--> statement-breakpoint
CREATE TABLE "practice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "practice_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"door" "session_door" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_expires_after_creation" CHECK ("session"."expires_at" > "session"."created_at")
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"summary" text,
	"event_created_at" timestamp with time zone,
	"transmission_id" text NOT NULL,
	"transmission_time" text NOT NULL,
	"cert_url" text,
	"auth_algo" text NOT NULL,
	"verification" "webhook_verification" NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"raw_body" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_webhook_event_id_webhook_event_event_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_event"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_case" ADD CONSTRAINT "patient_case_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_case_id_idx" ON "audit_event" USING btree ("case_id","id");--> statement-breakpoint
CREATE INDEX "audit_event_practice_id_idx" ON "audit_event" USING btree ("practice_id","id");--> statement-breakpoint
CREATE INDEX "patient_case_practice_id_idx" ON "patient_case" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "session_practice_id_idx" ON "session" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_event_resource_id_idx" ON "webhook_event" USING btree ("resource_id");