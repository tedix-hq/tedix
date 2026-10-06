DROP INDEX IF EXISTS `idx_mcp_tool_calls_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_tool_calls_app`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_tool_calls_session`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_tool_calls_tool`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_tool_calls_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_tool_calls_success`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_session_metrics_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_session_metrics_app`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_session_metrics_session`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_session_metrics_started`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_session_metrics_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_tedi`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_org`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_flywheel`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_telemetry_server`;--> statement-breakpoint
DROP TABLE `mcp_tool_calls`;--> statement-breakpoint
DROP TABLE `session_metrics`;--> statement-breakpoint
DROP TABLE `mcp_telemetry_events`;