-- One escalation step of a given kind per parent, enforced by Postgres.
--
-- The application already checks for an existing child before queueing a step,
-- but that is a read followed by a write: two duplicate Twilio status callbacks
-- arriving milliseconds apart can both see "no child yet" and both insert. The
-- result is the caregiver called twice, or texted twice, about one missed dose.
--
-- NULLs are distinct in a Postgres unique index, so escalations with no parent
-- recorded (the database was unreachable when the reminder call was placed) are
-- unaffected and can still coexist.
--
-- Replaces the plain parent_id index from the previous migration — this one is
-- also usable for lookups by parent_id, since it leads with that column.

DROP INDEX "call_history_parent_id_idx";

CREATE UNIQUE INDEX "call_history_parent_id_kind_key" ON "call_history"("parent_id", "kind");
