-- Phase 3, step 1: authentication.
--
-- Additive only. The Phase 2 code running right now reads none of this, so the
-- migration can be applied to a live deployment without touching the call path.

-- AlterTable
-- Nullable on purpose. An account that has never had a password set must not be
-- loginable, and NULL is the only state no hash comparison can match — an empty
-- string would be a password someone could eventually guess how to send.
ALTER TABLE "accounts" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "accounts" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- CreateTable
-- Written and read by connect-pg-simple, not by Prisma. Declared here so
-- `prisma migrate` remains the single source of truth: a table created behind
-- Prisma's back registers as schema drift on every subsequent migrate.
--
-- The column names and types are the ones connect-pg-simple expects.
CREATE TABLE "session" (
    "sid" TEXT NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
-- The store sweeps expired rows by this column on an interval.
CREATE INDEX "session_expire_idx" ON "session"("expire");
