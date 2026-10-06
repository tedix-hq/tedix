WITH issuer_source AS (
	SELECT COALESCE(
		(SELECT `issuer` FROM `principal_identities`
			WHERE `provider` = 'descope' ORDER BY `created_at`, `id` LIMIT 1),
		'unconfigured'
	) AS `issuer`
)
INSERT INTO `principal_identities` (`id`,`organization_id`,`principal_type`,`principal_id`,`provider`,`issuer`,`subject`,`status`,`metadata`,`last_verified_at`,`created_at`,`updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), NULL, 'user', u.id, 'descope', s.issuer, u.id, 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users u, issuer_source s WHERE u.id LIKE 'U%' AND NOT EXISTS (SELECT 1 FROM principal_identities p WHERE p.provider='descope' AND p.issuer=s.issuer AND p.subject=u.id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_tools` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`tool_type_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`input_schema` text DEFAULT '{"type":"object","properties":{},"additionalProperties":false}' NOT NULL,
	`output_schema` text,
	`adapter_scope` text DEFAULT 'primary',
	`result_strategy` text DEFAULT 'merge',
	`output_template` text,
	`widget_route` text,
	`widget_key` text,
	`widget_accessible` integer DEFAULT true,
	`auth_required` integer DEFAULT false,
	`visibility` text DEFAULT 'public',
	`icons` text,
	`execution_task_support` text,
	`annotations` text,
	`write_capability` text,
	`meta` text,
	`invocation_status` text,
	`file_params` text,
	`widget_description` text,
	`widget_prefers_border` integer DEFAULT true,
	`widget_domain` text,
	`config` text,
	`schema_dialect` text,
	`schema_source` text,
	`schema_source_ref` text,
	`schema_source_hash` text,
	`schema_synced_at` text,
	`enabled` integer DEFAULT true,
	`sort_order` integer DEFAULT 0,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_app_tools_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `idx_app_tool_unique` UNIQUE(`app_id`,`tool_id`)
);
--> statement-breakpoint
INSERT INTO `__new_app_tools`(`id`, `app_id`, `tool_type_id`, `tool_id`, `title`, `description`, `input_schema`, `output_schema`, `adapter_scope`, `result_strategy`, `output_template`, `widget_route`, `widget_key`, `widget_accessible`, `auth_required`, `visibility`, `icons`, `execution_task_support`, `annotations`, `write_capability`, `meta`, `invocation_status`, `file_params`, `widget_description`, `widget_prefers_border`, `widget_domain`, `config`, `schema_dialect`, `schema_source`, `schema_source_ref`, `schema_source_hash`, `schema_synced_at`, `enabled`, `sort_order`, `created_at`, `updated_at`) SELECT `id`, `app_id`, `tool_type_id`, `tool_id`, `title`, `description`, `input_schema`, `output_schema`, `adapter_scope`, `result_strategy`, `output_template`, `widget_route`, `widget_key`, `widget_accessible`, `auth_required`, `visibility`, `icons`, `execution_task_support`, `annotations`, `write_capability`, `meta`, `invocation_status`, `file_params`, `widget_description`, `widget_prefers_border`, `widget_domain`, `config`, `schema_dialect`, `schema_source`, `schema_source_ref`, `schema_source_hash`, `schema_synced_at`, `enabled`, `sort_order`, `created_at`, `updated_at` FROM `app_tools`;--> statement-breakpoint
DROP TABLE `app_tools`;--> statement-breakpoint
ALTER TABLE `__new_app_tools` RENAME TO `app_tools`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_app_tools_app_enabled` ON `app_tools` (`app_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_app_tools_app_sort` ON `app_tools` (`app_id`,`sort_order`);
