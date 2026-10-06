CREATE TABLE `work_interaction_reply_drafts` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`drafter_type` text NOT NULL,
	`drafter_id` text NOT NULL,
	`body` text NOT NULL,
	`rationale` text NOT NULL,
	`turn_type` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_interaction_reply_drafts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_reply_draft_request` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_interaction_reply_draft_body" CHECK(length("body") BETWEEN 1 AND 6000),
	CONSTRAINT "chk_work_interaction_reply_draft_rationale" CHECK(length("rationale") BETWEEN 1 AND 2000),
	CONSTRAINT "chk_work_interaction_reply_draft_turn_type" CHECK("turn_type" IS NULL OR length("turn_type") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX `idx_work_interaction_reply_drafts_request` ON `work_interaction_reply_drafts` (`org_id`,`interaction_id`,`created_at`);--> statement-breakpoint
-- A reply draft is a tedi proposal for a human's open, quiet decision-capture
-- question. It never answers the question and is append-only.
CREATE TRIGGER `work_interaction_reply_draft_insert_guard` BEFORE INSERT ON `work_interaction_reply_drafts`
BEGIN
 SELECT RAISE(ABORT,'invalid reply draft state') WHERE NEW.`drafter_type`<>'tedi' OR length(NEW.`id`)=0 OR julianday(NEW.`created_at`) IS NULL;
 SELECT RAISE(ABORT,'reply draft request is not an open quiet human question') WHERE NOT EXISTS(
  SELECT 1 FROM `work_interactions` i WHERE i.`org_id`=NEW.`org_id` AND i.`id`=NEW.`interaction_id` AND
   i.`status`='open' AND i.`kind`='question' AND i.`target_type`='user' AND i.`target_id` IS NOT NULL AND
   i.`created_at`<=NEW.`created_at` AND (i.`expires_at` IS NULL OR i.`expires_at`>NEW.`created_at`) AND
   json_extract(i.`metadata`,'$.schema') IS 'tedix.decision-capture.v1' AND
   json_extract(i.`metadata`,'$.triage.status') IS 'ok' AND
   json_extract(i.`metadata`,'$.triage.urgency') IS 'later' AND
   (json_type(i.`metadata`,'$.triage.urgentLabels') IS NULL OR (json_type(i.`metadata`,'$.triage.urgentLabels')='array' AND json_array_length(i.`metadata`,'$.triage.urgentLabels')=0)));
 SELECT RAISE(ABORT,'reply drafter is not an active tedi in the organization') WHERE NOT EXISTS(
  SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`drafter_id` AND t.`status`='active' AND t.`retired_at` IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_reply_draft_immutable_update` BEFORE UPDATE ON `work_interaction_reply_drafts` BEGIN SELECT RAISE(ABORT,'reply drafts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_reply_draft_immutable_delete` BEFORE DELETE ON `work_interaction_reply_drafts` BEGIN SELECT RAISE(ABORT,'reply drafts are immutable'); END;
