CREATE TABLE `mcp_consent_pending` (
	`descope_user_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`client_id` text NOT NULL,
	`app_id` text NOT NULL,
	`revision` text NOT NULL,
	`expected_active_revision` text,
	`selected_tenant_ids` text NOT NULL,
	`approved_scopes` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `mcp_consent_pending_pk` PRIMARY KEY(`descope_user_id`, `mcp_server_id`, `client_id`, `revision`)
);
