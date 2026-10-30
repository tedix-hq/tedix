ALTER TABLE `tenant_tool_policy_mount_revisions` ADD `source_app_id` text;--> statement-breakpoint
ALTER TABLE `tenant_tool_policy_mount_revisions` ADD `source_tool_row_id` text;--> statement-breakpoint
UPDATE `tenant_tool_policy_mount_revisions`
SET `source_app_id` = (SELECT `app_id` FROM `tenant_tool_policies` WHERE `id` = `tenant_tool_policy_mount_revisions`.`policy_id` AND `organization_id` = `tenant_tool_policy_mount_revisions`.`organization_id`),
    `source_tool_row_id` = (SELECT `tool_row_id` FROM `tenant_tool_policies` WHERE `id` = `tenant_tool_policy_mount_revisions`.`policy_id` AND `organization_id` = `tenant_tool_policy_mount_revisions`.`organization_id`);
