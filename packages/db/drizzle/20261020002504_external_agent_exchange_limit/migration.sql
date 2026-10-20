CREATE TABLE `external_agent_exchange_limits` (
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`request_count` integer NOT NULL,
	CONSTRAINT `external_agent_exchange_limits_pk` PRIMARY KEY(`organization_id`, `principal_id`),
	CONSTRAINT `fk_external_agent_exchange_limits_organization_id_principal_id_external_agent_principals_organization_id_id_fk` FOREIGN KEY (`organization_id`,`principal_id`) REFERENCES `external_agent_principals`(`organization_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_external_agent_exchange_count" CHECK("request_count" BETWEEN 1 AND 30)
);
