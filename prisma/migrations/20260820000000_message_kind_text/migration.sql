-- A third kind of message: one sent as an SMS rather than spoken on a call.
--
-- The interface now files messages under three tags — Voice Typed Message
-- (TTS), Voice Recorded Message (AUDIO), and Text Message — and the first two
-- are the values that already exist. Only the third needs a home. Renaming the
-- stored values to match the labels was considered and rejected: labels are
-- presentation, and a rename would force a data rewrite plus edits across the
-- call path for zero change in behaviour.
--
-- Additive only: no existing row changes, no schedule reference is touched, and
-- the call path never sees TEXT — the schedule picker offers typed voice
-- messages alone. A TEXT row's body lives in tts_text; there is no new column.
--
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not USED in the same transaction. Nothing below uses it.

ALTER TYPE "message_kind" ADD VALUE IF NOT EXISTS 'TEXT';
