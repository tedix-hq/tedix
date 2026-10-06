DROP TRIGGER IF EXISTS `work_item_comment_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_assignment_insert_outbox`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_assignment_update_outbox`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_assignee_tedi`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_claimed_by_executor`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_claimed_by_tedi`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_internal_task`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_org_status`;--> statement-breakpoint

ALTER TABLE `work_items` RENAME COLUMN `status` TO `legacy_status`;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `disposition` text DEFAULT 'proposed' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `work_kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `risk_level` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `acceptance_contract` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `required_capabilities` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `required_authorities` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `resource_scopes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `budget_limit_micros` integer;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `accountable_owner_type` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `accountable_owner_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `steward_type` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `steward_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `reviewer_type` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `reviewer_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `accepted_at` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint

UPDATE `work_items` SET
	`disposition` = CASE `legacy_status` WHEN 'candidate' THEN 'proposed' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'accepted' END,
	`work_kind` = CASE WHEN `work_class` = 'incident' THEN 'incident' ELSE 'other' END,
	`risk_level` = CASE WHEN `priority` = 'critical' THEN 'critical' WHEN `priority` = 'high' THEN 'high' ELSE 'medium' END,
	`acceptance_contract` = json_object('version',1,'claims',json_array(json_object('key','outcome','label','Accepted outcome','evidenceKinds',json_array('commit','pull_request','artifact','receipt','legacy'),'minimumAcceptedEvidence',1,'requiresIndependentReview',1))),
	`accountable_owner_type` = CASE WHEN `owner_type` IN ('user','tedi','team','system') AND nullif(`owner_id`,'') IS NOT NULL THEN `owner_type` WHEN nullif(`assignee_tedi_id`,'') IS NOT NULL THEN 'tedi' ELSE 'system' END,
	`accountable_owner_id` = coalesce(nullif(`owner_id`,''),nullif(`assignee_tedi_id`,''),'migration'),
	`steward_type` = CASE WHEN nullif(`assignee_tedi_id`,'') IS NOT NULL THEN 'tedi' ELSE NULL END,
	`steward_id` = nullif(`assignee_tedi_id`,''),
	`accepted_at` = CASE WHEN `legacy_status` NOT IN ('candidate','cancelled') THEN coalesce(`claimed_at`,`created_at`) ELSE NULL END,
	`completed_at` = CASE WHEN `legacy_status` = 'done' THEN coalesce(`completed_at`,`updated_at`,`created_at`) ELSE NULL END,
	`cancelled_at` = CASE WHEN `legacy_status` = 'cancelled' THEN coalesce(`updated_at`,`created_at`) ELSE NULL END,
	`provenance` = coalesce(`provenance`,'{}'),
	`metadata` = coalesce(`metadata`,'{}'),
	`version` = 1;--> statement-breakpoint

ALTER TABLE `work_items` DROP COLUMN `legacy_status`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `owner_type`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `owner_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `assignee_user_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `project_key`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `active_flow_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `active_task_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `checkout_run_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `claimed_at`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `claimed_by_executor_type`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `claimed_by_executor_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `claimed_by_executor_session_id`;--> statement-breakpoint
ALTER TABLE `work_items` DROP COLUMN `item_type`;--> statement-breakpoint

CREATE INDEX `idx_work_items_org_disposition` ON `work_items` (`org_id`,`disposition`);--> statement-breakpoint
CREATE INDEX `idx_work_items_org_kind_risk` ON `work_items` (`org_id`,`work_kind`,`risk_level`);--> statement-breakpoint
CREATE INDEX `idx_work_items_accountable_owner` ON `work_items` (`org_id`,`accountable_owner_type`,`accountable_owner_id`);--> statement-breakpoint

CREATE TABLE `work_attempts` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_session_id` text,
	`run_id` text,
	`runtime_state` text DEFAULT 'running' NOT NULL,
	`outcome` text,
	`attempt_number` integer NOT NULL,
	`started_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`expires_at` text,
	`finished_at` text,
	`summary` text,
	`version` integer DEFAULT 1 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_work_attempts_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_attempt_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `chk_work_attempt_identity` CHECK ((`executor_type` = 'tedi' AND `executor_session_id` IS NULL) OR (`executor_type` = 'external_agent' AND `executor_session_id` IS NOT NULL)),
	CONSTRAINT `chk_work_attempt_terminal_state` CHECK ((`runtime_state` IN ('failed','expired','finished','cancelled') AND `finished_at` IS NOT NULL AND `outcome` IS NOT NULL) OR (`runtime_state` IN ('queued','running','waiting','retrying') AND `finished_at` IS NULL AND `outcome` IS NULL))
);--> statement-breakpoint

WITH `checkout_rows` AS (
	SELECT `id`,`work_item_id`,`org_id`,`executor_type`,`executor_id`,`executor_session_id`,`run_id`,`status`,`claimed_at`,`expires_at`,`released_at`,`release_reason`,`metadata`,0 AS `source_rank`
	FROM `work_item_executor_checkouts`
	UNION ALL
	SELECT `id`,`work_item_id`,`org_id`,'tedi',`tedi_id`,NULL,`run_id`,`status`,`claimed_at`,`expires_at`,`released_at`,`release_reason`,`metadata`,1
	FROM `work_item_checkouts` legacy
	WHERE NOT EXISTS (SELECT 1 FROM `work_item_executor_checkouts` canonical WHERE canonical.`id` = legacy.`id`)
), `ranked` AS (
	SELECT *, row_number() OVER (PARTITION BY `org_id`,`work_item_id` ORDER BY `claimed_at`,`id`) AS `attempt_number`,
		row_number() OVER (PARTITION BY `org_id`,`work_item_id`,`status` ORDER BY `claimed_at` DESC,`source_rank`,`id`) AS `state_rank`
	FROM `checkout_rows`
)
INSERT INTO `work_attempts` (`id`,`work_item_id`,`org_id`,`executor_type`,`executor_id`,`executor_session_id`,`run_id`,`runtime_state`,`outcome`,`attempt_number`,`started_at`,`heartbeat_at`,`expires_at`,`finished_at`,`summary`,`version`,`metadata`)
SELECT `id`,`work_item_id`,`org_id`,`executor_type`,`executor_id`,`executor_session_id`,`run_id`,
	CASE WHEN `status` = 'active' AND `state_rank` = 1 THEN 'running' WHEN `status` = 'expired' OR (`status` = 'active' AND `state_rank` > 1) THEN 'expired' WHEN `status` = 'cancelled' THEN 'cancelled' ELSE 'finished' END,
	CASE WHEN `status` = 'active' AND `state_rank` = 1 THEN NULL WHEN `status` = 'expired' OR (`status` = 'active' AND `state_rank` > 1) THEN 'expired' WHEN `status` = 'cancelled' THEN 'cancelled' ELSE 'succeeded' END,
	`attempt_number`,`claimed_at`,coalesce(`released_at`,`claimed_at`),`expires_at`,
	CASE WHEN `status` = 'active' AND `state_rank` = 1 THEN NULL ELSE coalesce(`released_at`,`expires_at`,`claimed_at`) END,
	`release_reason`,1,coalesce(`metadata`,'{}')
FROM `ranked`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_number` ON `work_attempts` (`org_id`,`work_item_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_active` ON `work_attempts` (`org_id`,`work_item_id`) WHERE `runtime_state` IN ('queued','running','waiting','retrying');--> statement-breakpoint
CREATE INDEX `idx_work_attempt_executor_state` ON `work_attempts` (`org_id`,`executor_type`,`executor_id`,`runtime_state`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_expiry` ON `work_attempts` (`runtime_state`,`expires_at`);--> statement-breakpoint

CREATE TABLE `work_evidence` (
	`id` text PRIMARY KEY, `work_item_id` text NOT NULL, `org_id` text NOT NULL, `attempt_id` text,
	`claim_key` text NOT NULL, `kind` text NOT NULL, `uri` text NOT NULL, `digest` text, `media_type` text, `label` text,
	`submitted_by_type` text NOT NULL, `submitted_by_id` text NOT NULL, `submitted_by_session_id` text,
	`disposition` text DEFAULT 'pending' NOT NULL, `reviewed_by_type` text, `reviewed_by_id` text,
	`reviewed_by_session_id` text, `review_reason` text, `submitted_at` text NOT NULL, `reviewed_at` text,
	`version` integer DEFAULT 1 NOT NULL, `metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_work_evidence_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_evidence_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_evidence_attempt_id_work_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `work_attempts`(`id`) ON DELETE SET NULL,
	CONSTRAINT `chk_work_evidence_review_state` CHECK ((`disposition` = 'pending' AND `reviewed_at` IS NULL AND `reviewed_by_type` IS NULL AND `reviewed_by_id` IS NULL) OR (`disposition` != 'pending' AND `reviewed_at` IS NOT NULL AND `reviewed_by_type` IS NOT NULL AND `reviewed_by_id` IS NOT NULL))
);--> statement-breakpoint
INSERT INTO `work_evidence` (`id`,`work_item_id`,`org_id`,`claim_key`,`kind`,`uri`,`digest`,`submitted_by_type`,`submitted_by_id`,`submitted_by_session_id`,`disposition`,`reviewed_by_type`,`reviewed_by_id`,`review_reason`,`submitted_at`,`reviewed_at`,`version`,`metadata`)
SELECT 'commit:' || `id`,`work_item_id`,`org_id`,'outcome','commit','git:commit:' || `commit_sha`,`commit_sha`,
	CASE WHEN `agent_session` IS NULL THEN 'system' ELSE 'external_agent' END,coalesce(`agent_session`,'git-tie'),`agent_session`,
	'accepted','system','git-tie','Backfilled from immutable commit certification',`certified_at`,`certified_at`,1,json_object('certificationId',`id`)
FROM `work_item_commit_certifications`;--> statement-breakpoint
INSERT INTO `work_evidence` (`id`,`work_item_id`,`org_id`,`claim_key`,`kind`,`uri`,`submitted_by_type`,`submitted_by_id`,`disposition`,`reviewed_by_type`,`reviewed_by_id`,`review_reason`,`submitted_at`,`reviewed_at`,`version`,`metadata`)
SELECT 'legacy:' || item.`id`,item.`id`,item.`org_id`,'outcome','legacy','legacy:work-item:' || item.`id` || ':completion','system','migration','accepted','system','migration','Completion predates typed evidence',coalesce(item.`completed_at`,item.`updated_at`,item.`created_at`),coalesce(item.`completed_at`,item.`updated_at`,item.`created_at`),1,json_object('legacyDisposition','completed','migrationException','grandfathered_pre_cutover_completion')
FROM `work_items` item
WHERE item.`disposition` = 'completed' AND NOT EXISTS (SELECT 1 FROM `work_evidence` evidence WHERE evidence.`org_id` = item.`org_id` AND evidence.`work_item_id` = item.`id` AND evidence.`claim_key` = 'outcome' AND evidence.`disposition` = 'accepted');--> statement-breakpoint
CREATE INDEX `idx_work_evidence_item_disposition` ON `work_evidence` (`org_id`,`work_item_id`,`disposition`);--> statement-breakpoint
CREATE INDEX `idx_work_evidence_attempt` ON `work_evidence` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_evidence_observation` ON `work_evidence` (`org_id`,`work_item_id`,`claim_key`,`uri`,`digest`);--> statement-breakpoint

CREATE TABLE `work_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT, `id` text NOT NULL UNIQUE, `org_id` text NOT NULL,
	`work_item_id` text NOT NULL, `attempt_id` text, `event_type` text NOT NULL, `actor_type` text NOT NULL,
	`actor_id` text NOT NULL, `actor_session_id` text, `payload` text DEFAULT '{}' NOT NULL, `occurred_at` text NOT NULL,
	CONSTRAINT `fk_work_events_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_event_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_events_attempt_id_work_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `work_attempts`(`id`) ON DELETE SET NULL
);--> statement-breakpoint
INSERT INTO `work_events` (`id`,`org_id`,`work_item_id`,`event_type`,`actor_type`,`actor_id`,`actor_session_id`,`payload`,`occurred_at`)
SELECT 'comment:' || `id`,`org_id`,`work_item_id`,`event_type`,`author_type`,coalesce(nullif(`author_id`,''),'unknown'),nullif(json_extract(`metadata`,'$.agentSession'),''),json_object('commentId',`id`,'body',`body`),`created_at`
FROM `work_item_comments` WHERE `event_type` != 'comment';--> statement-breakpoint
CREATE INDEX `idx_work_events_item_sequence` ON `work_events` (`org_id`,`work_item_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_work_events_attempt_sequence` ON `work_events` (`attempt_id`,`sequence`);--> statement-breakpoint

DELETE FROM `work_item_comments` WHERE `event_type` != 'comment';--> statement-breakpoint
ALTER TABLE `work_item_comments` DROP COLUMN `event_type`;--> statement-breakpoint

INSERT OR IGNORE INTO `work_item_relations` (`id`,`org_id`,`from_work_item_id`,`to_work_item_id`,`relation_type`,`metadata`,`created_at`) SELECT `id` || ':canonical',`org_id`,`to_work_item_id`,`from_work_item_id`,'blocks',`metadata`,`created_at` FROM `work_item_relations` WHERE `relation_type` = 'blocked_by';--> statement-breakpoint
DELETE FROM `work_item_relations` WHERE `relation_type` = 'blocked_by';--> statement-breakpoint
INSERT OR IGNORE INTO `work_item_relations` (`id`,`org_id`,`from_work_item_id`,`to_work_item_id`,`relation_type`,`metadata`,`created_at`) SELECT `id` || ':canonical',`org_id`,`to_work_item_id`,`from_work_item_id`,'duplicates',`metadata`,`created_at` FROM `work_item_relations` WHERE `relation_type` = 'duplicated_by';--> statement-breakpoint
DELETE FROM `work_item_relations` WHERE `relation_type` = 'duplicated_by';--> statement-breakpoint
DELETE FROM `work_item_relations` WHERE `relation_type` IN ('parent','child');--> statement-breakpoint

DROP TABLE `work_item_checkouts`;--> statement-breakpoint
DROP TABLE `work_item_executor_checkouts`;--> statement-breakpoint

CREATE TRIGGER `work_item_comment_outbox`
AFTER INSERT ON `work_item_comments`
BEGIN
	INSERT INTO `work_item_outbox_events` (`id`,`org_id`,`work_item_id`,`event_type`,`source_session_key`,`source_author_type`,`source_author_id`,`payload`,`created_at`)
	VALUES (lower(hex(randomblob(16))),NEW.`org_id`,NEW.`work_item_id`,'comment',nullif(json_extract(NEW.`metadata`,'$.agentSession'),''),NEW.`author_type`,NEW.`author_id`,json_object('commentId',NEW.`id`,'body',NEW.`body`,'eventType','comment'),NEW.`created_at`);
	INSERT OR IGNORE INTO `work_item_inbox_deliveries` (`id`,`org_id`,`event_sequence`,`recipient_type`,`recipient_id`,`created_at`)
	SELECT lower(hex(randomblob(16))),NEW.`org_id`,(SELECT max(`sequence`) FROM `work_item_outbox_events`),'agent_session',coalesce(nullif(json_extract(attempt.`metadata`,'$.agentSession'),''),attempt.`executor_session_id`),NEW.`created_at`
	FROM `work_attempts` attempt
	WHERE attempt.`org_id` = NEW.`org_id` AND attempt.`work_item_id` = NEW.`work_item_id` AND attempt.`runtime_state` IN ('queued','running','waiting','retrying')
		AND coalesce(nullif(json_extract(attempt.`metadata`,'$.agentSession'),''),attempt.`executor_session_id`) IS NOT NULL;
END;
