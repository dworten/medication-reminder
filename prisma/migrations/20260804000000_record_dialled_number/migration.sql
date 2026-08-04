-- Record the number an attempt actually went to.
--
-- call_history.contact_id says who the attempt was ABOUT. It does not say where
-- the call went, and the two differ whenever the destination is overridden —
-- POST /trigger?target=test being the case that matters.
--
-- The consequence was a retry that changed phones mid-sequence: the sweeper
-- rebuilt the destination from the contact, so a test call's first attempt rang
-- TEST_PHONE_NUMBER and its retry rang the real contact. Nothing recorded that
-- this had happened, because nothing recorded the destination at all.
--
-- Nullable, with the contact's phone as the fallback, so every existing row
-- keeps behaving exactly as it did.

ALTER TABLE "call_history" ADD COLUMN "to_phone" TEXT;
