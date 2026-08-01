-- Fix: the init migration's day-of-week check let an EMPTY array through.
--
-- array_length(ARRAY[]::int[], 1) returns NULL rather than 0, and
-- `NULL BETWEEN 1 AND 7` evaluates to NULL. A CHECK constraint rejects a row
-- only when the expression is FALSE — NULL passes. So `days_of_week = {}` was
-- accepted: a schedule that is enabled, looks fine in a UI, and can never
-- match a day, i.e. a reminder call that silently never fires.
--
-- cardinality() returns 0 for an empty array, so the comparison is FALSE and
-- the row is correctly rejected.

ALTER TABLE "schedules" DROP CONSTRAINT "schedules_days_of_week_check";

ALTER TABLE "schedules" ADD CONSTRAINT "schedules_days_of_week_check"
  CHECK (
    cardinality("days_of_week") BETWEEN 1 AND 7
    AND "days_of_week" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
  );
