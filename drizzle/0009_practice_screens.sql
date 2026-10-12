-- drizzle-kit emitted this unique key after the foreign key that names it; moved first by hand (as U3's 0005).
ALTER TABLE "estimate_version" ADD CONSTRAINT "estimate_version_id_case_practice_key" UNIQUE("id","case_id","practice_id");--> statement-breakpoint
CREATE TYPE "public"."estimate_source_kind" AS ENUM('notes', 'finding');--> statement-breakpoint
CREATE TABLE "estimate_source" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" "estimate_source_kind" NOT NULL,
	"text" text NOT NULL,
	"unmatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unsupported" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure" jsonb,
	"explanation" text,
	"explanation_fell_back" text,
	"photo" "bytea",
	"photo_media_type" text,
	"photo_sha256" text,
	"photo_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_source_text_length" CHECK (char_length("estimate_source"."text") between 1 and 10000),
	CONSTRAINT "estimate_source_photo_complete" CHECK (("estimate_source"."photo" is null) = ("estimate_source"."photo_media_type" is null)
        and ("estimate_source"."photo" is null) = ("estimate_source"."photo_sha256" is null)),
	CONSTRAINT "estimate_source_photo_on_finding" CHECK ("estimate_source"."photo" is null or "estimate_source"."kind" = 'finding'),
	CONSTRAINT "estimate_source_photo_shared_with_photo" CHECK (not "estimate_source"."photo_shared" or "estimate_source"."photo" is not null),
	CONSTRAINT "estimate_source_photo_media_type" CHECK ("estimate_source"."photo_media_type" is null or "estimate_source"."photo_media_type" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
	CONSTRAINT "estimate_source_photo_size" CHECK ("estimate_source"."photo" is null or octet_length("estimate_source"."photo") between 1 and 5242880),
	CONSTRAINT "estimate_source_photo_sha256" CHECK ("estimate_source"."photo_sha256" is null or "estimate_source"."photo_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "estimate_source_explanation_on_finding" CHECK (("estimate_source"."explanation" is null and "estimate_source"."explanation_fell_back" is null) or "estimate_source"."kind" = 'finding')
);
--> statement-breakpoint
ALTER TABLE "patient_case" ADD COLUMN "vet_name" text;--> statement-breakpoint
ALTER TABLE "estimate_source" ADD CONSTRAINT "estimate_source_version_fk" FOREIGN KEY ("version_id","case_id","practice_id") REFERENCES "public"."estimate_version"("id","case_id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_source" ADD CONSTRAINT "estimate_source_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_source_case_id_idx" ON "estimate_source" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "patient_case" ADD CONSTRAINT "patient_case_vet_name_length" CHECK ("patient_case"."vet_name" is null or char_length("patient_case"."vet_name") between 1 and 100);