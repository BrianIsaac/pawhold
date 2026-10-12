-- The audit trail is append-only (plan 3.5): the database itself refuses
-- UPDATE, DELETE and TRUNCATE on audit_event, whatever the caller.
CREATE FUNCTION "public"."audit_event_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_event_refuse_update_delete"
  BEFORE UPDATE OR DELETE ON "public"."audit_event"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_event_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "audit_event_refuse_truncate"
  BEFORE TRUNCATE ON "public"."audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_event_refuse_change"();
