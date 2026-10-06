-- Additive: how a reply draft is delivered. `review` (every existing row) keeps
-- the human Accept/Edit flow; `auto` is decided by the API at insert under the
-- work.turn-triage autoSend guardrails. A column CHECK on ADD COLUMN instead of
-- the drizzle-kit table rebuild keeps the insert/immutability triggers intact
-- (a rebuild drops them) and needs no PRAGMA foreign_keys toggle, which D1
-- ignores. The insert guard is unchanged: auto drafts are still only admitted
-- for open, quiet decision-capture questions and an active drafting tedi.
ALTER TABLE `work_interaction_reply_drafts` ADD `delivery` text DEFAULT 'review' NOT NULL CONSTRAINT "chk_work_interaction_reply_draft_delivery" CHECK("delivery" IN ('review','auto'));
