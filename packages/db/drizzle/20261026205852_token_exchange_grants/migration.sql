CREATE TABLE `token_exchange_grants` (
	`jti` text PRIMARY KEY,
	`parent_jti` text,
	`organization_id` text NOT NULL,
	`subject` text NOT NULL,
	`actor_chain` text NOT NULL,
	`audience` text NOT NULL,
	`endpoint` text NOT NULL,
	`scopes` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`revoked_by` text
);
--> statement-breakpoint
CREATE INDEX `token_exchange_grants_org_issued_idx` ON `token_exchange_grants` (`organization_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `token_exchange_grants_parent_idx` ON `token_exchange_grants` (`parent_jti`);