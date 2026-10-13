-- A case records its animal's species (U17): a dog, a cat or another
-- animal. A case opened before this migration becomes "other", as nothing on
-- it says which it is and "other" claims least (the owner's page draws a
-- paw); a case the seed wrote (its "case.opened" says "seeded") takes the
-- species the seed now gives its name, so a judge's session that is still
-- open shows Otis as a dog. The default fills every case in the one
-- statement (no rewrite of the table on Postgres 11 and later), then goes,
-- so every case opened from now on names its species. The way back:
-- drizzle/revert/0015_case_species.*.sql.
CREATE TYPE "public"."animal_species" AS ENUM('dog', 'cat', 'other');--> statement-breakpoint
ALTER TABLE "patient_case" ADD COLUMN "species" "animal_species" DEFAULT 'other' NOT NULL;--> statement-breakpoint
UPDATE "patient_case" SET "species" = "seeded"."species"::"animal_species"
FROM (VALUES
  ('Archie', 'dog'), ('Biscuit', 'dog'), ('Bramble', 'dog'), ('Clover', 'cat'),
  ('Hazel', 'dog'), ('Juno', 'dog'), ('Luna', 'dog'), ('Milo', 'cat'),
  ('Moss', 'other'), ('Otis', 'dog'), ('Pip', 'dog'), ('Poppy', 'cat'),
  ('Rufus', 'dog'), ('Teddy', 'dog'), ('Willow', 'dog')
) AS "seeded" ("patient_name", "species")
WHERE "patient_case"."patient_name" = "seeded"."patient_name"
  AND EXISTS (
    SELECT 1 FROM "audit_event"
    WHERE "audit_event"."case_id" = "patient_case"."id"
      AND "audit_event"."action" = 'case.opened'
      AND "audit_event"."detail" @> '{"seeded": true}'::jsonb
  );--> statement-breakpoint
ALTER TABLE "patient_case" ALTER COLUMN "species" DROP DEFAULT;
