-- Baseline for tedi runtime objects that already hold session_entries:
-- IF NOT EXISTS lets them adopt the chain unchanged. Objects whose table
-- predates the compaction and model columns get them from
-- adoptLegacySessionColumns() first. Applied on the repo's first use.
CREATE TABLE IF NOT EXISTS `session_entries` (
	`id` text PRIMARY KEY,
	`session_key` text NOT NULL,
	`parent_id` text,
	`type` text DEFAULT 'message' NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`idempotency_key` text,
	`ts` integer NOT NULL,
	`first_kept_entry_id` text,
	`tokens_before` integer,
	`model_provider` text,
	`model_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_entries_key_ts` ON `session_entries` (`session_key`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_session_entries_key_idem` ON `session_entries` (`session_key`,`idempotency_key`) WHERE "session_entries"."idempotency_key" IS NOT NULL;