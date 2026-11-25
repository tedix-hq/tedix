ALTER TABLE `mcp_consent_grants` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_grants` ADD `device` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_grants` ADD `last_used_at` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_pending` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_pending` ADD `device` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_selections` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `mcp_consent_selections` ADD `device` text;