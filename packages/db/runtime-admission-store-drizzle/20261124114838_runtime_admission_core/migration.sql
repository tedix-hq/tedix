-- Baseline for tedi runtime objects that already hold some of these tables
-- (each group was created lazily before): IF NOT EXISTS lets them adopt the
-- chain unchanged. Runs on the object's first admission write, never on a
-- read-only guard.
CREATE TABLE IF NOT EXISTS `runtime_admission` (
	`id` integer PRIMARY KEY,
	`record` text NOT NULL,
	CONSTRAINT "runtime_admission_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_evidence` (
	`digest` text PRIMARY KEY,
	`action` text NOT NULL,
	`snapshot` text NOT NULL,
	`claim` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_identities` (
	`run_id` text PRIMARY KEY,
	`record` text NOT NULL,
	`input` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_initialized` (
	`id` integer PRIMARY KEY,
	CONSTRAINT "runtime_admission_initialized_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_operations` (
	`id` text PRIMARY KEY,
	`input` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_receipts` (
	`run_id` text PRIMARY KEY,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_admission_turns` (
	`id` text PRIMARY KEY,
	`record` text NOT NULL
);
