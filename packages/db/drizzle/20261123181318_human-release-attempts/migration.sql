-- tedix: destructive-reviewed Work-Item: fb5c1dc5-c7e5-42bd-8fe1-1c8ffacb8afe
--> statement-breakpoint
-- Rebuild identity checks without disabling foreign keys. Preserve reservations,
--> statement-breakpoint
-- event/evidence Attempt links and every pre-existing guard during the swap.
--> statement-breakpoint
DROP TRIGGER `work_admission_fact_cap_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_admission_immutable_delete`;
--> statement-breakpoint
DROP TRIGGER `work_admission_immutable_update`;
--> statement-breakpoint
DROP TRIGGER `work_admission_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_admission_scope_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_attempt_admission_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_attempt_admission_update_guard`;
--> statement-breakpoint
DROP TRIGGER `work_budget_reservation_delete_guard`;
--> statement-breakpoint
DROP TRIGGER `work_budget_reservation_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_budget_reservation_update_guard`;
--> statement-breakpoint
DROP TRIGGER `work_events_scope_insert`;
--> statement-breakpoint
DROP TRIGGER `work_events_scope_update`;
--> statement-breakpoint
DROP TRIGGER `work_resource_reservation_delete_guard`;
--> statement-breakpoint
DROP TRIGGER `work_resource_reservation_insert_guard`;
--> statement-breakpoint
DROP TRIGGER `work_resource_reservation_update_guard`;
--> statement-breakpoint
CREATE TABLE `_release_backup_work_budget_reservations` AS SELECT * FROM `work_budget_reservations`;
--> statement-breakpoint
DELETE FROM `work_budget_reservations`;
--> statement-breakpoint
CREATE TABLE `_release_backup_work_resource_reservations` AS SELECT * FROM `work_resource_reservations`;
--> statement-breakpoint
DELETE FROM `work_resource_reservations`;
--> statement-breakpoint
CREATE TABLE `_release_backup_work_events` AS SELECT id,attempt_id FROM `work_events` WHERE attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `_release_backup_work_evidence` AS SELECT id,attempt_id FROM `work_evidence` WHERE attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `__new_work_attempts` (
	`id` text PRIMARY KEY,
	`admission_id` text,
	`work_item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_session_id` text,
	`external_session_key` text,
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
	CONSTRAINT "chk_work_attempt_identity" CHECK(("executor_type" IN ('human', 'tedi') AND "executor_session_id" IS NULL AND "external_session_key" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL AND "external_session_key" IS NOT NULL)),
	CONSTRAINT "chk_work_attempt_terminal_state" CHECK(("runtime_state" IN ('failed', 'expired', 'finished', 'cancelled') AND "finished_at" IS NOT NULL AND "outcome" IS NOT NULL) OR ("runtime_state" IN ('queued', 'running', 'waiting', 'retrying') AND "finished_at" IS NULL AND "outcome" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_work_attempts`(`id`, `admission_id`, `work_item_id`, `org_id`, `executor_type`, `executor_id`, `executor_session_id`, `external_session_key`, `run_id`, `runtime_state`, `outcome`, `attempt_number`, `started_at`, `heartbeat_at`, `expires_at`, `finished_at`, `summary`, `version`, `metadata`) SELECT `id`, `admission_id`, `work_item_id`, `org_id`, `executor_type`, `executor_id`, `executor_session_id`, `external_session_key`, `run_id`, `runtime_state`, `outcome`, `attempt_number`, `started_at`, `heartbeat_at`, `expires_at`, `finished_at`, `summary`, `version`, `metadata` FROM `work_attempts`;--> statement-breakpoint
DROP TABLE `work_attempts`;--> statement-breakpoint
ALTER TABLE `__new_work_attempts` RENAME TO `work_attempts`;--> statement-breakpoint
CREATE TABLE `__new_work_admissions` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`work_item_version` integer NOT NULL,
	`admission_spec_revision` text NOT NULL,
	`executor_type` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_session_id` text,
	`external_session_key` text,
	`decision` text NOT NULL,
	`rejection_code` text,
	`rejection_reason` text,
	`rejection_key` text,
	`max_cost_micros` integer,
	`decided_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_admissions_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_admission_item` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE RESTRICT,
	CONSTRAINT "chk_work_admission_identity" CHECK(("executor_type" IN ('human', 'tedi') AND "executor_session_id" IS NULL AND "external_session_key" IS NULL) OR ("executor_type" = 'external_agent' AND "executor_session_id" IS NOT NULL AND "external_session_key" IS NOT NULL)),
	CONSTRAINT "chk_work_admission_decision" CHECK(("decision" = 'admitted' AND "rejection_code" IS NULL AND "rejection_reason" IS NULL AND "rejection_key" IS NULL) OR ("decision" = 'rejected' AND "rejection_code" IS NOT NULL AND "rejection_reason" IS NOT NULL AND "rejection_key" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_work_admissions`(`id`, `org_id`, `work_item_id`, `work_item_version`, `admission_spec_revision`, `executor_type`, `executor_id`, `executor_session_id`, `external_session_key`, `decision`, `rejection_code`, `rejection_reason`, `rejection_key`, `max_cost_micros`, `decided_at`, `expires_at`, `created_at`) SELECT `id`, `org_id`, `work_item_id`, `work_item_version`, `admission_spec_revision`, `executor_type`, `executor_id`, `executor_session_id`, `external_session_key`, `decision`, `rejection_code`, `rejection_reason`, `rejection_key`, `max_cost_micros`, `decided_at`, `expires_at`, `created_at` FROM `work_admissions`;--> statement-breakpoint
DROP TABLE `work_admissions`;--> statement-breakpoint
ALTER TABLE `__new_work_admissions` RENAME TO `work_admissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_number` ON `work_attempts` (`org_id`,`work_item_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_admission` ON `work_attempts` (`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_active` ON `work_attempts` (`org_id`,`work_item_id`) WHERE "work_attempts"."runtime_state" IN ('queued', 'running', 'waiting', 'retrying');--> statement-breakpoint
CREATE INDEX `idx_work_attempt_executor_state` ON `work_attempts` (`org_id`,`executor_type`,`executor_id`,`runtime_state`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_expiry` ON `work_attempts` (`runtime_state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_org_started` ON `work_attempts` (`org_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_org_item_heartbeat` ON `work_attempts` (`org_id`,`work_item_id`,`heartbeat_at`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_org_item_started` ON `work_attempts` (`org_id`,`work_item_id`,started_at DESC,id DESC);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_org_state_started` ON `work_attempts` (`org_id`,`runtime_state`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_admission_org_item_id` ON `work_admissions` (`org_id`,`work_item_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_admission_rejection_key` ON `work_admissions` (`org_id`,`rejection_key`);--> statement-breakpoint
CREATE INDEX `idx_work_admission_executor_time` ON `work_admissions` (`org_id`,`executor_type`,`executor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_admission_item_time` ON `work_admissions` (`org_id`,`work_item_id`,`created_at`);
--> statement-breakpoint
INSERT INTO `work_budget_reservations` SELECT * FROM `_release_backup_work_budget_reservations`;
--> statement-breakpoint
DROP TABLE `_release_backup_work_budget_reservations`;
--> statement-breakpoint
INSERT INTO `work_resource_reservations` SELECT * FROM `_release_backup_work_resource_reservations`;
--> statement-breakpoint
DROP TABLE `_release_backup_work_resource_reservations`;
--> statement-breakpoint
UPDATE `work_events` SET attempt_id=(SELECT attempt_id FROM `_release_backup_work_events` b WHERE b.id=`work_events`.id) WHERE id IN (SELECT id FROM `_release_backup_work_events`);
--> statement-breakpoint
DROP TABLE `_release_backup_work_events`;
--> statement-breakpoint
UPDATE `work_evidence` SET attempt_id=(SELECT attempt_id FROM `_release_backup_work_evidence` b WHERE b.id=`work_evidence`.id) WHERE id IN (SELECT id FROM `_release_backup_work_evidence`);
--> statement-breakpoint
DROP TABLE `_release_backup_work_evidence`;
--> statement-breakpoint
CREATE TRIGGER `work_admission_fact_cap_insert_guard` BEFORE INSERT ON `work_admissions`
WHEN NEW.`decision` = 'admitted'
BEGIN
	SELECT RAISE(ABORT, 'resource requirement facts exceed admission cap')
	WHERE (
		SELECT COUNT(*)
		FROM `work_resource_requirements` requirement
		WHERE requirement.`org_id` = NEW.`org_id`
			AND requirement.`work_item_id` = NEW.`work_item_id`
	) > 500;

	SELECT RAISE(ABORT, 'budget envelope facts exceed admission cap')
	WHERE (
		SELECT COUNT(*)
		FROM `work_budget_envelopes` envelope
		WHERE envelope.`org_id` = NEW.`org_id`
			AND envelope.`enabled` = 1
			AND (
				(envelope.`scope_type` = 'organization' AND envelope.`scope_id` = NEW.`org_id`)
				OR (envelope.`scope_type` = 'work_item' AND envelope.`scope_id` IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
 SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
 UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
 WHERE parent.org_id=NEW.org_id AND json_type(child.metadata,'$.childDelegation.parentAttemptId')='text'
 ) SELECT id FROM ancestors))
				OR (
					envelope.`scope_type` = 'project'
					AND envelope.`scope_id` = (
						SELECT item.`project_id`
						FROM `work_items` item
						WHERE item.`org_id` = NEW.`org_id`
							AND item.`id` = NEW.`work_item_id`
					)
				)
				OR (
					envelope.`scope_type` = 'case'
					AND EXISTS (
						SELECT 1
						FROM `work_case_items` case_item
						WHERE case_item.`org_id` = NEW.`org_id`
							AND case_item.`work_item_id` = NEW.`work_item_id`
							AND case_item.`case_id` = envelope.`scope_id`
					)
				)
			)
	) > 1000;
END;
--> statement-breakpoint
CREATE TRIGGER `work_admission_immutable_delete` BEFORE DELETE ON `work_admissions` BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `work_admission_immutable_update` BEFORE UPDATE ON `work_admissions` BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `work_admission_insert_guard` BEFORE INSERT ON `work_admissions`
WHEN NEW.`decision`='admitted'
BEGIN
	SELECT RAISE(ABORT,'inactive human release executor') WHERE NEW.`executor_type`='human' AND NOT EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`executor_id` AND m.`kind`='human' AND m.`status`='active');
	SELECT RAISE(ABORT,'stale admission specification') WHERE NOT EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id` AND wi.`version`=NEW.`work_item_version` AND wi.`admission_spec_revision`=NEW.`admission_spec_revision` AND wi.`disposition`='accepted');
	SELECT RAISE(ABORT,'expired admission') WHERE NEW.`expires_at`<=NEW.`decided_at`;
	SELECT RAISE(ABORT,'admission dependency blocked') WHERE EXISTS(SELECT 1 FROM `work_item_relations` rel JOIN `work_items` prerequisite ON prerequisite.`org_id`=rel.`org_id` AND prerequisite.`id`=rel.`from_work_item_id` WHERE rel.`org_id`=NEW.`org_id` AND rel.`to_work_item_id`=NEW.`work_item_id` AND rel.`relation_type`='blocks' AND prerequisite.`disposition` NOT IN ('completed','cancelled'));
	SELECT RAISE(ABORT,'work already running') WHERE EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`runtime_state` IN ('queued','running','waiting','retrying') AND (a.`expires_at` IS NULL OR a.`expires_at`>NEW.`decided_at`));
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'executor capability missing') WHERE EXISTS(
		SELECT 1 FROM json_each((SELECT wi.`required_capabilities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) required
		WHERE NOT EXISTS(SELECT 1 FROM `org_capabilities` c JOIN `capability_links` l ON l.`organization_id`=c.`organization_id` AND l.`capability_id`=c.`id` WHERE c.`organization_id`=NEW.`org_id` AND c.`status`='active' AND (c.`id`=required.`value` OR c.`slug`=required.`value`) AND l.`entity_kind`=NEW.`executor_type` AND l.`entity_id`=NEW.`executor_id`)
	);
	SELECT RAISE(ABORT,'admission approval missing') WHERE NOT (EXISTS (SELECT 1 FROM work_items child
 JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
 JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=json_extract(child.metadata,'$.childDelegation.parentAttemptId')
 JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
 JOIN organizations org ON org.id=child.org_id
 WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
 AND json_extract(child.metadata,'$.childDelegation.parentRevision')=parent.admission_spec_revision
 AND json_extract(child.metadata,'$.childDelegation.approvalMode')='auto'
 AND COALESCE(json_extract(org.metadata,'$.workDelegation.approvalMode'),'auto')='auto'
 AND child.risk_level=parent.risk_level
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_capabilities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(parent.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(child.required_authorities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_authorities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(parent.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(child.required_capabilities)))
)) AND EXISTS(
		SELECT 1 FROM (
			SELECT value AS authority FROM json_each((SELECT wi.`required_authorities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`))
			UNION ALL SELECT 'risk:high' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='high'
			UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='critical'
		) required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version` BETWEEN COALESCE((SELECT json_extract(e.`payload`, '$.planningApproval.fromVersion') FROM `work_events` e WHERE e.`org_id`=NEW.`org_id` AND e.`work_item_id`=NEW.`work_item_id` AND e.`event_type`='work.specification_updated' AND json_extract(e.`payload`, '$.planningApproval.toVersion')=NEW.`work_item_version` AND json_extract(e.`payload`, '$.planningApproval.admissionSpecRevision')=NEW.`admission_spec_revision` ORDER BY e.`sequence` DESC LIMIT 1), NEW.`work_item_version`) AND NEW.`work_item_version` AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`decided_at`)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `work_admission_scope_insert_guard` BEFORE INSERT ON `work_admissions`
BEGIN
	SELECT RAISE(ABORT,'invalid admission receipt state') WHERE NEW.`decision` NOT IN ('admitted','rejected') OR NEW.`executor_type` NOT IN ('tedi','external_agent');
	SELECT RAISE(ABORT,'admission receipt is not current') WHERE NOT EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id` AND wi.`version`=NEW.`work_item_version` AND wi.`admission_spec_revision`=NEW.`admission_spec_revision`);
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'invalid rejection receipt') WHERE NEW.`decision`='rejected' AND (NEW.`rejection_key` IS NULL OR NEW.`rejection_code` IS NULL OR NEW.`rejection_reason` IS NULL OR NEW.`expires_at`<=NEW.`decided_at`);
	SELECT RAISE(ABORT,'admitted receipt cannot carry rejection') WHERE NEW.`decision`='admitted' AND (NEW.`rejection_key` IS NOT NULL OR NEW.`rejection_code` IS NOT NULL OR NEW.`rejection_reason` IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `work_attempt_admission_insert_guard` BEFORE INSERT ON `work_attempts`
BEGIN
	SELECT RAISE(ABORT,'inactive human release executor') WHERE NEW.`executor_type`='human' AND NOT EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`executor_id` AND m.`kind`='human' AND m.`status`='active');
	SELECT RAISE(ABORT,'attempt does not match active admission') WHERE NEW.`admission_id` IS NULL OR NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_items` wi ON wi.`org_id`=a.`org_id` AND wi.`id`=a.`work_item_id`
		WHERE a.`id`=NEW.`admission_id` AND a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`decision`='admitted' AND NEW.`expires_at` IS NOT NULL AND a.`expires_at`=NEW.`expires_at` AND a.`expires_at`>NEW.`started_at` AND a.`executor_type`=NEW.`executor_type` AND a.`executor_id`=NEW.`executor_id` AND a.`executor_session_id` IS NEW.`executor_session_id` AND a.`external_session_key` IS NEW.`external_session_key` AND wi.`version`=a.`work_item_version` AND wi.`admission_spec_revision`=a.`admission_spec_revision` AND wi.`disposition`='accepted'
	);
	SELECT RAISE(ABORT,'attempt dependency blocked') WHERE EXISTS(SELECT 1 FROM `work_item_relations` rel JOIN `work_items` prerequisite ON prerequisite.`org_id`=rel.`org_id` AND prerequisite.`id`=rel.`from_work_item_id` WHERE rel.`org_id`=NEW.`org_id` AND rel.`to_work_item_id`=NEW.`work_item_id` AND rel.`relation_type`='blocks' AND prerequisite.`disposition` NOT IN ('completed','cancelled'));
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'attempt capability revoked') WHERE EXISTS(SELECT 1 FROM json_each((SELECT wi.`required_capabilities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) required WHERE NOT EXISTS(SELECT 1 FROM `org_capabilities` c JOIN `capability_links` l ON l.`organization_id`=c.`organization_id` AND l.`capability_id`=c.`id` WHERE c.`organization_id`=NEW.`org_id` AND c.`status`='active' AND (c.`id`=required.`value` OR c.`slug`=required.`value`) AND l.`entity_kind`=NEW.`executor_type` AND l.`entity_id`=NEW.`executor_id`));
	SELECT RAISE(ABORT,'attempt approval expired or revoked') WHERE NOT (EXISTS (SELECT 1 FROM work_items child
 JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
 JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=json_extract(child.metadata,'$.childDelegation.parentAttemptId')
 JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
 JOIN organizations org ON org.id=child.org_id
 WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
 AND json_extract(child.metadata,'$.childDelegation.parentRevision')=parent.admission_spec_revision
 AND json_extract(child.metadata,'$.childDelegation.approvalMode')='auto'
 AND COALESCE(json_extract(org.metadata,'$.workDelegation.approvalMode'),'auto')='auto'
 AND child.risk_level=parent.risk_level
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_capabilities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(parent.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(child.required_authorities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_authorities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(parent.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(child.required_capabilities)))
)) AND EXISTS(SELECT 1 FROM (SELECT value AS authority FROM json_each((SELECT wi.`required_authorities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) UNION ALL SELECT 'risk:high' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='high' UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='critical') required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version` BETWEEN COALESCE((SELECT json_extract(e.`payload`, '$.planningApproval.fromVersion') FROM `work_events` e WHERE e.`org_id`=NEW.`org_id` AND e.`work_item_id`=NEW.`work_item_id` AND e.`event_type`='work.specification_updated' AND json_extract(e.`payload`, '$.planningApproval.toVersion')=(SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) AND json_extract(e.`payload`, '$.planningApproval.admissionSpecRevision')=(SELECT wi.`admission_spec_revision` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) ORDER BY e.`sequence` DESC LIMIT 1), (SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) AND (SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`started_at`));
	SELECT RAISE(ABORT,'attempt resource reservation missing or pool revoked') WHERE EXISTS(SELECT 1 FROM `work_resource_requirements` req WHERE req.`org_id`=NEW.`org_id` AND req.`work_item_id`=NEW.`work_item_id` AND NOT EXISTS(SELECT 1 FROM `work_resource_reservations` r JOIN `work_resource_pools` pool ON pool.`org_id`=r.`org_id` AND pool.`id`=r.`pool_id` WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`resource_key`=req.`resource_key` AND r.`quantity`=req.`quantity` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at` AND pool.`resource_key`=req.`resource_key` AND pool.`version`=r.`pool_version` AND pool.`enabled`=1));
	SELECT RAISE(ABORT,'attempt budget reservation missing') WHERE EXISTS(SELECT 1 FROM `work_budget_envelopes` envelope JOIN `work_items` wi ON wi.`org_id`=envelope.`org_id` AND wi.`id`=NEW.`work_item_id` WHERE envelope.`org_id`=NEW.`org_id` AND envelope.`enabled`=1 AND envelope.`currency`<>'credits' AND (envelope.`scope_type`='organization' AND envelope.`scope_id`=NEW.`org_id` OR envelope.`scope_type`='work_item' AND envelope.`scope_id` IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
 SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
 UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
 WHERE parent.org_id=NEW.org_id AND json_type(child.metadata,'$.childDelegation.parentAttemptId')='text'
 ) SELECT id FROM ancestors) OR envelope.`scope_type`='project' AND envelope.`scope_id`=wi.`project_id` OR envelope.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_case_items` ci WHERE ci.`org_id`=NEW.`org_id` AND ci.`work_item_id`=NEW.`work_item_id` AND ci.`case_id`=envelope.`scope_id`)) AND NOT EXISTS(SELECT 1 FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`envelope_id`=envelope.`id` AND r.`envelope_version`=envelope.`version` AND r.`amount_micros`=envelope.`reservation_micros` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at`));
END;
--> statement-breakpoint
CREATE TRIGGER `work_attempt_admission_update_guard` BEFORE UPDATE ON `work_attempts`
BEGIN
	SELECT RAISE(ABORT,'inactive human release executor') WHERE NEW.`executor_type`='human' AND NOT EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`executor_id` AND m.`kind`='human' AND m.`status`='active');
    SELECT RAISE(ABORT,'human release target is immutable') WHERE OLD.`executor_type`='human' AND json_extract(NEW.`metadata`,'$.cliRelease') IS NOT json_extract(OLD.`metadata`,'$.cliRelease');
	SELECT RAISE(ABORT,'attempt fence or terminal state is immutable') WHERE NEW.`admission_id` IS NOT OLD.`admission_id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`executor_type`<>OLD.`executor_type` OR NEW.`executor_id`<>OLD.`executor_id` OR NEW.`executor_session_id` IS NOT OLD.`executor_session_id` OR NEW.`external_session_key` IS NOT OLD.`external_session_key` OR NEW.`version`<>OLD.`version`+1 OR OLD.`runtime_state` NOT IN ('queued','running','waiting','retrying');
	SELECT RAISE(ABORT,'active attempt requires bounded expiry') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`expires_at` IS NULL;
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
END;
--> statement-breakpoint
CREATE TRIGGER `work_budget_reservation_delete_guard` BEFORE DELETE ON `work_budget_reservations` BEGIN SELECT RAISE(ABORT,'budget reservations are retained'); END;
--> statement-breakpoint
CREATE TRIGGER `work_budget_reservation_insert_guard` BEFORE INSERT ON `work_budget_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid budget reservation initial state') WHERE NEW.`state`<>'active' OR NEW.`version`<>1 OR NEW.`settled_at` IS NOT NULL OR NEW.`consumed_micros` IS NOT NULL;
	SELECT RAISE(ABORT,'budget reservation does not match admission envelope') WHERE NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_items` wi ON wi.`org_id`=a.`org_id` AND wi.`id`=a.`work_item_id` JOIN `work_budget_envelopes` envelope ON envelope.`org_id`=a.`org_id` AND envelope.`id`=NEW.`envelope_id`
		WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`id`=NEW.`admission_id` AND a.`decision`='admitted' AND a.`expires_at`>NEW.`reserved_at` AND envelope.`version`=NEW.`envelope_version` AND envelope.`enabled`=1 AND envelope.`reservation_micros`=NEW.`amount_micros` AND (
			envelope.`scope_type`='organization' AND envelope.`scope_id`=a.`org_id` OR envelope.`scope_type`='work_item' AND envelope.`scope_id` IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
 SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=a.org_id AND id=a.work_item_id
 UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
 WHERE parent.org_id=a.org_id AND json_type(child.metadata,'$.childDelegation.parentAttemptId')='text'
 ) SELECT id FROM ancestors) OR envelope.`scope_type`='project' AND envelope.`scope_id`=wi.`project_id` OR envelope.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_case_items` ci WHERE ci.`org_id`=a.`org_id` AND ci.`work_item_id`=a.`work_item_id` AND ci.`case_id`=envelope.`scope_id`)
		)
	);
	SELECT RAISE(ABORT,'budget exhausted') WHERE NEW.`amount_micros`+
		(SELECT COALESCE(SUM(COALESCE(r.`consumed_micros`,r.`amount_micros`)),0) FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`envelope_id`=NEW.`envelope_id` AND r.`state`='consumed')+
		(SELECT COALESCE(SUM(r.`amount_micros`),0) FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`envelope_id`=NEW.`envelope_id` AND r.`state`='active' AND r.`expires_at`>NEW.`reserved_at`)
		> (SELECT envelope.`limit_micros` FROM `work_budget_envelopes` envelope WHERE envelope.`org_id`=NEW.`org_id` AND envelope.`id`=NEW.`envelope_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `work_budget_reservation_update_guard` BEFORE UPDATE ON `work_budget_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid budget reservation transition') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`admission_id`<>OLD.`admission_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`envelope_id`<>OLD.`envelope_id` OR NEW.`envelope_version`<>OLD.`envelope_version` OR NEW.`amount_micros`<>OLD.`amount_micros` OR NEW.`version`<>OLD.`version`+1 OR OLD.`state`<>'active' OR NEW.`state` NOT IN ('active','released','consumed','expired');
	SELECT RAISE(ABORT,'invalid consumed budget amount') WHERE NEW.`state`='consumed' AND (NEW.`consumed_micros` IS NULL OR NEW.`consumed_micros`<0 OR NEW.`consumed_micros`>NEW.`amount_micros`);
	SELECT RAISE(ABORT,'budget heartbeat lacks active attempt') WHERE NEW.`state`='active' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('queued','running','waiting','retrying') AND a.`expires_at`=NEW.`expires_at`);
	SELECT RAISE(ABORT,'budget release lacks settlement or losing start') WHERE NEW.`state`='released' AND NOT (EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`admission_id`=NEW.`admission_id`));
	SELECT RAISE(ABORT,'budget consume lacks settlement') WHERE NEW.`state`='consumed' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired'));
	SELECT RAISE(ABORT,'budget expiry lacks timeout') WHERE NEW.`state`='expired' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state`='expired');
END;
--> statement-breakpoint
CREATE TRIGGER work_events_scope_insert AFTER INSERT ON work_events
BEGIN
  UPDATE work_events
  SET (project_id, objective_id) = (
    SELECT project_id, objective_id FROM work_items
    WHERE org_id = NEW.org_id AND id = NEW.work_item_id
  ) WHERE sequence = NEW.sequence;
END;
--> statement-breakpoint
CREATE TRIGGER work_events_scope_update
AFTER UPDATE OF org_id, work_item_id, project_id, objective_id ON work_events
WHEN (NEW.project_id, NEW.objective_id) IS NOT (
  SELECT project_id, objective_id FROM work_items
  WHERE org_id = NEW.org_id AND id = NEW.work_item_id
)
BEGIN
  UPDATE work_events
  SET (project_id, objective_id) = (
    SELECT project_id, objective_id FROM work_items
    WHERE org_id = NEW.org_id AND id = NEW.work_item_id
  ) WHERE sequence = NEW.sequence;
END;
--> statement-breakpoint
CREATE TRIGGER `work_resource_reservation_delete_guard` BEFORE DELETE ON `work_resource_reservations` BEGIN SELECT RAISE(ABORT,'resource reservations are retained'); END;
--> statement-breakpoint
CREATE TRIGGER `work_resource_reservation_insert_guard` BEFORE INSERT ON `work_resource_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid resource reservation initial state') WHERE NEW.`state`<>'active' OR NEW.`version`<>1 OR NEW.`settled_at` IS NOT NULL;
	SELECT RAISE(ABORT,'resource reservation does not match admission requirement') WHERE NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_resource_requirements` req ON req.`org_id`=a.`org_id` AND req.`work_item_id`=a.`work_item_id` AND req.`resource_key`=NEW.`resource_key` JOIN `work_resource_pools` pool ON pool.`org_id`=req.`org_id` AND pool.`resource_key`=req.`resource_key`
		WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`id`=NEW.`admission_id` AND a.`decision`='admitted' AND a.`expires_at`>NEW.`reserved_at` AND pool.`id`=NEW.`pool_id` AND pool.`version`=NEW.`pool_version` AND pool.`enabled`=1 AND req.`quantity`=NEW.`quantity`
	);
	SELECT RAISE(ABORT,'resource capacity exhausted') WHERE NEW.`quantity`+(SELECT COALESCE(SUM(r.`quantity`),0) FROM `work_resource_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`pool_id`=NEW.`pool_id` AND r.`state`='active' AND r.`expires_at`>NEW.`reserved_at`) > (SELECT pool.`capacity` FROM `work_resource_pools` pool WHERE pool.`org_id`=NEW.`org_id` AND pool.`id`=NEW.`pool_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `work_resource_reservation_update_guard` BEFORE UPDATE ON `work_resource_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid resource reservation transition') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`admission_id`<>OLD.`admission_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`pool_id`<>OLD.`pool_id` OR NEW.`pool_version`<>OLD.`pool_version` OR NEW.`resource_key`<>OLD.`resource_key` OR NEW.`quantity`<>OLD.`quantity` OR NEW.`version`<>OLD.`version`+1 OR OLD.`state`<>'active' OR NEW.`state` NOT IN ('active','released','consumed','expired');
	SELECT RAISE(ABORT,'resource heartbeat lacks active attempt') WHERE NEW.`state`='active' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('queued','running','waiting','retrying') AND a.`expires_at`=NEW.`expires_at`);
	SELECT RAISE(ABORT,'resource release lacks settlement or losing start') WHERE NEW.`state`='released' AND NOT (EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`admission_id`=NEW.`admission_id`));
	SELECT RAISE(ABORT,'resource consume lacks settlement') WHERE NEW.`state`='consumed' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired'));
	SELECT RAISE(ABORT,'resource expiry lacks timeout') WHERE NEW.`state`='expired' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state`='expired');
END;
