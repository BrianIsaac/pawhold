CREATE TYPE "public"."schedule_move_status" AS ENUM('proposed', 'applied', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."schedule_released_by" AS ENUM('practice', 'agent');--> statement-breakpoint
CREATE TABLE "schedule_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" "schedule_released_by",
	"move_booking_id" uuid,
	"move_to" timestamp with time zone,
	"move_status" "schedule_move_status",
	"move_decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_proposal_booking_version_key" UNIQUE("booking_id","version_id"),
	CONSTRAINT "schedule_proposal_reason_length" CHECK (char_length("schedule_proposal"."reason") between 1 and 500),
	CONSTRAINT "schedule_proposal_released_complete" CHECK (("schedule_proposal"."released_at" is null) = ("schedule_proposal"."released_by" is null)),
	CONSTRAINT "schedule_proposal_move_complete" CHECK (("schedule_proposal"."move_booking_id" is null) = ("schedule_proposal"."move_status" is null)
        and ("schedule_proposal"."move_booking_id" is null) = ("schedule_proposal"."move_to" is null)),
	CONSTRAINT "schedule_proposal_move_decided" CHECK (("schedule_proposal"."move_decided_at" is not null) = ("schedule_proposal"."move_status" is not null and "schedule_proposal"."move_status" <> 'proposed')),
	CONSTRAINT "schedule_proposal_move_another_booking" CHECK ("schedule_proposal"."move_booking_id" is null or "schedule_proposal"."move_booking_id" <> "schedule_proposal"."booking_id")
);
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_id_case_practice_key" UNIQUE("id","case_id","practice_id");
--> statement-breakpoint
ALTER TABLE "schedule_proposal" ADD CONSTRAINT "schedule_proposal_booking_fk" FOREIGN KEY ("booking_id","case_id","practice_id") REFERENCES "public"."booking"("id","case_id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposal" ADD CONSTRAINT "schedule_proposal_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposal" ADD CONSTRAINT "schedule_proposal_version_fk" FOREIGN KEY ("version_id","case_id","practice_id") REFERENCES "public"."estimate_version"("id","case_id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposal" ADD CONSTRAINT "schedule_proposal_move_booking_fk" FOREIGN KEY ("move_booking_id","practice_id") REFERENCES "public"."booking"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_proposal_one_open_per_booking_idx" ON "schedule_proposal" USING btree ("booking_id") WHERE "schedule_proposal"."released_at" is null;--> statement-breakpoint
CREATE INDEX "schedule_proposal_practice_idx" ON "schedule_proposal" USING btree ("practice_id","held_at");--> statement-breakpoint
CREATE INDEX "schedule_proposal_case_idx" ON "schedule_proposal" USING btree ("case_id");