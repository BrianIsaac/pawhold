-- A room and a vet are never booked twice at once (U8a). Exclusion
-- constraints over each booking's time range; btree_gist gives GiST the
-- uuid equality they compare rooms and vets by. Checked when the transaction
-- commits, so the agent's move can swap two bookings inside one transaction.
-- A range is [start, end): one booking may start as another ends.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_room_free"
  EXCLUDE USING gist ("room_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_vet_free"
  EXCLUDE USING gist ("vet_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&)
  DEFERRABLE INITIALLY DEFERRED;
