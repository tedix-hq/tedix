-- Recipient snooze may change only its wake time on an otherwise unchanged open card.
-- API authorization checks the addressed person; all existing delegation and revision guards remain.
-- Rollback: restore work_interaction_delegation_guard from the preceding migration.
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
 AND json_remove(NEW.metadata,'$.cardContent','$.cardRevision','$.proposal') IS json_remove(OLD.metadata,'$.cardContent','$.cardRevision','$.proposal')
 AND json_extract(NEW.metadata,'$.cardRevision')=coalesce(json_extract(OLD.metadata,'$.cardRevision'),1)+1
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id AND r.revision=json_extract(NEW.metadata,'$.cardRevision') AND r.body=json_extract(NEW.metadata,'$.cardContent') AND ((r.proposal IS NULL AND json_extract(NEW.metadata,'$.proposal') IS json_extract(OLD.metadata,'$.proposal')) OR (r.proposal IS NOT NULL AND json(r.proposal) IS json(json_extract(NEW.metadata,'$.proposal')))))) OR (NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
 AND OLD.creator_type='system' AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='open' AND NEW.version=OLD.version
 AND json_remove(NEW.metadata,'$.followThrough') IS json_remove(OLD.metadata,'$.followThrough')
 AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=OLD.org_id AND r.interaction_id=OLD.id AND r.resolved_request_version=OLD.version AND json_extract(r.metadata,'$.cardAction')='ask_changes')))
 AND NOT (NEW.id IS OLD.id
 AND NEW.org_id IS OLD.org_id
 AND NEW.work_item_id IS OLD.work_item_id
 AND NEW.case_id IS OLD.case_id
 AND NEW.project_id IS OLD.project_id
 AND NEW.kind IS OLD.kind
 AND NEW.subject IS OLD.subject
 AND NEW.prompt IS OLD.prompt
 AND NEW.creator_type IS OLD.creator_type
 AND NEW.creator_id IS OLD.creator_id
 AND NEW.creator_session_id IS OLD.creator_session_id
 AND NEW.creator_external_session_key IS OLD.creator_external_session_key
 AND NEW.target_type IS OLD.target_type
 AND NEW.target_id IS OLD.target_id
 AND NEW.due_at IS OLD.due_at
 AND NEW.expires_at IS OLD.expires_at
 AND NEW.created_at IS OLD.created_at
 AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='expired'
 AND NEW.version=OLD.version+1
 AND NEW.resolution_fence IS NOT NULL AND NEW.resolution_fence IS NOT OLD.resolution_fence
 AND NEW.resolved_at IS NULL AND NEW.cancelled_at IS NULL
 AND NEW.expired_at=json_extract(NEW.metadata,'$.supersession.at')
 AND julianday(NEW.expired_at)>=julianday(OLD.created_at)
 AND json_remove(NEW.metadata,'$.supersession') IS json_remove(OLD.metadata,'$.supersession')
 AND json_type(NEW.metadata,'$.supersession')='object'
 AND json_type(NEW.metadata,'$.supersession.at')='text'
 AND json_type(NEW.metadata,'$.supersession.supersededBy')='text'
 AND json_extract(NEW.metadata,'$.supersession.reason')='newer_support_draft'
 AND json_type(OLD.metadata,'$.supportTicketId')='text'
 AND json_type(OLD.metadata,'$.supportVersion')='integer'
 AND (json_extract(OLD.metadata,'$.source')='support-draft' OR (
  json_extract(OLD.metadata,'$.source')='night-source-adapter'
  AND json_extract(OLD.metadata,'$.originalSource')='support-work-draft'
  AND json_extract(OLD.metadata,'$.sourceKey')='support-draft:' || json_extract(OLD.metadata,'$.supportTicketId') || ':' || json_extract(OLD.metadata,'$.supportVersion')
  AND json_extract(OLD.metadata,'$.decisionDeck.classId')='support.reply'
  AND json_extract(OLD.metadata,'$.decisionDeck.kind')='outbound'))
 AND EXISTS (SELECT 1 FROM work_interactions newer WHERE
  newer.id=json_extract(NEW.metadata,'$.supersession.supersededBy')
  AND newer.org_id=OLD.org_id AND newer.target_type=OLD.target_type AND newer.target_id=OLD.target_id
  AND json_extract(newer.metadata,'$.source')='support-draft'
  AND json_extract(newer.metadata,'$.supportTicketId')=json_extract(OLD.metadata,'$.supportTicketId')
  AND json_type(newer.metadata,'$.supportVersion')='integer'
  AND json_extract(newer.metadata,'$.supportVersion')>json_extract(OLD.metadata,'$.supportVersion')))
 AND NOT (NEW.id IS OLD.id
 AND NEW.org_id IS OLD.org_id
 AND NEW.work_item_id IS OLD.work_item_id
 AND NEW.case_id IS OLD.case_id
 AND NEW.project_id IS OLD.project_id
 AND NEW.kind IS OLD.kind
 AND NEW.status IS OLD.status
 AND NEW.subject IS OLD.subject
 AND NEW.prompt IS OLD.prompt
 AND NEW.creator_type IS OLD.creator_type
 AND NEW.creator_id IS OLD.creator_id
 AND NEW.creator_session_id IS OLD.creator_session_id
 AND NEW.creator_external_session_key IS OLD.creator_external_session_key
 AND NEW.target_type IS OLD.target_type
 AND NEW.target_id IS OLD.target_id
 AND NEW.due_at IS OLD.due_at
 AND NEW.expires_at IS OLD.expires_at
 AND NEW.resolution_fence IS OLD.resolution_fence
 AND NEW.created_at IS OLD.created_at
 AND NEW.resolved_at IS OLD.resolved_at
 AND NEW.cancelled_at IS OLD.cancelled_at
 AND NEW.expired_at IS OLD.expired_at
 AND NEW.version IS OLD.version
 AND OLD.target_type='user' AND OLD.status='open'
 AND json_remove(NEW.metadata,'$.followThrough') IS json_remove(OLD.metadata,'$.followThrough')
 AND json_remove(coalesce(json_extract(NEW.metadata,'$.followThrough'),'{}'),'$.snoozedUntil') IS json_remove(coalesce(json_extract(OLD.metadata,'$.followThrough'),'{}'),'$.snoozedUntil')
 AND json_type(NEW.metadata,'$.followThrough.snoozedUntil')='text'
 AND julianday(json_extract(NEW.metadata,'$.followThrough.snoozedUntil')) IS NOT NULL)
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
