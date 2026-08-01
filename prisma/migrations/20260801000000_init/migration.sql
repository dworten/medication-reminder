-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "contact_role" AS ENUM ('RECIPIENT', 'CAREGIVER', 'BOTH');

-- CreateEnum
CREATE TYPE "message_kind" AS ENUM ('TTS', 'AUDIO');

-- CreateEnum
CREATE TYPE "call_kind" AS ENUM ('REMINDER_CALL', 'ESCALATION_CALL', 'ESCALATION_SMS');

-- CreateEnum
CREATE TYPE "call_outcome" AS ENUM ('PENDING', 'CONFIRMED', 'NOT_CONFIRMED', 'NO_ANSWER', 'BUSY', 'FAILED', 'SENT', 'CANCELED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "role" "contact_role" NOT NULL DEFAULT 'RECIPIENT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "message_kind" NOT NULL DEFAULT 'TTS',
    "tts_text" TEXT,
    "audio_url" TEXT,
    "voice" TEXT,
    "language" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dose" TEXT NOT NULL,
    "time_of_day" TEXT NOT NULL,
    "days_of_week" INTEGER[],
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "contact_id" UUID NOT NULL,
    "message_id" UUID,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "retry_delay_minutes" INTEGER NOT NULL DEFAULT 5,
    "max_reprompts" INTEGER NOT NULL DEFAULT 3,
    "escalation_contact_id" UUID,
    "escalate_with_call" BOOLEAN NOT NULL DEFAULT false,
    "escalate_with_sms" BOOLEAN NOT NULL DEFAULT true,
    "last_fired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_history" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "schedule_id" UUID,
    "contact_id" UUID,
    "kind" "call_kind" NOT NULL DEFAULT 'REMINDER_CALL',
    "dose" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "reprompt_count" INTEGER NOT NULL DEFAULT 0,
    "outcome" "call_outcome" NOT NULL DEFAULT 'PENDING',
    "call_sid" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "retry_claimed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE INDEX "contacts_account_id_idx" ON "contacts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_phone_key" ON "contacts"("account_id", "phone");

-- CreateIndex
CREATE INDEX "messages_account_id_idx" ON "messages"("account_id");

-- CreateIndex
CREATE INDEX "schedules_account_id_idx" ON "schedules"("account_id");

-- CreateIndex
CREATE INDEX "schedules_enabled_idx" ON "schedules"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "call_history_call_sid_key" ON "call_history"("call_sid");

-- CreateIndex
CREATE INDEX "call_history_account_id_started_at_idx" ON "call_history"("account_id", "started_at");

-- CreateIndex
CREATE INDEX "call_history_schedule_id_started_at_idx" ON "call_history"("schedule_id", "started_at");

-- CreateIndex
CREATE INDEX "call_history_next_retry_at_idx" ON "call_history"("next_retry_at");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_escalation_contact_id_fkey" FOREIGN KEY ("escalation_contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_history" ADD CONSTRAINT "call_history_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_history" ADD CONSTRAINT "call_history_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_history" ADD CONSTRAINT "call_history_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written additions. Everything below is invisible to schema.prisma
-- because Prisma cannot express it; it is preserved across future migrations
-- because it lives in the migration history.
-- ─────────────────────────────────────────────────────────────────────────────

-- At most one default message per account. A plain @@unique would forbid more
-- than one NON-default message too, which is why this is a partial index.
CREATE UNIQUE INDEX "messages_one_default_per_account"
  ON "messages" ("account_id")
  WHERE "is_default";

-- The retry sweeper's exact query, running once a minute forever. The partial
-- index stays small no matter how large call_history grows, because the vast
-- majority of rows have no pending retry.
CREATE INDEX "call_history_due_retries"
  ON "call_history" ("next_retry_at")
  WHERE "next_retry_at" IS NOT NULL AND "retry_claimed_at" IS NULL;

-- ── Integrity checks ────────────────────────────────────────────────────────
-- These exist because a bad row here does not throw an error, it silently
-- fails to call an elderly woman about her medication. Cheaper to reject the
-- write than to discover it from a missed dose.

-- 'morning' | 'evening' travel verbatim in the Twilio webhook query string.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_dose_check"
  CHECK ("dose" IN ('morning', 'evening'));

ALTER TABLE "call_history" ADD CONSTRAINT "call_history_dose_check"
  CHECK ("dose" IN ('morning', 'evening'));

-- "09:20", 24-hour. A malformed time is a schedule that never fires.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_time_of_day_check"
  CHECK ("time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- 0 = Sunday .. 6 = Saturday, at least one day selected. An empty array is a
-- schedule that is enabled but can never match a day.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_days_of_week_check"
  CHECK (
    array_length("days_of_week", 1) BETWEEN 1 AND 7
    AND "days_of_week" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
  );

ALTER TABLE "schedules" ADD CONSTRAINT "schedules_attempt_bounds_check"
  CHECK (
    "max_attempts" BETWEEN 1 AND 10
    AND "retry_delay_minutes" BETWEEN 1 AND 1440
    AND "max_reprompts" BETWEEN 0 AND 10
  );

-- E.164, the only format Twilio accepts.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_phone_e164_check"
  CHECK ("phone" ~ '^\+[1-9][0-9]{1,14}$');

-- A TTS message with no text, or an audio message with no file, produces a
-- call that connects and then says nothing at all.
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_present_check"
  CHECK (
    ("kind" = 'TTS'   AND "tts_text"  IS NOT NULL AND length(btrim("tts_text")) > 0)
    OR
    ("kind" = 'AUDIO' AND "audio_url" IS NOT NULL AND length(btrim("audio_url")) > 0)
  );
