-- Knowing whether an alert text actually arrived.
--
-- call_history.outcome could say SENT, meaning "Twilio accepted it", and had no
-- way to say "the carrier delivered it" — so those were the same word. Between 4
-- and 11 August every escalation text was rejected by the carrier (error 30034,
-- unregistered A2P 10DLC sender) and all eleven were recorded as SENT.
--
-- DELIVERED is the outcome only a carrier receipt can produce. SENT keeps its
-- existing meaning, which is now visibly weaker than it looked.
--
-- Additive only: no existing row changes, and no existing row is re-interpreted.
-- The eleven rows already recorded as SENT stay SENT — they were sent, in the
-- narrow sense the word turns out to have. What they are not is delivered, and
-- from here that is a distinction the schema can make.
--
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not USED in the same transaction. Nothing below uses it; the
-- server is 18.4.

ALTER TYPE "call_outcome" ADD VALUE IF NOT EXISTS 'DELIVERED' AFTER 'SENT';
