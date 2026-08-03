-- Stage 4: the escalation chain.
--
-- Two additions, no rewrites — every existing row keeps working unchanged:
--
--   schedules.escalation_ack_minutes  how long the fallback contact has to
--                                     acknowledge the escalation CALL before
--                                     the follow-up SMS goes out anyway.
--
--   call_history.parent_id            links a chain step to the step that
--                                     caused it. NULL on every existing row,
--                                     which is correct: those were single-step
--                                     escalations with no parent recorded.

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN "escalation_ack_minutes" INTEGER NOT NULL DEFAULT 3;

-- A zero or negative window would make the follow-up SMS due the instant the
-- escalation call is placed, so the caregiver's phone would ring and buzz at the
-- same moment and acknowledging could never suppress the text. The ceiling keeps
-- an alert from being deferred past the point of being useful.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_escalation_ack_minutes_check"
  CHECK ("escalation_ack_minutes" BETWEEN 1 AND 60);

-- AlterTable
ALTER TABLE "call_history" ADD COLUMN "parent_id" UUID;

-- CreateIndex
CREATE INDEX "call_history_parent_id_idx" ON "call_history"("parent_id");

-- AddForeignKey
-- ON DELETE SET NULL so pruning an old reminder row never deletes the record
-- that a caregiver was alerted. NO ACTION on update because the parent is a
-- generated UUID that is never reassigned.
ALTER TABLE "call_history" ADD CONSTRAINT "call_history_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "call_history"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
