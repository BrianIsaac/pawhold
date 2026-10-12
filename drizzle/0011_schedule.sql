CREATE TYPE "public"."booking_kind" AS ENUM('procedure', 'consult');--> statement-breakpoint
CREATE TYPE "public"."room_kind" AS ENUM('theatre', 'consult');--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"vet_id" uuid NOT NULL,
	"kind" "booking_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_id_practice_id_key" UNIQUE("id","practice_id"),
	CONSTRAINT "booking_length" CHECK ("booking"."ends_at" - "booking"."starts_at" between interval '15 minutes' and interval '12 hours'),
	CONSTRAINT "booking_on_five_minute_marks" CHECK (extract(epoch from "booking"."starts_at") % 300 = 0 and extract(epoch from "booking"."ends_at") % 300 = 0)
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "room_kind" NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_practice_name_key" UNIQUE("practice_id","name"),
	CONSTRAINT "room_practice_position_key" UNIQUE("practice_id","position"),
	CONSTRAINT "room_id_practice_id_key" UNIQUE("id","practice_id"),
	CONSTRAINT "room_name_length" CHECK (char_length("room"."name") between 1 and 60),
	CONSTRAINT "room_position_positive" CHECK ("room"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "vet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_practice_name_key" UNIQUE("practice_id","name"),
	CONSTRAINT "vet_id_practice_id_key" UNIQUE("id","practice_id"),
	CONSTRAINT "vet_name_length" CHECK (char_length("vet"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "practice" ADD COLUMN "schedule_lead_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice" ADD COLUMN "time_zone" text DEFAULT 'Europe/London' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_room_in_practice_fk" FOREIGN KEY ("room_id","practice_id") REFERENCES "public"."room"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_vet_in_practice_fk" FOREIGN KEY ("vet_id","practice_id") REFERENCES "public"."vet"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet" ADD CONSTRAINT "vet_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_practice_starts_at_idx" ON "booking" USING btree ("practice_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_case_id_idx" ON "booking" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_schedule_lead_minutes_range" CHECK ("practice"."schedule_lead_minutes" between 5 and 240);--> statement-breakpoint
ALTER TABLE "practice" ADD CONSTRAINT "practice_time_zone_length" CHECK (char_length("practice"."time_zone") between 1 and 64);