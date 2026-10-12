-- Rule 1 counts what captures took: a capture PayPal declined or failed took
-- nothing, so it does not count against its hold, and a retry may take it.
CREATE OR REPLACE FUNCTION "public"."capture_within_hold"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  held integer;
  taken bigint;
BEGIN
  SELECT amount_pence INTO held FROM "public"."hold" WHERE id = NEW.hold_id;
  SELECT coalesce(sum(amount_pence), 0) INTO taken FROM "public"."capture"
    WHERE hold_id = NEW.hold_id AND status NOT IN ('declined', 'failed');
  IF taken > held THEN
    RAISE EXCEPTION 'captures of hold % would sum to % pence, above the hold of % pence',
      NEW.hold_id, taken, held
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "capture_within_hold" ON "public"."capture";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "capture_within_hold"
  AFTER INSERT OR UPDATE OF amount_pence, hold_id, status ON "public"."capture"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."capture_within_hold"();
