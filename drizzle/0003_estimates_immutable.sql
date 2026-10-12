-- A price list is kept as imported (plan 3.3): a new import makes a new list,
-- so every version's lines stay priced from the list they were priced from.
CREATE FUNCTION "public"."price_list_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is kept as imported: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "price_list_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."price_list"
  FOR EACH ROW EXECUTE FUNCTION "public"."price_list_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "price_list_item_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."price_list_item"
  FOR EACH ROW EXECUTE FUNCTION "public"."price_list_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "price_list_refuse_truncate"
  BEFORE TRUNCATE ON "public"."price_list"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."price_list_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "price_list_item_refuse_truncate"
  BEFORE TRUNCATE ON "public"."price_list_item"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."price_list_refuse_change"();
--> statement-breakpoint
-- A list holds exactly the items it was imported with, checked when the
-- importing transaction commits: an item added to a list later, or a list
-- stored without its items, is refused.
CREATE FUNCTION "public"."price_list_check_item_count"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  list_id uuid;
  expected integer;
  held integer;
BEGIN
  IF TG_TABLE_NAME = 'price_list' THEN
    list_id := NEW.id;
  ELSE
    list_id := NEW.price_list_id;
  END IF;
  SELECT item_count INTO expected FROM "public"."price_list" WHERE id = list_id;
  SELECT count(*) INTO held FROM "public"."price_list_item" WHERE price_list_id = list_id;
  IF held IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'price list % was imported with % items and would hold %: it is kept as imported',
      list_id, expected, held
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "price_list_item_count"
  AFTER INSERT ON "public"."price_list"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."price_list_check_item_count"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "price_list_item_in_count"
  AFTER INSERT ON "public"."price_list_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."price_list_check_item_count"();
--> statement-breakpoint
-- An estimate version is made as a draft and never changes once sent (plan
-- 3.3): a change is a new version. Sending sets the totals, which must be the
-- sums of the version's lines; a version is sent with at least one line. A
-- draft keeps its case, practice, number and creation time.
CREATE FUNCTION "public"."estimate_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  line_count integer;
  low_sum bigint;
  high_sum bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'an estimate version is made as a draft, not stored as sent'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'estimate version % was sent and never changes: % refused', OLD.number, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.case_id <> OLD.case_id OR NEW.practice_id <> OLD.practice_id
     OR NEW.number <> OLD.number OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an estimate version keeps its case, practice, number and creation time'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.sent_at IS NOT NULL THEN
    SELECT count(*), coalesce(sum(low_pence), 0), coalesce(sum(high_pence), 0)
      INTO line_count, low_sum, high_sum
      FROM "public"."estimate_line" WHERE version_id = NEW.id;
    IF line_count = 0 THEN
      RAISE EXCEPTION 'estimate version % has no lines to send', NEW.number
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.total_low_pence IS DISTINCT FROM low_sum OR NEW.total_high_pence IS DISTINCT FROM high_sum THEN
      RAISE EXCEPTION 'estimate version % is sent with totals % to %, its lines come to % to %',
        NEW.number, NEW.total_low_pence, NEW.total_high_pence, low_sum, high_sum
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "estimate_version_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."estimate_version"
  FOR EACH ROW EXECUTE FUNCTION "public"."estimate_version_guard"();
--> statement-breakpoint
CREATE FUNCTION "public"."estimate_refuse_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% holds sent estimates: TRUNCATE refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "estimate_version_refuse_truncate"
  BEFORE TRUNCATE ON "public"."estimate_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."estimate_refuse_truncate"();
--> statement-breakpoint
CREATE TRIGGER "estimate_line_refuse_truncate"
  BEFORE TRUNCATE ON "public"."estimate_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."estimate_refuse_truncate"();
--> statement-breakpoint
-- A sent version's lines never change. The version row is read FOR SHARE, so
-- a line written while the version is being sent waits for the send and is
-- then refused, or the send waits for the line and counts it.
CREATE FUNCTION "public"."estimate_line_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
  sent timestamptz;
BEGIN
  FOREACH affected IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.version_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.version_id END
  ] LOOP
    CONTINUE WHEN affected IS NULL;
    SELECT sent_at INTO sent FROM "public"."estimate_version" WHERE id = affected FOR SHARE;
    IF sent IS NOT NULL THEN
      RAISE EXCEPTION 'the lines of a sent estimate version never change: % refused', TG_OP
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "estimate_line_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."estimate_line"
  FOR EACH ROW EXECUTE FUNCTION "public"."estimate_line_guard"();
