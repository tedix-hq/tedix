ALTER TABLE `connection_instances` ADD `organization_id` text;--> statement-breakpoint
CREATE INDEX `connection_instances_org_provider_idx` ON `connection_instances` (`organization_id`,`provider_id`);