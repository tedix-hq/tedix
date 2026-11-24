-- Baseline for tedi runtime objects that already hold these tables (made by
-- PoppyConversations since 15 Nov 2026): IF NOT EXISTS lets them adopt the
-- chain unchanged.
CREATE TABLE IF NOT EXISTS `poppy_conversations` (
	`id` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `poppy_desks` (
	`id` text PRIMARY KEY,
	`conversation` text NOT NULL,
	`root` text NOT NULL,
	`pending` integer NOT NULL,
	`through_sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `poppy_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`conversation` text NOT NULL,
	`id` text NOT NULL UNIQUE,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `poppy_requests` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`conversation` text NOT NULL,
	`path` text NOT NULL,
	`body` text NOT NULL,
	`status` integer NOT NULL,
	`pending` integer NOT NULL,
	`context` text NOT NULL,
	`through_sequence` integer NOT NULL,
	`accepted_at` integer NOT NULL,
	CONSTRAINT `poppy_requests_owner_id_unique` UNIQUE(`owner`,`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `poppy_events_conversation` ON `poppy_events` (`conversation`,`sequence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `poppy_pending` ON `poppy_requests` (`pending`,`sequence`);