-- Additive: the Clef delivery-gate audit (JSON) behind a reply draft's
-- `delivery`, written once at insert. NULL on every existing row and whenever
-- an earlier autoSend guardrail already chose `review`. A single ADD COLUMN
-- (no drizzle-kit table rebuild) keeps the draft insert/immutability triggers
-- intact and needs no PRAGMA foreign_keys toggle, which D1 ignores.
ALTER TABLE `work_interaction_reply_drafts` ADD `gate` text;
