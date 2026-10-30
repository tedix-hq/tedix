CREATE TABLE `tenant_tool_policy_resource_generations` (
	`organization_id` text NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `tenant_tool_policy_resource_generations_pk` PRIMARY KEY(`organization_id`, `resource_kind`, `resource_id`),
	CONSTRAINT `fk_tenant_tool_policy_resource_generations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `resource_generation_digest` text;--> statement-breakpoint
ALTER TABLE `tenant_tool_policy_preparations` ADD `resource_generation_digest` text;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_app_insert_generation` AFTER INSERT ON `apps` BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`) VALUES (NEW.`organization_id`, 'app', NEW.`id`, 1)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_app_update_generation` AFTER UPDATE ON `apps`
WHEN OLD.`metadata` IS NOT NEW.`metadata` OR OLD.`slug` IS NOT NEW.`slug` OR OLD.`visibility` IS NOT NEW.`visibility` OR OLD.`source_app_id` IS NOT NEW.`source_app_id` OR OLD.`active_config_version_id` IS NOT NEW.`active_config_version_id` OR OLD.`latest_config_version` IS NOT NEW.`latest_config_version` OR OLD.`gating_metadata` IS NOT NEW.`gating_metadata` OR OLD.`custom_mcp_domain` IS NOT NEW.`custom_mcp_domain` OR OLD.`organization_id` IS NOT NEW.`organization_id`
BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`) VALUES (NEW.`organization_id`, 'app', NEW.`id`, 1)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_app_delete_generation` BEFORE DELETE ON `apps` BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`)
	SELECT OLD.`organization_id`, 'app', OLD.`id`, 1 WHERE EXISTS (SELECT 1 FROM `organizations` WHERE `id` = OLD.`organization_id`)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_tool_insert_generation` AFTER INSERT ON `app_tools` BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`)
	SELECT `organization_id`, 'tool', NEW.`id`, 1 FROM `apps` WHERE `id` = NEW.`app_id`
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_tool_update_generation` AFTER UPDATE ON `app_tools` BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`)
	SELECT `organization_id`, 'tool', NEW.`id`, 1 FROM `apps` WHERE `id` = NEW.`app_id`
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_tool_delete_generation` BEFORE DELETE ON `app_tools` BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`)
	SELECT `organization_id`, 'tool', OLD.`id`, 1 FROM `apps` WHERE `id` = OLD.`app_id`
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_connection_insert_generation` AFTER INSERT ON `connection_instances` WHEN NEW.`organization_id` IS NOT NULL BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`) VALUES (NEW.`organization_id`, 'connection', NEW.`id`, 1)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_connection_update_generation` AFTER UPDATE ON `connection_instances`
WHEN NEW.`organization_id` IS NOT NULL AND (OLD.`organization_id` IS NOT NEW.`organization_id` OR OLD.`provider_id` IS NOT NEW.`provider_id` OR OLD.`owner_user_id` IS NOT NEW.`owner_user_id` OR OLD.`token_ids` IS NOT NEW.`token_ids` OR OLD.`token_sub` IS NOT NEW.`token_sub` OR OLD.`allowed_resources` IS NOT NEW.`allowed_resources`)
BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`) VALUES (NEW.`organization_id`, 'connection', NEW.`id`, 1)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_policy_connection_delete_generation` BEFORE DELETE ON `connection_instances` WHEN OLD.`organization_id` IS NOT NULL BEGIN
	INSERT INTO `tenant_tool_policy_resource_generations` (`organization_id`, `resource_kind`, `resource_id`, `generation`)
	SELECT OLD.`organization_id`, 'connection', OLD.`id`, 1 WHERE EXISTS (SELECT 1 FROM `organizations` WHERE `id` = OLD.`organization_id`)
	ON CONFLICT (`organization_id`, `resource_kind`, `resource_id`) DO UPDATE SET `generation` = `generation` + 1;
END;
