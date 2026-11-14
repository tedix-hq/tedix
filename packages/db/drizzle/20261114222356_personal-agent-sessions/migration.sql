CREATE TABLE `personal_agent_client_rates` (
	`organization_id` text NOT NULL,
	`client_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`requests` integer NOT NULL,
	CONSTRAINT `personal_agent_client_rates_pk` PRIMARY KEY(`organization_id`, `client_id`),
	CONSTRAINT `fk_personal_agent_client_rates_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `personal_agent_sessions` (
	`organization_id` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text,
	`version` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT `personal_agent_sessions_pk` PRIMARY KEY(`organization_id`, `client_id`, `session_id`, `user_id`),
	CONSTRAINT `fk_personal_agent_sessions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
