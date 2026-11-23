-- Admit canonical human principals through the existing scope guard.
DROP TRIGGER `work_admission_scope_insert_guard`;
--> statement-breakpoint
CREATE TRIGGER `work_admission_scope_insert_guard` BEFORE INSERT ON `work_admissions`
BEGIN
	SELECT RAISE(ABORT,'inactive human executor') WHERE NEW.`executor_type`='human' AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.executor_id AND m.kind='human' AND m.status='active');
	SELECT RAISE(ABORT,'invalid admission receipt state') WHERE NEW.`decision` NOT IN ('admitted','rejected') OR NEW.`executor_type` NOT IN ('human','tedi','external_agent');
	SELECT RAISE(ABORT,'admission receipt is not current') WHERE NOT EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id` AND wi.`version`=NEW.`work_item_version` AND wi.`admission_spec_revision`=NEW.`admission_spec_revision`);
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'invalid rejection receipt') WHERE NEW.`decision`='rejected' AND (NEW.`rejection_key` IS NULL OR NEW.`rejection_code` IS NULL OR NEW.`rejection_reason` IS NULL OR NEW.`expires_at`<=NEW.`decided_at`);
	SELECT RAISE(ABORT,'admitted receipt cannot carry rejection') WHERE NEW.`decision`='admitted' AND (NEW.`rejection_key` IS NOT NULL OR NEW.`rejection_code` IS NOT NULL OR NEW.`rejection_reason` IS NOT NULL);
END;
