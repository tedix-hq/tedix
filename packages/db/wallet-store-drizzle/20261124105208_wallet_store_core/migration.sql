-- Baseline for wallets that already hold these tables: IF NOT EXISTS lets
-- them adopt the chain unchanged. Wallets created before 23 Nov 15:02 get
-- their later columns from adoptLegacyWalletColumns() first.
CREATE TABLE IF NOT EXISTS `wallet_budget_alerts` (
	`budget_id` text NOT NULL,
	`limit_micros` integer NOT NULL,
	`percent` integer NOT NULL,
	`spent_micros` integer NOT NULL,
	`work_item_id` text,
	`at` integer NOT NULL,
	`delivered_at` integer,
	CONSTRAINT `wallet_budget_alerts_pk` PRIMARY KEY(`budget_id`, `limit_micros`, `percent`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_budget_spend` (
	`budget_id` text PRIMARY KEY,
	`micro_credits` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_event_budgets` (
	`event_id` text NOT NULL,
	`budget_id` text NOT NULL,
	CONSTRAINT `wallet_event_budgets_pk` PRIMARY KEY(`event_id`, `budget_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wallet_events` (
	`event_id` text PRIMARY KEY,
	`tedi_id` text,
	`user_id` text,
	`credits` integer NOT NULL,
	`micro_usd_per_eur` integer NOT NULL,
	`anonymous_loads` integer DEFAULT 0 NOT NULL,
	`named_loads` integer DEFAULT 0 NOT NULL,
	`settled` integer DEFAULT false NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`at` integer NOT NULL,
	`flush_id` text,
	`flushed_at` integer,
	`kind` text DEFAULT 'code_run' NOT NULL,
	`expires_at` integer,
	`hold_context` text,
	`idempotency_key` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wallet_event_budgets_budget` ON `wallet_event_budgets` (`budget_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `wallet_events_pending` ON `wallet_events` (`flushed_at`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `wallet_events_idempotency` ON `wallet_events` (`idempotency_key`);