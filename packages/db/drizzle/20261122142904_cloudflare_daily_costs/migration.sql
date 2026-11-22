CREATE TABLE `billing_cloudflare_daily_costs` (
	`account_id` text NOT NULL,
	`service` text NOT NULL,
	`day` text NOT NULL,
	`cost_micros` integer NOT NULL,
	`consumed_quantity` real,
	`consumed_unit` text,
	`fetched_at` text NOT NULL,
	CONSTRAINT `billing_cloudflare_daily_costs_pk` PRIMARY KEY(`account_id`, `service`, `day`)
);
--> statement-breakpoint
CREATE INDEX `idx_cloudflare_daily_cost_day` ON `billing_cloudflare_daily_costs` (`day`);