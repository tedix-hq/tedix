-- Retains the existing delegation guard. The only new source projection is
-- a same-recipient, open-card version step backed by its immutable ledger row.
-- Feedback bookkeeping on system cards requires a durable change response.
-- No content is deleted. Rollback restores the prior delegation trigger and
-- drops card_revision_projection_guard; immutable revisions remain retained.
DROP TRIGGER work_interaction_delegation_guard;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_delegation_guard` BEFORE UPDATE ON `work_interactions`
WHEN (NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`metadata` IS NOT OLD.`metadata`
) AND NOT (NEW.`target_type` IS OLD.`target_type` AND NEW.`target_id` IS OLD.`target_id`
 AND NEW.`metadata` IS NOT OLD.`metadata`
 AND OLD.`target_type`='user' AND OLD.`creator_type` IN ('tedi','external_agent')
 AND json_remove(NEW.`metadata`,'$.notification','$.followThrough') IS json_remove(OLD.`metadata`,'$.notification','$.followThrough') OR (NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
 AND OLD.status='open' AND NEW.status='open' AND OLD.target_type='user'
 AND NEW.version=OLD.version+1
 AND json_remove(NEW.metadata,'$.cardContent','$.cardRevision') IS json_remove(OLD.metadata,'$.cardContent','$.cardRevision')
 AND json_extract(NEW.metadata,'$.cardRevision')=coalesce(json_extract(OLD.metadata,'$.cardRevision'),1)+1
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id AND r.revision=json_extract(NEW.metadata,'$.cardRevision') AND r.body=json_extract(NEW.metadata,'$.cardContent'))) OR (NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
 AND OLD.creator_type='system' AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='open' AND NEW.version=OLD.version
 AND json_remove(NEW.metadata,'$.followThrough') IS json_remove(OLD.metadata,'$.followThrough')
 AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=OLD.org_id AND r.interaction_id=OLD.id AND r.resolved_request_version=OLD.version AND json_extract(r.metadata,'$.cardAction')='ask_changes')))
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
--> statement-breakpoint
CREATE TRIGGER card_revision_projection_guard BEFORE UPDATE ON work_interactions
WHEN (NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
 AND OLD.status='open' AND NEW.status='open' AND OLD.target_type='user'
 AND NEW.version=OLD.version+1
 AND json_remove(NEW.metadata,'$.cardContent','$.cardRevision') IS json_remove(OLD.metadata,'$.cardContent','$.cardRevision')
 AND json_extract(NEW.metadata,'$.cardRevision')=coalesce(json_extract(OLD.metadata,'$.cardRevision'),1)+1
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id AND r.revision=json_extract(NEW.metadata,'$.cardRevision') AND r.body=json_extract(NEW.metadata,'$.cardContent'))) OR (NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
 AND OLD.creator_type='system' AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='open' AND NEW.version=OLD.version
 AND json_remove(NEW.metadata,'$.followThrough') IS json_remove(OLD.metadata,'$.followThrough')
 AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=OLD.org_id AND r.interaction_id=OLD.id AND r.resolved_request_version=OLD.version AND json_extract(r.metadata,'$.cardAction')='ask_changes'))
BEGIN
 SELECT RAISE(ABORT,'interaction immutable fields changed') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id` IS NOT OLD.`work_item_id` OR NEW.`case_id` IS NOT OLD.`case_id` OR NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`kind`<>OLD.`kind` OR NEW.`subject`<>OLD.`subject` OR NEW.`prompt`<>OLD.`prompt` OR NEW.`creator_type`<>OLD.`creator_type` OR NEW.`creator_id`<>OLD.`creator_id` OR NEW.`creator_session_id` IS NOT OLD.`creator_session_id` OR NEW.`creator_external_session_key` IS NOT OLD.`creator_external_session_key` OR NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR NEW.`created_at`<>OLD.`created_at`;
 SELECT RAISE(ABORT,'card revision changed resolution state') WHERE NEW.resolution_fence IS NOT OLD.resolution_fence OR NEW.resolved_at IS NOT OLD.resolved_at OR NEW.cancelled_at IS NOT OLD.cancelled_at OR NEW.expired_at IS NOT OLD.expired_at;
END;
