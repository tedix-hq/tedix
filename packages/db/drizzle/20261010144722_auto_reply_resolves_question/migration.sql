-- A tedi's auto-delivered reply draft answers the user's question in the
-- tedi's name once the CLI has delivered it to the asking session, so the
-- question leaves the user's inbox; the asked user may still correct it later
-- with a non-resolving `answer` that names the auto reply (`metadata.corrects`)
-- and bumps the request version so each correction is fenced like an answer.
-- Trigger-only; no table changes.
DROP TRIGGER `work_interaction_response_insert_guard`;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_insert_guard` BEFORE INSERT ON `work_interaction_responses`
BEGIN
	SELECT RAISE(ABORT,'invalid interaction response state') WHERE NEW.`responder_type` NOT IN ('user','tedi','external_agent') OR NEW.`response_kind` NOT IN ('answer','input_provided','handoff_accepted','handoff_declined','coordination_update') OR NEW.`resolves_request` NOT IN (0,1) OR length(NEW.`resolution_fence`)=0;
	SELECT RAISE(ABORT,'interaction response lost resolution race') WHERE EXISTS(SELECT 1 FROM `work_interaction_responses` prior WHERE prior.`interaction_id`=NEW.`interaction_id` AND prior.`resolved_request_version`=NEW.`resolved_request_version`);
	SELECT RAISE(ABORT,'interaction response is stale or unauthorized') WHERE NOT EXISTS(
		SELECT 1 FROM `work_interactions` request WHERE request.`org_id`=NEW.`org_id` AND request.`id`=NEW.`interaction_id` AND request.`version`+1=NEW.`resolved_request_version` AND (
			(request.`status`='open' AND (request.`expires_at` IS NULL OR request.`expires_at`>NEW.`responded_at`) AND (request.`target_type` IS NULL OR (request.`target_type`=NEW.`responder_type` AND request.`target_id`=NEW.`responder_id`)))
			OR
			(request.`status`='open' AND (request.`expires_at` IS NULL OR request.`expires_at`>NEW.`responded_at`) AND request.`kind`='question' AND request.`target_type`='user' AND NEW.`responder_type`='tedi' AND NEW.`resolves_request`=1 AND json_extract(NEW.`metadata`,'$.draftOutcome')='auto' AND EXISTS(
				SELECT 1 FROM `work_interaction_reply_drafts` d WHERE d.`org_id`=NEW.`org_id` AND d.`interaction_id`=NEW.`interaction_id` AND d.`id`=json_extract(NEW.`metadata`,'$.draftId') AND d.`drafter_type`='tedi' AND d.`drafter_id`=NEW.`responder_id` AND d.`delivery`='auto'
			))
			OR
			(request.`status`='resolved' AND request.`kind`='question' AND request.`target_type`='user' AND NEW.`responder_type`='user' AND request.`target_id`=NEW.`responder_id` AND NEW.`resolves_request`=0 AND EXISTS(
				SELECT 1 FROM `work_interaction_responses` auto WHERE auto.`org_id`=request.`org_id` AND auto.`interaction_id`=request.`id` AND auto.`resolves_request`=1 AND auto.`responder_type`='tedi' AND json_extract(auto.`metadata`,'$.draftOutcome')='auto' AND auto.`id`=json_extract(NEW.`metadata`,'$.corrects')
			))
		)
	);
	SELECT RAISE(ABORT,'interaction response kind does not match request') WHERE NOT EXISTS(
		SELECT 1 FROM `work_interactions` request WHERE request.`org_id`=NEW.`org_id` AND request.`id`=NEW.`interaction_id` AND (
			(request.`kind`='question' AND NEW.`response_kind`='answer') OR (request.`kind`='input' AND NEW.`response_kind`='input_provided') OR
			(request.`kind`='handoff' AND NEW.`response_kind` IN ('handoff_accepted','handoff_declined')) OR (request.`kind`='coordination' AND NEW.`response_kind`='coordination_update')
		)
	);
	SELECT RAISE(ABORT,'invalid response actor') WHERE NOT (
		(NEW.`responder_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`responder_id` AND m.`status`='active')) OR
		(NEW.`responder_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`responder_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`responder_type`='external_agent' AND EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`responder_id` AND s.`id`=NEW.`responder_session_id` AND s.`external_session_key`=NEW.`responder_external_session_key` AND s.`status`='active' AND p.`status`='active'))
	);
