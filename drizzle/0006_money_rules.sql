-- The money rules the database holds as well as the code (plan 3.2, U3).
-- Rule 1: a hold's captures never sum above the hold, so a case's captures
-- never sum above its holds. Checked when the capturing transaction commits.
CREATE FUNCTION "public"."capture_within_hold"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  held integer;
  taken bigint;
BEGIN
  SELECT amount_pence INTO held FROM "public"."hold" WHERE id = NEW.hold_id;
  SELECT coalesce(sum(amount_pence), 0) INTO taken FROM "public"."capture" WHERE hold_id = NEW.hold_id;
  IF taken > held THEN
    RAISE EXCEPTION 'captures of hold % would sum to % pence, above the hold of % pence',
      NEW.hold_id, taken, held
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "capture_within_hold"
  AFTER INSERT OR UPDATE OF amount_pence, hold_id ON "public"."capture"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."capture_within_hold"();
--> statement-breakpoint
-- A capture's refunds never sum above the capture (those PayPal failed or
-- cancelled returned nothing and do not count).
CREATE FUNCTION "public"."refund_within_capture"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  captured integer;
  returned bigint;
BEGIN
  SELECT amount_pence INTO captured FROM "public"."capture" WHERE id = NEW.capture_id;
  SELECT coalesce(sum(amount_pence), 0) INTO returned FROM "public"."refund"
    WHERE capture_id = NEW.capture_id AND status NOT IN ('failed', 'cancelled');
  IF returned > captured THEN
    RAISE EXCEPTION 'refunds of capture % would sum to % pence, above the capture of % pence',
      NEW.capture_id, returned, captured
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "refund_within_capture"
  AFTER INSERT OR UPDATE OF amount_pence, capture_id, status ON "public"."refund"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."refund_within_capture"();
--> statement-breakpoint
-- A signed-off bill holds exactly its lines' money, each line is allocated
-- whole to holds (rule 2), and no hold is allocated past its amount (rule 1).
CREATE FUNCTION "public"."bill_check_allocated"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_bill uuid;
  stated integer;
  billed bigint;
  unallocated record;
  excess record;
BEGIN
  IF TG_TABLE_NAME = 'bill' THEN
    target_bill := NEW.id;
  ELSIF TG_TABLE_NAME = 'bill_line' THEN
    target_bill := NEW.bill_id;
  ELSE
    SELECT l.bill_id INTO target_bill FROM "public"."bill_line" l WHERE l.id = NEW.bill_line_id;
  END IF;

  SELECT b.total_pence INTO stated FROM "public"."bill" b WHERE b.id = target_bill;
  SELECT coalesce(sum(l.amount_pence), 0) INTO billed FROM "public"."bill_line" l WHERE l.bill_id = target_bill;
  IF billed IS DISTINCT FROM stated THEN
    RAISE EXCEPTION 'bill % states % pence and its lines sum to %', target_bill, stated, billed
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT l.id, l.amount_pence, coalesce(sum(a.amount_pence), 0) AS allocated INTO unallocated
    FROM "public"."bill_line" l LEFT JOIN "public"."allocation" a ON a.bill_line_id = l.id
    WHERE l.bill_id = target_bill
    GROUP BY l.id, l.amount_pence
    HAVING coalesce(sum(a.amount_pence), 0) <> l.amount_pence
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'bill line % is % pence and % pence of it is allocated to holds',
      unallocated.id, unallocated.amount_pence, unallocated.allocated
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT h.id, h.amount_pence, sum(a.amount_pence) AS allocated INTO excess
    FROM "public"."allocation" a JOIN "public"."hold" h ON h.id = a.hold_id
    WHERE a.hold_id IN (
      SELECT a2.hold_id FROM "public"."allocation" a2
        JOIN "public"."bill_line" l2 ON l2.id = a2.bill_line_id
        WHERE l2.bill_id = target_bill)
    GROUP BY h.id, h.amount_pence
    HAVING sum(a.amount_pence) > h.amount_pence
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'hold % would be allocated % pence, above the hold of % pence',
      excess.id, excess.allocated, excess.amount_pence
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "bill_allocated"
  AFTER INSERT ON "public"."bill"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."bill_check_allocated"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "bill_line_allocated"
  AFTER INSERT ON "public"."bill_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."bill_check_allocated"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "allocation_within_bill"
  AFTER INSERT ON "public"."allocation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."bill_check_allocated"();
