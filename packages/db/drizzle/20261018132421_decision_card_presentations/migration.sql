CREATE TABLE `work_interaction_card_presentations` (
	`org_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`person_id` text NOT NULL,
	`request_version` integer NOT NULL,
	`presentation` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `work_interaction_card_presentations_pk` PRIMARY KEY(`org_id`, `interaction_id`),
	CONSTRAINT `fk_work_interaction_card_presentations_org_id_interaction_id_work_interactions_org_id_id_fk` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_card_presentation_request_version" CHECK("request_version" > 0),
	CONSTRAINT "chk_card_presentation_json" CHECK(json_valid("presentation") AND json_type("presentation") = 'object')
);
