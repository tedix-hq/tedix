CREATE TABLE `mcp_consent_grants` (
	`descope_user_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`client_id` text NOT NULL,
	`revision` text NOT NULL,
	`app_id` text NOT NULL,
	`selected_tenant_ids` text NOT NULL,
	`approved_scopes` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `mcp_consent_grants_pk` PRIMARY KEY(`descope_user_id`, `mcp_server_id`, `client_id`, `revision`)
);
--> statement-breakpoint
-- Every current active selection becomes a grant, so tokens issued before this
-- migration keep working without re-consent. mcp_consent_selections is kept
-- unchanged as the latest decision and revocation fence.
INSERT OR IGNORE INTO `mcp_consent_grants` (`descope_user_id`, `mcp_server_id`, `client_id`, `revision`, `app_id`, `selected_tenant_ids`, `approved_scopes`, `created_at`)
SELECT `descope_user_id`, `mcp_server_id`, `client_id`, `revision`, `app_id`, `selected_tenant_ids`, `approved_scopes`, `updated_at`
FROM `mcp_consent_selections`
WHERE `status` = 'active';
