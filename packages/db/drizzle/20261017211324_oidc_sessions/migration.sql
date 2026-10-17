CREATE TABLE `oidc_sessions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`config_digest` text NOT NULL,
	`verifier` text,
	`nonce` text,
	`subject` text,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_oidc_sessions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_oidc_sessions_expiry` ON `oidc_sessions` (`expires_at`);