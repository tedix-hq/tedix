DROP TRIGGER `work_attempt_admission_update_guard`;--> statement-breakpoint
UPDATE `work_attempts`
SET
	`metadata`=json_set(coalesce(`metadata`,'{}'),'$.migratedCompositeAttemptId',`id`),
	`id`='40000000-0000-5000-8000-' || printf('%012x',rowid)
WHERE length(`id`)<>36 OR substr(`id`,9,1)<>'-' OR substr(`id`,14,1)<>'-' OR substr(`id`,19,1)<>'-' OR substr(`id`,24,1)<>'-';--> statement-breakpoint

CREATE TRIGGER `work_attempt_admission_update_guard` BEFORE UPDATE ON `work_attempts`
BEGIN
	SELECT RAISE(ABORT,'attempt fence or terminal state is immutable') WHERE NEW.`admission_id` IS NOT OLD.`admission_id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`executor_type`<>OLD.`executor_type` OR NEW.`executor_id`<>OLD.`executor_id` OR NEW.`executor_session_id` IS NOT OLD.`executor_session_id` OR NEW.`external_session_key` IS NOT OLD.`external_session_key` OR NEW.`version`<>OLD.`version`+1 OR OLD.`runtime_state` NOT IN ('queued','running','waiting','retrying');
	SELECT RAISE(ABORT,'active attempt requires bounded expiry') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`expires_at` IS NULL;
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
END;
