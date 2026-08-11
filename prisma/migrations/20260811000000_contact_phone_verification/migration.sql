-- Phone number verification for contacts.
--
-- The invariant this migration establishes: contacts.phone only ever holds a
-- number that has passed a verification code. A typo cannot become a live
-- destination, because it never reaches that column — it waits in pending_phone
-- until a code comes back correct.
--
-- READ THIS BEFORE CHANGING THE TRIGGER AT THE BOTTOM. The schedules trigger is
-- guarded on the reference actually CHANGING. That guard is not tidiness: the
-- scheduler writes schedules.last_fired_at on every single fire (the double-call
-- claim in src/data/schedules.js), and a trigger that raised on that UPDATE
-- would abort the claim and silently stop every reminder call this system
-- exists to place. An unguarded version of this trigger is a total outage.

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "phone_verification_method" AS ENUM ('SMS', 'CALL', 'GRANDFATHERED');
CREATE TYPE "verification_channel"      AS ENUM ('SMS', 'CALL');

-- ─── contacts ────────────────────────────────────────────────────────────────

ALTER TABLE "contacts" ADD COLUMN "phone_verified_at"  TIMESTAMP(3);
ALTER TABLE "contacts" ADD COLUMN "phone_verified_via" "phone_verification_method";
ALTER TABLE "contacts" ADD COLUMN "pending_phone"      TEXT;

-- A stamp must say how it was earned, and an unstamped row must not claim a
-- method. Anything else is a row whose provenance cannot be read back.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_verified_stamp_check"
  CHECK (("phone_verified_at" IS NULL) = ("phone_verified_via" IS NULL));

-- A pending number that equals the live one is a no-op edit that would look
-- like outstanding work forever.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_pending_phone_differs_check"
  CHECK ("pending_phone" IS NULL OR "pending_phone" <> "phone");

-- ─── Grandfathering the contacts that predate this ───────────────────────────
--
-- Every contact that exists at this moment is stamped verified. These numbers
-- have been receiving real calls and real alerts for months, which is stronger
-- evidence than a code — but it is DIFFERENT evidence, so it is recorded as
-- GRANDFATHERED rather than as SMS or CALL. That distinction is permanent and
-- queryable: `WHERE phone_verified_via = 'GRANDFATHERED'` is exactly the list of
-- numbers nobody has ever actually challenged.
--
-- This runs BEFORE the trigger is created, deliberately. Creating the trigger
-- first would not break anything (it only fires on writes to schedules), but
-- ordering it this way means there is no instant, however brief, at which a
-- schedule references a contact the new rule would reject.
--
-- This is the line that keeps existing reminders running. Without it every
-- schedule in the database would reference an unverified contact the moment the
-- trigger below is created.
UPDATE "contacts"
   SET "phone_verified_at"  = now(),
       "phone_verified_via" = 'GRANDFATHERED'
 WHERE "phone_verified_at" IS NULL;

-- ─── contact_verifications ───────────────────────────────────────────────────

CREATE TABLE "contact_verifications" (
  "id"             UUID                  NOT NULL,
  "account_id"     UUID                  NOT NULL,
  "contact_id"     UUID,
  "phone"          TEXT                  NOT NULL,
  "channel"        "verification_channel" NOT NULL,
  "code_hash"      TEXT                  NOT NULL,
  "draft"          JSONB,
  "expires_at"     TIMESTAMP(3)          NOT NULL,
  "consumed_at"    TIMESTAMP(3),
  "invalidated_at" TIMESTAMP(3),
  "check_attempts" INTEGER               NOT NULL DEFAULT 0,
  "created_at"     TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3)          NOT NULL,

  CONSTRAINT "contact_verifications_pkey" PRIMARY KEY ("id")
);

-- A row cannot be both used and burned. Which of the two happened is the
-- difference between "this created a contact" and "somebody guessed at it five
-- times", and a row claiming both tells neither story.
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_outcome_check"
  CHECK ("consumed_at" IS NULL OR "invalidated_at" IS NULL);

ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_attempts_check"
  CHECK ("check_attempts" >= 0);

