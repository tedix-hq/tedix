ALTER TABLE `tenant_tool_policy_mount_revisions` ADD `source_tool_id` text;--> statement-breakpoint
UPDATE `tenant_tool_policy_mount_revisions`
SET `source_tool_id` = (SELECT COALESCE(json_extract(`mount_descriptor`, '$.mount.sourceToolId'), json_extract(`mount_descriptor`, '$.sourceToolId')) FROM `tenant_tool_policies` WHERE `id` = `tenant_tool_policy_mount_revisions`.`policy_id` AND `organization_id` = `tenant_tool_policy_mount_revisions`.`organization_id`);
