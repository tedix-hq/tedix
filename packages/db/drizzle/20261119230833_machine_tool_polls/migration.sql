CREATE TABLE `machine_tool_polls` (
	`org_id` text NOT NULL,
	`machine_name` text NOT NULL,
	`last_polled_at` text NOT NULL,
	CONSTRAINT `machine_tool_polls_pk` PRIMARY KEY(`org_id`, `machine_name`),
	CONSTRAINT `fk_machine_tool_polls_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