END;
--> statement-breakpoint
DROP TRIGGER `work_interaction_response_apply`;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_apply` AFTER INSERT ON `work_interaction_responses`
BEGIN
	UPDATE `work_interactions` SET `status`='resolved', `resolved_at`=NEW.`responded_at`, `resolution_fence`=NEW.`resolution_fence`, `version`=NEW.`resolved_request_version`
	WHERE NEW.`resolves_request`=1 AND `org_id`=NEW.`org_id` AND `id`=NEW.`interaction_id` AND `status`='open' AND `version`+1=NEW.`resolved_request_version`;
	UPDATE `work_interactions` SET `status`='open', `resolved_at`=NULL, `resolution_fence`=NEW.`resolution_fence`, `version`=NEW.`resolved_request_version`
	WHERE NEW.`resolves_request`=0 AND `org_id`=NEW.`org_id` AND `id`=NEW.`interaction_id` AND `status`='open' AND `version`+1=NEW.`resolved_request_version`;
	UPDATE `work_interactions` SET `version`=NEW.`resolved_request_version`
	WHERE NEW.`resolves_request`=0 AND `org_id`=NEW.`org_id` AND `id`=NEW.`interaction_id` AND `status`='resolved' AND `version`+1=NEW.`resolved_request_version`;
END;
--> statement-breakpoint
DROP TRIGGER `work_interaction_update_guard`;
--> statement-breakpoint
CREATE TRIGGER `work_interaction_update_guard` BEFORE UPDATE ON `work_interactions`
WHEN NOT (NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`metadata` IS NOT OLD.`metadata`)
BEGIN
	SELECT RAISE(ABORT,'invalid interaction transition') WHERE OLD.`status`='open' AND (NEW.`status` NOT IN ('open','resolved','cancelled','expired') OR NEW.`version`<>OLD.`version`+1 OR NEW.`resolution_fence` IS NULL OR
		(NEW.`status`='open' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='resolved' AND (NEW.`resolved_at` IS NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='cancelled' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='expired' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NULL)));
	SELECT RAISE(ABORT,'invalid interaction transition') WHERE OLD.`status`<>'open' AND NOT (
		OLD.`status`='resolved' AND NEW.`status`='resolved' AND NEW.`version`=OLD.`version`+1 AND NEW.`resolution_fence` IS OLD.`resolution_fence` AND NEW.`resolved_at` IS OLD.`resolved_at` AND NEW.`cancelled_at` IS NULL AND NEW.`expired_at` IS NULL AND
		EXISTS(SELECT 1 FROM `work_interaction_responses` r WHERE r.`org_id`=NEW.`org_id` AND r.`interaction_id`=NEW.`id` AND r.`resolved_request_version`=NEW.`version` AND r.`resolves_request`=0 AND r.`responder_type`='user' AND json_extract(r.`metadata`,'$.corrects') IS NOT NULL)
	);
	SELECT RAISE(ABORT,'interaction immutable fields changed') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id` IS NOT OLD.`work_item_id` OR NEW.`case_id` IS NOT OLD.`case_id` OR NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`kind`<>OLD.`kind` OR NEW.`subject`<>OLD.`subject` OR NEW.`prompt`<>OLD.`prompt` OR NEW.`creator_type`<>OLD.`creator_type` OR NEW.`creator_id`<>OLD.`creator_id` OR NEW.`creator_session_id` IS NOT OLD.`creator_session_id` OR NEW.`creator_external_session_key` IS NOT OLD.`creator_external_session_key` OR NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR NEW.`created_at`<>OLD.`created_at` OR NEW.`metadata` IS NOT OLD.`metadata`;
	SELECT RAISE(ABORT,'interaction response receipt missing') WHERE OLD.`status`='open' AND NEW.`status` IN ('open','resolved') AND NOT EXISTS(SELECT 1 FROM `work_interaction_responses` r WHERE r.`org_id`=NEW.`org_id` AND r.`interaction_id`=NEW.`id` AND r.`resolved_request_version`=NEW.`version` AND r.`resolution_fence`=NEW.`resolution_fence` AND ((NEW.`status`='resolved' AND r.`resolves_request`=1) OR (NEW.`status`='open' AND r.`resolves_request`=0)));
END;
