-- Preserve response lifecycle fences; only an audited human-to-tedi question handoff
-- may change the recipient while the question stays open.
DROP TRIGGER `work_interaction_update_guard`;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_update_guard` BEFORE UPDATE ON `work_interactions`
WHEN NOT (NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`metadata` IS NOT OLD.`metadata`)
BEGIN
	SELECT RAISE(ABORT,'invalid interaction transition') WHERE OLD.`status`<>'open' OR NEW.`status` NOT IN ('open','resolved','cancelled','expired') OR NEW.`version`<>OLD.`version`+1 OR NEW.`resolution_fence` IS NULL OR
		(NEW.`status`='open' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='resolved' AND (NEW.`resolved_at` IS NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='cancelled' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='expired' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NULL));
	SELECT RAISE(ABORT,'interaction immutable fields changed') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id` IS NOT OLD.`work_item_id` OR NEW.`case_id` IS NOT OLD.`case_id` OR NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`kind`<>OLD.`kind` OR NEW.`subject`<>OLD.`subject` OR NEW.`prompt`<>OLD.`prompt` OR NEW.`creator_type`<>OLD.`creator_type` OR NEW.`creator_id`<>OLD.`creator_id` OR NEW.`creator_session_id` IS NOT OLD.`creator_session_id` OR NEW.`creator_external_session_key` IS NOT OLD.`creator_external_session_key` OR NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR NEW.`created_at`<>OLD.`created_at` OR NEW.`metadata` IS NOT OLD.`metadata`;
	SELECT RAISE(ABORT,'interaction response receipt missing') WHERE NEW.`status` IN ('open','resolved') AND NOT EXISTS(SELECT 1 FROM `work_interaction_responses` r WHERE r.`org_id`=NEW.`org_id` AND r.`interaction_id`=NEW.`id` AND r.`resolved_request_version`=NEW.`version` AND r.`resolution_fence`=NEW.`resolution_fence` AND ((NEW.`status`='resolved' AND r.`resolves_request`=1) OR (NEW.`status`='open' AND r.`resolves_request`=0)));
END;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_delegation_guard` BEFORE UPDATE ON `work_interactions`
WHEN NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`metadata` IS NOT OLD.`metadata`
BEGIN
 SELECT RAISE(ABORT,'invalid interaction delegation') WHERE
  OLD.`kind`<>'question' OR OLD.`status`<>'open' OR NEW.`status`<>'open' OR
  OLD.`target_type`<>'user' OR NEW.`target_type`<>'tedi' OR NEW.`version`<>OLD.`version`+1 OR
  NEW.`resolution_fence` IS NOT OLD.`resolution_fence` OR
  NEW.`resolved_at` IS NOT OLD.`resolved_at` OR NEW.`cancelled_at` IS NOT OLD.`cancelled_at` OR NEW.`expired_at` IS NOT OLD.`expired_at` OR
  json_type(OLD.`metadata`,'$.delegation') IS NOT NULL OR
  json_type(NEW.`metadata`,'$.delegation') IS NOT 'object' OR
  json_extract(NEW.`metadata`,'$.delegation.fromType') IS NOT 'user' OR
  json_extract(NEW.`metadata`,'$.delegation.fromId') IS NOT OLD.`target_id` OR
  json_extract(NEW.`metadata`,'$.delegation.toTediId') IS NOT NEW.`target_id` OR
  json_type(NEW.`metadata`,'$.delegation.delegatedAt') IS NOT 'text' OR
  julianday(json_extract(NEW.`metadata`,'$.delegation.delegatedAt')) IS NULL OR
  json_extract(NEW.`metadata`,'$.delegation.delegatedAt')<OLD.`created_at` OR
  (OLD.`expires_at` IS NOT NULL AND OLD.`expires_at`<=json_extract(NEW.`metadata`,'$.delegation.delegatedAt')) OR
  json_remove(NEW.`metadata`,'$.delegation')<>json(OLD.`metadata`) OR
  NOT EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=OLD.`org_id` AND m.`user_id`=OLD.`target_id` AND m.`status`='active') OR
  NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`target_id` AND t.`status`='active' AND t.`retired_at` IS NULL);
 SELECT RAISE(ABORT,'interaction immutable fields changed') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id` IS NOT OLD.`work_item_id` OR NEW.`case_id` IS NOT OLD.`case_id` OR NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`kind`<>OLD.`kind` OR NEW.`subject`<>OLD.`subject` OR NEW.`prompt`<>OLD.`prompt` OR NEW.`creator_type`<>OLD.`creator_type` OR NEW.`creator_id`<>OLD.`creator_id` OR NEW.`creator_session_id` IS NOT OLD.`creator_session_id` OR NEW.`creator_external_session_key` IS NOT OLD.`creator_external_session_key` OR NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR NEW.`created_at`<>OLD.`created_at`;
END;
