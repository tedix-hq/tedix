CREATE TABLE `mcp_consent_selections` (
	`descope_user_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`client_id` text NOT NULL,
	`app_id` text NOT NULL,
	`revision` text NOT NULL,
	`status` text NOT NULL,
	`selected_tenant_ids` text NOT NULL,
	`approved_scopes` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `mcp_consent_selections_pk` PRIMARY KEY(`descope_user_id`, `mcp_server_id`, `client_id`)
);
