-- A case's vet is one of its practice's vets (U11; U8a's finding 9): the
-- name a case's estimates are approved under is a row of `vet`, as its
-- bookings' vet is. A case opened before vets were named keeps a null name.
-- Every name already on a case becomes a vet of its practice first, so no
-- case is refused. Checked when the transaction commits, so a practice's
-- seed may write a case before the vets of its day.
INSERT INTO "vet" ("practice_id", "name")
SELECT DISTINCT "practice_id", "vet_name" FROM "patient_case" WHERE "vet_name" IS NOT NULL
ON CONFLICT ("practice_id", "name") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "patient_case" ADD CONSTRAINT "patient_case_vet_fk"
  FOREIGN KEY ("practice_id", "vet_name") REFERENCES "vet" ("practice_id", "name")
  ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