-- The two rate-limit queries in index form: sends to one number within the last
-- hour, and sends by one account within the last hour. The second is the one
-- that matters for the bill — capping a single number at 5 does nothing about
-- someone walking through a thousand different numbers.
CREATE INDEX "contact_verifications_account_id_phone_created_at_idx"
  ON "contact_verifications"("account_id", "phone", "created_at");
CREATE INDEX "contact_verifications_account_id_created_at_idx"
  ON "contact_verifications"("account_id", "created_at");
CREATE INDEX "contact_verifications_contact_id_idx"
  ON "contact_verifications"("contact_id");

ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade, unlike the schedule FKs: an outstanding verification for a deleted
-- contact is not a record worth keeping, it is a code for a row that is gone.
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── The database-level rule ─────────────────────────────────────────────────
--
-- "A schedule may not reference an unverified contact", enforced where it cannot
-- be bypassed — by Prisma Studio, by a psql session, by a future bug in the API.
--
-- A foreign key cannot express this: FKs check that a row EXISTS, not what is in
-- its columns. The declarative alternative is a composite FK onto a
-- UNIQUE (id, is_phone_verified) pair, which does work and is race-proof without
-- plpgsql. It is not used here because it needs a redundant column on schedules
-- and turns "I no longer trust this number" into an opaque foreign-key error
-- instead of a sentence someone can act on.
--
-- The messages are raised as bare constraint-style names; src/api/errors.js maps
-- them to wording the caller can read, the same way it already maps CHECK
-- constraint names.

CREATE OR REPLACE FUNCTION "schedules_require_verified_contacts"() RETURNS trigger AS $$
DECLARE
  verified_at TIMESTAMP(3);
BEGIN
  -- THE GUARD. Only look when the reference actually changed.
  --
  -- Every fire of every schedule updates last_fired_at, and that UPDATE must
  -- never be able to fail on account of a contact's verification state. If it
  -- could, a contact going unverified would not block a change — it would stop
  -- the calls. IS DISTINCT FROM (not <>) because these columns are nullable and
  -- NULL <> NULL is NULL, which would skip the check on exactly the rows that
  -- need it.
  IF TG_OP = 'INSERT' OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id" THEN
    SELECT c."phone_verified_at" INTO verified_at
      FROM "contacts" c WHERE c."id" = NEW."contact_id";

    IF verified_at IS NULL THEN
      RAISE EXCEPTION 'schedules_contact_must_be_verified';
    END IF;
  END IF;

  IF NEW."escalation_contact_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."escalation_contact_id" IS DISTINCT FROM OLD."escalation_contact_id") THEN
    SELECT c."phone_verified_at" INTO verified_at
      FROM "contacts" c WHERE c."id" = NEW."escalation_contact_id";

    IF verified_at IS NULL THEN
      RAISE EXCEPTION 'schedules_escalation_contact_must_be_verified';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "schedules_require_verified_contacts_trigger"
  BEFORE INSERT OR UPDATE ON "schedules"
  FOR EACH ROW EXECUTE FUNCTION "schedules_require_verified_contacts"();

-- The other direction: un-verifying a contact that a schedule is actively
-- pointing at would leave the schedule in exactly the state the trigger above
-- forbids anyone to create. Refusing it here means that state is unreachable
-- from either side rather than merely hard to reach from one.
--
-- Note what this does NOT block: setting pending_phone, or promoting a pending
-- number into phone. Both leave phone_verified_at non-null, so the normal
-- change-a-number flow passes straight through.
CREATE OR REPLACE FUNCTION "contacts_keep_scheduled_verified"() RETURNS trigger AS $$
BEGIN
  IF OLD."phone_verified_at" IS NOT NULL AND NEW."phone_verified_at" IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM "schedules" s
       WHERE s."contact_id" = NEW."id"
          OR s."escalation_contact_id" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'contacts_cannot_unverify_while_scheduled';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contacts_keep_scheduled_verified_trigger"
  BEFORE UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION "contacts_keep_scheduled_verified"();