--> statement-breakpoint
-- A signed-off bill is kept as signed: its lines and their allocations are
-- never changed or removed.
CREATE FUNCTION "public"."money_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is kept as written: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "bill_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."bill"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "bill_line_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."bill_line"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "allocation_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."allocation"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
-- Holds, captures and refunds change status as PayPal answers, but are never
-- removed: the money's record outlives any screen.
CREATE TRIGGER "hold_refuse_delete"
  BEFORE DELETE ON "public"."hold"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "capture_refuse_delete"
  BEFORE DELETE ON "public"."capture"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "refund_refuse_delete"
  BEFORE DELETE ON "public"."refund"
  FOR EACH ROW EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_bill"
  BEFORE TRUNCATE ON "public"."bill"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_bill_line"
  BEFORE TRUNCATE ON "public"."bill_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_allocation"
  BEFORE TRUNCATE ON "public"."allocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_hold"
  BEFORE TRUNCATE ON "public"."hold"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_capture"
  BEFORE TRUNCATE ON "public"."capture"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "money_refuse_truncate_refund"
  BEFORE TRUNCATE ON "public"."refund"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."money_refuse_change"();
--> statement-breakpoint
-- What a hold, a capture or a refund is for never changes once written: the
-- case, the version, the amounts, PayPal's order and first authorisation.
CREATE FUNCTION "public"."hold_refuse_change_of_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.practice_id, NEW.case_id, NEW.version_number, NEW.version_high_pence,
      NEW.held_before_pence, NEW.amount_pence, NEW.currency_code, NEW.paypal_order_id)
    IS DISTINCT FROM
     (OLD.id, OLD.practice_id, OLD.case_id, OLD.version_number, OLD.version_high_pence,
      OLD.held_before_pence, OLD.amount_pence, OLD.currency_code, OLD.paypal_order_id)
    OR (OLD.original_authorization_id IS NOT NULL
      AND NEW.original_authorization_id IS DISTINCT FROM OLD.original_authorization_id) THEN
    RAISE EXCEPTION 'hold %: what it holds never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "hold_refuse_change_of_terms"
  BEFORE UPDATE ON "public"."hold"
  FOR EACH ROW EXECUTE FUNCTION "public"."hold_refuse_change_of_terms"();
--> statement-breakpoint
CREATE FUNCTION "public"."capture_refuse_change_of_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.hold_id, NEW.sequence, NEW.paypal_capture_id, NEW.authorization_id,
      NEW.amount_pence, NEW.currency_code, NEW.final_capture)
    IS DISTINCT FROM
     (OLD.id, OLD.hold_id, OLD.sequence, OLD.paypal_capture_id, OLD.authorization_id,
      OLD.amount_pence, OLD.currency_code, OLD.final_capture) THEN
    RAISE EXCEPTION 'capture %: what it took never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "capture_refuse_change_of_terms"
  BEFORE UPDATE ON "public"."capture"
  FOR EACH ROW EXECUTE FUNCTION "public"."capture_refuse_change_of_terms"();
--> statement-breakpoint
CREATE FUNCTION "public"."refund_refuse_change_of_terms"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.capture_id, NEW.sequence, NEW.amount_pence, NEW.currency_code, NEW.reason,
      NEW.requested_by)
    IS DISTINCT FROM
     (OLD.id, OLD.capture_id, OLD.sequence, OLD.amount_pence, OLD.currency_code, OLD.reason,
      OLD.requested_by)
    OR (OLD.paypal_refund_id IS NOT NULL
      AND NEW.paypal_refund_id IS DISTINCT FROM OLD.paypal_refund_id) THEN
    RAISE EXCEPTION 'refund %: what it returns never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "refund_refuse_change_of_terms"
  BEFORE UPDATE ON "public"."refund"
  FOR EACH ROW EXECUTE FUNCTION "public"."refund_refuse_change_of_terms"();
