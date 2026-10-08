CREATE TABLE `work_interaction_attention` (
	`org_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`kind` text NOT NULL,
	`need` text,
	`asks` real,
	`decided_at` text NOT NULL,
	CONSTRAINT `pk_work_interaction_attention` PRIMARY KEY(`org_id`, `interaction_id`),
	CONSTRAINT `fk_work_interaction_attention_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_attention_request` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_interaction_attention_kind" CHECK("kind" IN ('needs_you','fyi')),
	CONSTRAINT "chk_work_interaction_attention_need" CHECK("need" IS NULL OR length("need") BETWEEN 1 AND 240)
);
