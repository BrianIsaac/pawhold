CREATE TYPE "public"."price_category" AS ENUM('consultation', 'anaesthesia', 'procedure', 'imaging', 'laboratory', 'medication', 'hospitalisation', 'consumable');--> statement-breakpoint
CREATE TABLE "estimate_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"price_list_item_id" uuid NOT NULL,
	"unit_price_pence" integer NOT NULL,
	"quantity_low" integer NOT NULL,
	"quantity_high" integer NOT NULL,
	"low_pence" integer GENERATED ALWAYS AS (unit_price_pence * quantity_low) STORED NOT NULL,
	"high_pence" integer GENERATED ALWAYS AS (unit_price_pence * quantity_high) STORED NOT NULL,
	"depends_on" text,
	"notes_span" text,
	"owner_wording" text,
	CONSTRAINT "estimate_line_position_key" UNIQUE("version_id","position"),
	CONSTRAINT "estimate_line_position_positive" CHECK ("estimate_line"."position" >= 1),
	CONSTRAINT "estimate_line_quantity_range" CHECK ("estimate_line"."quantity_low" >= 0 and "estimate_line"."quantity_high" >= "estimate_line"."quantity_low" and "estimate_line"."quantity_high" >= 1)
);
--> statement-breakpoint
CREATE TABLE "estimate_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"total_low_pence" integer,
	"total_high_pence" integer,
	CONSTRAINT "estimate_version_case_number_key" UNIQUE("case_id","number"),
	CONSTRAINT "estimate_version_id_price_list_id_key" UNIQUE("id","price_list_id"),
	CONSTRAINT "estimate_version_number_positive" CHECK ("estimate_version"."number" >= 1),
	CONSTRAINT "estimate_version_totals_when_sent" CHECK (("estimate_version"."sent_at" is null and "estimate_version"."total_low_pence" is null and "estimate_version"."total_high_pence" is null)
        or ("estimate_version"."sent_at" is not null and "estimate_version"."total_low_pence" is not null and "estimate_version"."total_high_pence" is not null)),
	CONSTRAINT "estimate_version_totals_range" CHECK ("estimate_version"."total_low_pence" is null or ("estimate_version"."total_low_pence" >= 0 and "estimate_version"."total_high_pence" >= "estimate_version"."total_low_pence"))
);
--> statement-breakpoint
CREATE TABLE "price_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"currency_code" char(3) DEFAULT 'GBP' NOT NULL,
	"source_name" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_id_practice_id_key" UNIQUE("id","practice_id"),
	CONSTRAINT "price_list_currency_code" CHECK ("price_list"."currency_code" in ('GBP', 'USD'))
);
--> statement-breakpoint
CREATE TABLE "price_list_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "price_category" NOT NULL,
	"unit" text NOT NULL,
	"unit_price_pence" integer NOT NULL,
	CONSTRAINT "price_list_item_code_key" UNIQUE("price_list_id","code"),
	CONSTRAINT "price_list_item_priced_key" UNIQUE("id","price_list_id","unit_price_pence"),
	CONSTRAINT "price_list_item_unit_price_non_negative" CHECK ("price_list_item"."unit_price_pence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_version_fk" FOREIGN KEY ("version_id","price_list_id") REFERENCES "public"."estimate_version"("id","price_list_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_priced_from_list_fk" FOREIGN KEY ("price_list_item_id","price_list_id","unit_price_pence") REFERENCES "public"."price_list_item"("id","price_list_id","unit_price_pence") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_version" ADD CONSTRAINT "estimate_version_case_in_practice_fk" FOREIGN KEY ("case_id","practice_id") REFERENCES "public"."patient_case"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_version" ADD CONSTRAINT "estimate_version_price_list_in_practice_fk" FOREIGN KEY ("price_list_id","practice_id") REFERENCES "public"."price_list"("id","practice_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practice"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_price_list_id_price_list_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_list"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_line_item_idx" ON "estimate_line" USING btree ("price_list_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_version_one_draft_per_case_idx" ON "estimate_version" USING btree ("case_id") WHERE "estimate_version"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "price_list_practice_id_idx" ON "price_list" USING btree ("practice_id","imported_at");