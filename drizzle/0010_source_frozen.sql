-- The words a version was drafted from are the version's (U5): written and
-- replaced while it is a draft, and kept as they were once it is sent, as
-- the version itself is (migration 0003). A source is never written for a
-- version already sent, nor moved to another version, and the table is never
-- truncated.
CREATE FUNCTION "public"."estimate_source_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sent timestamptz;
  target uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target := NEW.version_id;
  ELSE
    target := OLD.version_id;
  END IF;
  SELECT sent_at INTO sent FROM "public"."estimate_version" WHERE id = target FOR SHARE;
  IF sent IS NOT NULL THEN
    RAISE EXCEPTION 'estimate version % was sent: the words it was drafted from never change (% refused)', target, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.version_id <> OLD.version_id OR NEW.case_id <> OLD.case_id
      OR NEW.practice_id <> OLD.practice_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'a source keeps its version, case, practice and kind'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "estimate_source_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."estimate_source"
  FOR EACH ROW EXECUTE FUNCTION "public"."estimate_source_guard"();
--> statement-breakpoint
CREATE FUNCTION "public"."estimate_source_refuse_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'estimate_source is kept with its versions: TRUNCATE refused'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "estimate_source_refuse_truncate"
  BEFORE TRUNCATE ON "public"."estimate_source"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."estimate_source_refuse_truncate"();
