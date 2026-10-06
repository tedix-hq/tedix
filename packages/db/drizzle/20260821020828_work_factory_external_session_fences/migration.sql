ALTER TABLE `work_approval_proposals` ADD `requester_external_session_key` text;--> statement-breakpoint
ALTER TABLE `work_interaction_responses` ADD `responder_external_session_key` text;--> statement-breakpoint
ALTER TABLE `work_interactions` ADD `creator_external_session_key` text;--> statement-breakpoint
ALTER TABLE `work_project_health_judgments` ADD `actor_external_session_key` text;--> statement-breakpoint

UPDATE `work_attempts`
SET `runtime_state`='expired', `outcome`='expired', `finished_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
	`version`=`version`+1
WHERE (`admission_id` IS NULL OR `expires_at` IS NULL) AND `runtime_state` IN ('queued','running','waiting','retrying');--> statement-breakpoint

CREATE TRIGGER `work_items_admission_revision_insert_guard`
BEFORE INSERT ON `work_items`
WHEN NEW.`admission_spec_revision` IS NULL OR NEW.`admission_spec_revision`='' OR NEW.`admission_spec_revision`='legacy'
BEGIN SELECT RAISE(ABORT,'work item requires fresh admission spec revision'); END;--> statement-breakpoint
CREATE TRIGGER `work_items_admission_revision_update_guard`
BEFORE UPDATE ON `work_items`
WHEN (
	NEW.`required_capabilities` IS NOT OLD.`required_capabilities` OR
	NEW.`required_authorities` IS NOT OLD.`required_authorities` OR
	NEW.`risk_level` IS NOT OLD.`risk_level` OR
	NEW.`project_id` IS NOT OLD.`project_id`
) AND (NEW.`admission_spec_revision`=OLD.`admission_spec_revision` OR NEW.`admission_spec_revision`='legacy' OR NEW.`version`<>OLD.`version`+1)
BEGIN SELECT RAISE(ABORT,'admission spec mutation requires fresh revision and version'); END;--> statement-breakpoint

CREATE TRIGGER `work_case_owner_insert_guard` BEFORE INSERT ON `work_cases`
BEGIN
	SELECT RAISE(ABORT,'invalid case initial state') WHERE NEW.`stage` NOT IN ('investigating','planning','executing','monitoring') OR NEW.`version`<>1 OR NEW.`closed_at` IS NOT NULL;
	SELECT RAISE(ABORT,'invalid case owner') WHERE NOT (
		(NEW.`accountable_owner_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`accountable_owner_id` AND m.`status`='active')) OR
		(NEW.`accountable_owner_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`accountable_owner_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`accountable_owner_type`='system' AND NEW.`accountable_owner_id`='tedix')
	);
	SELECT RAISE(ABORT,'cross-org case objective') WHERE NEW.`objective_id` IS NOT NULL AND NOT EXISTS(SELECT 1 FROM `tedi_objectives` o WHERE o.`org_id`=NEW.`org_id` AND o.`id`=NEW.`objective_id`);
END;--> statement-breakpoint
CREATE TRIGGER `work_case_owner_update_guard` BEFORE UPDATE ON `work_cases`
BEGIN
	SELECT RAISE(ABORT,'closed case is terminal') WHERE OLD.`stage`='closed';
	SELECT RAISE(ABORT,'invalid case transition') WHERE NEW.`stage` NOT IN ('investigating','planning','executing','monitoring','closed') OR NEW.`version`<>OLD.`version`+1 OR NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR (NEW.`stage`='closed')<>(NEW.`closed_at` IS NOT NULL);
	SELECT RAISE(ABORT,'invalid case owner') WHERE NOT (
		(NEW.`accountable_owner_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`accountable_owner_id` AND m.`status`='active')) OR
		(NEW.`accountable_owner_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`accountable_owner_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`accountable_owner_type`='system' AND NEW.`accountable_owner_id`='tedix')
	);
	SELECT RAISE(ABORT,'cross-org case objective') WHERE NEW.`objective_id` IS NOT NULL AND NOT EXISTS(SELECT 1 FROM `tedi_objectives` o WHERE o.`org_id`=NEW.`org_id` AND o.`id`=NEW.`objective_id`);
	SELECT RAISE(ABORT,'case has non-terminal work') WHERE NEW.`stage`='closed' AND EXISTS(
		SELECT 1 FROM `work_case_items` ci JOIN `work_items` wi ON wi.`org_id`=ci.`org_id` AND wi.`id`=ci.`work_item_id`
		WHERE ci.`org_id`=NEW.`org_id` AND ci.`case_id`=NEW.`id` AND wi.`disposition` NOT IN ('completed','cancelled')
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_case_item_open_guard` BEFORE INSERT ON `work_case_items`
BEGIN
	SELECT RAISE(ABORT,'closed case cannot accept work') WHERE EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=NEW.`org_id` AND c.`id`=NEW.`case_id` AND c.`stage`='closed');
END;--> statement-breakpoint
CREATE TRIGGER `work_case_item_terminal_delete_guard` BEFORE DELETE ON `work_case_items`
WHEN EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=OLD.`org_id` AND c.`id`=OLD.`case_id` AND c.`stage`='closed')
BEGIN SELECT RAISE(ABORT,'closed case work links are retained'); END;--> statement-breakpoint
CREATE TRIGGER `work_case_dependency_cycle_guard` BEFORE INSERT ON `work_case_dependencies`
BEGIN
	SELECT RAISE(ABORT,'closed case cannot accept dependencies') WHERE EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=NEW.`org_id` AND c.`id` IN (NEW.`prerequisite_case_id`,NEW.`dependent_case_id`) AND c.`stage`='closed');
	SELECT RAISE(ABORT,'case dependency cycle') WHERE EXISTS(
		WITH RECURSIVE reachable(id) AS (
			VALUES(NEW.`dependent_case_id`)
			UNION SELECT d.`dependent_case_id` FROM `work_case_dependencies` d JOIN reachable r ON d.`prerequisite_case_id`=r.id WHERE d.`org_id`=NEW.`org_id`
		) SELECT 1 FROM reachable WHERE id=NEW.`prerequisite_case_id`
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_case_dependency_terminal_delete_guard` BEFORE DELETE ON `work_case_dependencies`
WHEN EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=OLD.`org_id` AND c.`id` IN (OLD.`prerequisite_case_id`,OLD.`dependent_case_id`) AND c.`stage`='closed')
BEGIN SELECT RAISE(ABORT,'closed case dependencies are retained'); END;--> statement-breakpoint

CREATE TRIGGER `work_milestone_owner_insert_guard` BEFORE INSERT ON `work_milestones`
BEGIN
	SELECT RAISE(ABORT,'invalid milestone initial state') WHERE NEW.`status` NOT IN ('proposed','planned','active') OR NEW.`version`<>1 OR NEW.`done_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL;
	SELECT RAISE(ABORT,'invalid milestone owner') WHERE NOT (
		(NEW.`accountable_owner_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`accountable_owner_id` AND m.`status`='active')) OR
		(NEW.`accountable_owner_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`accountable_owner_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`accountable_owner_type`='system' AND NEW.`accountable_owner_id`='tedix')
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_milestone_update_guard` BEFORE UPDATE ON `work_milestones`
BEGIN
	SELECT RAISE(ABORT,'terminal milestone is immutable') WHERE OLD.`status` IN ('done','cancelled');
	SELECT RAISE(ABORT,'invalid milestone status') WHERE NEW.`status` NOT IN ('proposed','planned','active','done','cancelled');
	SELECT RAISE(ABORT,'invalid milestone transition') WHERE NEW.`version`<>OLD.`version`+1 OR NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`project_id`<>OLD.`project_id` OR
		(NEW.`status`='done' AND (NEW.`done_at` IS NULL OR NEW.`cancelled_at` IS NOT NULL)) OR
		(NEW.`status`='cancelled' AND (NEW.`cancelled_at` IS NULL OR NEW.`done_at` IS NOT NULL)) OR
		(NEW.`status` NOT IN ('done','cancelled') AND (NEW.`done_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL));
	SELECT RAISE(ABORT,'invalid milestone owner') WHERE NOT (
		(NEW.`accountable_owner_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`accountable_owner_id` AND m.`status`='active')) OR
		(NEW.`accountable_owner_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`accountable_owner_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`accountable_owner_type`='system' AND NEW.`accountable_owner_id`='tedix')
	);
	SELECT RAISE(ABORT,'done milestone requires proof') WHERE NEW.`status`='done' AND (NEW.`proof_ref` IS NULL OR length(NEW.`proof_ref`)=0);
	SELECT RAISE(ABORT,'done milestone requires work') WHERE NEW.`status`='done' AND NOT EXISTS(SELECT 1 FROM `work_milestone_items` mi WHERE mi.`org_id`=NEW.`org_id` AND mi.`milestone_id`=NEW.`id`);
	SELECT RAISE(ABORT,'milestone work is incomplete') WHERE NEW.`status`='done' AND EXISTS(
		SELECT 1 FROM `work_milestone_items` mi JOIN `work_items` wi ON wi.`org_id`=mi.`org_id` AND wi.`id`=mi.`work_item_id`
		WHERE mi.`org_id`=NEW.`org_id` AND mi.`milestone_id`=NEW.`id` AND wi.`disposition`<>'completed'
	);
	SELECT RAISE(ABORT,'milestone prerequisite is incomplete') WHERE NEW.`status`='done' AND EXISTS(
		SELECT 1 FROM `work_milestone_dependencies` md JOIN `work_milestones` prerequisite ON prerequisite.`org_id`=md.`org_id` AND prerequisite.`id`=md.`prerequisite_milestone_id`
		WHERE md.`org_id`=NEW.`org_id` AND md.`dependent_milestone_id`=NEW.`id` AND prerequisite.`status`<>'done'
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_milestone_item_open_guard` BEFORE INSERT ON `work_milestone_items`
BEGIN
	SELECT RAISE(ABORT,'terminal milestone cannot accept work') WHERE EXISTS(SELECT 1 FROM `work_milestones` m WHERE m.`org_id`=NEW.`org_id` AND m.`id`=NEW.`milestone_id` AND m.`status` IN ('done','cancelled'));
	SELECT RAISE(ABORT,'milestone work must share project') WHERE NOT EXISTS(
		SELECT 1 FROM `work_milestones` m JOIN `work_items` wi ON wi.`org_id`=m.`org_id` AND wi.`id`=NEW.`work_item_id`
		WHERE m.`org_id`=NEW.`org_id` AND m.`id`=NEW.`milestone_id` AND wi.`project_id`=m.`project_id`
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_milestone_item_terminal_delete_guard` BEFORE DELETE ON `work_milestone_items`
WHEN EXISTS(SELECT 1 FROM `work_milestones` m WHERE m.`org_id`=OLD.`org_id` AND m.`id`=OLD.`milestone_id` AND m.`status` IN ('done','cancelled'))
BEGIN SELECT RAISE(ABORT,'terminal milestone work links are retained'); END;--> statement-breakpoint
CREATE TRIGGER `work_milestone_dependency_cycle_guard` BEFORE INSERT ON `work_milestone_dependencies`
BEGIN
	SELECT RAISE(ABORT,'terminal milestone cannot accept dependencies') WHERE EXISTS(SELECT 1 FROM `work_milestones` m WHERE m.`org_id`=NEW.`org_id` AND m.`id` IN (NEW.`prerequisite_milestone_id`,NEW.`dependent_milestone_id`) AND m.`status` IN ('done','cancelled'));
	SELECT RAISE(ABORT,'milestone dependencies must share project') WHERE NOT EXISTS(
		SELECT 1 FROM `work_milestones` prerequisite JOIN `work_milestones` dependent ON dependent.`org_id`=prerequisite.`org_id`
		WHERE prerequisite.`org_id`=NEW.`org_id` AND prerequisite.`id`=NEW.`prerequisite_milestone_id` AND dependent.`id`=NEW.`dependent_milestone_id` AND prerequisite.`project_id`=dependent.`project_id`
	);
	SELECT RAISE(ABORT,'milestone dependency cycle') WHERE EXISTS(
		WITH RECURSIVE reachable(id) AS (
			VALUES(NEW.`dependent_milestone_id`)
			UNION SELECT d.`dependent_milestone_id` FROM `work_milestone_dependencies` d JOIN reachable r ON d.`prerequisite_milestone_id`=r.id WHERE d.`org_id`=NEW.`org_id`
		) SELECT 1 FROM reachable WHERE id=NEW.`prerequisite_milestone_id`
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_milestone_dependency_terminal_delete_guard` BEFORE DELETE ON `work_milestone_dependencies`
WHEN EXISTS(SELECT 1 FROM `work_milestones` m WHERE m.`org_id`=OLD.`org_id` AND m.`id` IN (OLD.`prerequisite_milestone_id`,OLD.`dependent_milestone_id`) AND m.`status` IN ('done','cancelled'))
BEGIN SELECT RAISE(ABORT,'terminal milestone dependencies are retained'); END;--> statement-breakpoint

CREATE TRIGGER `work_project_health_insert_guard` BEFORE INSERT ON `work_project_health_judgments`
BEGIN
	SELECT RAISE(ABORT,'invalid project health status') WHERE NEW.`status` NOT IN ('on_track','at_risk','off_track','paused');
	SELECT RAISE(ABORT,'invalid health actor') WHERE NOT (
		(NEW.`actor_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`actor_id` AND m.`status`='active')) OR
		(NEW.`actor_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`actor_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`actor_type`='external_agent' AND EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`actor_id` AND s.`id`=NEW.`actor_session_id` AND s.`external_session_key`=NEW.`actor_external_session_key` AND s.`status`='active' AND p.`status`='active')) OR
		(NEW.`actor_type`='system' AND NEW.`actor_id`='tedix')
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_project_health_immutable_update` BEFORE UPDATE ON `work_project_health_judgments` BEGIN SELECT RAISE(ABORT,'health judgments are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `work_project_health_immutable_delete` BEFORE DELETE ON `work_project_health_judgments` BEGIN SELECT RAISE(ABORT,'health judgments are immutable'); END;--> statement-breakpoint

CREATE TRIGGER `work_approval_proposal_insert_guard` BEFORE INSERT ON `work_approval_proposals`
BEGIN
	SELECT RAISE(ABORT,'invalid approval proposal state') WHERE NEW.`status`<>'pending' OR NEW.`version`<>1 OR NEW.`resolution_fence` IS NOT NULL OR NEW.`expires_at`<=NEW.`created_at`;
	SELECT RAISE(ABORT,'stale approval work item') WHERE NOT EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id` AND wi.`version`=NEW.`work_item_version`);
	SELECT RAISE(ABORT,'self approval is forbidden') WHERE NEW.`requester_type`=NEW.`approver_type` AND NEW.`requester_id`=NEW.`approver_id`;
	SELECT RAISE(ABORT,'invalid approval approver') WHERE NOT (
		(NEW.`approver_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`approver_id` AND m.`status`='active')) OR
		(NEW.`approver_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`approver_id` AND t.`retired_at` IS NULL))
	);
	SELECT RAISE(ABORT,'invalid approval requester') WHERE NOT (
		(NEW.`requester_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`requester_id` AND m.`status`='active')) OR
		(NEW.`requester_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`requester_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`requester_type`='external_agent' AND EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`requester_id` AND s.`id`=NEW.`requester_session_id` AND s.`external_session_key`=NEW.`requester_external_session_key` AND s.`status`='active' AND p.`status`='active')) OR
		(NEW.`requester_type`='system' AND NEW.`requester_id`='tedix')
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_approval_proposal_update_guard` BEFORE UPDATE ON `work_approval_proposals`
BEGIN
	SELECT RAISE(ABORT,'invalid approval resolution') WHERE OLD.`status`<>'pending' OR NEW.`version`<>OLD.`version`+1 OR NEW.`resolution_fence` IS NULL;
	SELECT RAISE(ABORT,'approval scope is immutable') WHERE NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`work_item_version`<>OLD.`work_item_version` OR NEW.`authority_key`<>OLD.`authority_key` OR NEW.`action`<>OLD.`action` OR NEW.`requester_type`<>OLD.`requester_type` OR NEW.`requester_id`<>OLD.`requester_id` OR NEW.`approver_type`<>OLD.`approver_type` OR NEW.`approver_id`<>OLD.`approver_id` OR NEW.`expires_at`<>OLD.`expires_at`;
	SELECT RAISE(ABORT,'invalid approval expiry') WHERE NEW.`status`='expired' AND (OLD.`expires_at`>NEW.`resolved_at` OR NEW.`resolved_at` IS NULL);
	SELECT RAISE(ABORT,'approval resolution requires decision receipt') WHERE NEW.`status`<>'expired' AND NOT EXISTS(SELECT 1 FROM `work_approval_decisions` d WHERE d.`proposal_id`=NEW.`id` AND d.`resolved_proposal_version`=NEW.`version` AND d.`decision`=NEW.`status`);
END;--> statement-breakpoint
CREATE TRIGGER `work_approval_proposal_delete_guard` BEFORE DELETE ON `work_approval_proposals` BEGIN SELECT RAISE(ABORT,'approval proposals are retained'); END;--> statement-breakpoint
CREATE TRIGGER `work_approval_decision_insert_guard` BEFORE INSERT ON `work_approval_decisions`
BEGIN
	SELECT RAISE(ABORT,'invalid approval decision') WHERE NEW.`decision` NOT IN ('approved','rejected');
	SELECT RAISE(ABORT,'approval decision lost resolution race') WHERE NOT EXISTS(
		SELECT 1 FROM `work_approval_proposals` p WHERE p.`id`=NEW.`proposal_id` AND p.`status`='pending' AND p.`resolution_fence` IS NULL AND p.`version`+1=NEW.`resolved_proposal_version` AND p.`expires_at`>NEW.`decided_at` AND p.`approver_type`=NEW.`decider_type` AND p.`approver_id`=NEW.`decider_id` AND NOT(p.`requester_type`=NEW.`decider_type` AND p.`requester_id`=NEW.`decider_id`)
	);
	SELECT RAISE(ABORT,'inactive approval decider') WHERE NOT EXISTS(
		SELECT 1 FROM `work_approval_proposals` p WHERE p.`id`=NEW.`proposal_id` AND (
			(NEW.`decider_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=p.`org_id` AND m.`user_id`=NEW.`decider_id` AND m.`status`='active')) OR
			(NEW.`decider_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=p.`org_id` AND t.`id`=NEW.`decider_id` AND t.`retired_at` IS NULL))
		)
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_approval_decision_apply` AFTER INSERT ON `work_approval_decisions`
BEGIN
	UPDATE `work_approval_proposals` SET `status`=NEW.`decision`, `resolution_fence`=lower(hex(randomblob(16))), `resolved_at`=NEW.`decided_at`, `version`=NEW.`resolved_proposal_version`
	WHERE `id`=NEW.`proposal_id` AND `status`='pending' AND `resolution_fence` IS NULL AND `version`+1=NEW.`resolved_proposal_version`;
END;--> statement-breakpoint
CREATE TRIGGER `work_approval_decision_immutable_update` BEFORE UPDATE ON `work_approval_decisions` BEGIN SELECT RAISE(ABORT,'approval decisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `work_approval_decision_immutable_delete` BEFORE DELETE ON `work_approval_decisions` BEGIN SELECT RAISE(ABORT,'approval decisions are immutable'); END;--> statement-breakpoint

CREATE TRIGGER `work_interaction_insert_guard` BEFORE INSERT ON `work_interactions`
BEGIN
	SELECT RAISE(ABORT,'invalid interaction initial state') WHERE NEW.`kind` NOT IN ('question','input','handoff','coordination') OR (NEW.`target_type` IS NULL)<>(NEW.`target_id` IS NULL) OR NEW.`status`<>'open' OR NEW.`version`<>1 OR NEW.`resolution_fence` IS NOT NULL OR NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL;
	SELECT RAISE(ABORT,'invalid interaction target') WHERE NEW.`target_type` IS NOT NULL AND NOT (
		(NEW.`target_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`target_id` AND m.`status`='active')) OR
		(NEW.`target_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`target_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`target_type`='external_agent' AND EXISTS(SELECT 1 FROM `external_agent_principals` p WHERE p.`organization_id`=NEW.`org_id` AND p.`id`=NEW.`target_id` AND p.`status`='active'))
	);
	SELECT RAISE(ABORT,'invalid interaction creator') WHERE NOT (
		(NEW.`creator_type`='user' AND EXISTS(SELECT 1 FROM `organization_members` m WHERE m.`organization_id`=NEW.`org_id` AND m.`user_id`=NEW.`creator_id` AND m.`status`='active')) OR
		(NEW.`creator_type`='tedi' AND EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`creator_id` AND t.`retired_at` IS NULL)) OR
		(NEW.`creator_type`='external_agent' AND EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`creator_id` AND s.`id`=NEW.`creator_session_id` AND s.`external_session_key`=NEW.`creator_external_session_key` AND s.`status`='active' AND p.`status`='active')) OR
		(NEW.`creator_type`='system' AND NEW.`creator_id`='tedix')
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_update_guard` BEFORE UPDATE ON `work_interactions`
BEGIN
	SELECT RAISE(ABORT,'invalid interaction transition') WHERE OLD.`status`<>'open' OR NEW.`status` NOT IN ('open','resolved','cancelled','expired') OR NEW.`version`<>OLD.`version`+1 OR NEW.`resolution_fence` IS NULL OR
		(NEW.`status`='open' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='resolved' AND (NEW.`resolved_at` IS NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='cancelled' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NULL OR NEW.`expired_at` IS NOT NULL)) OR
		(NEW.`status`='expired' AND (NEW.`resolved_at` IS NOT NULL OR NEW.`cancelled_at` IS NOT NULL OR NEW.`expired_at` IS NULL));
	SELECT RAISE(ABORT,'interaction immutable fields changed') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id` IS NOT OLD.`work_item_id` OR NEW.`case_id` IS NOT OLD.`case_id` OR NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`kind`<>OLD.`kind` OR NEW.`subject`<>OLD.`subject` OR NEW.`prompt`<>OLD.`prompt` OR NEW.`creator_type`<>OLD.`creator_type` OR NEW.`creator_id`<>OLD.`creator_id` OR NEW.`creator_session_id` IS NOT OLD.`creator_session_id` OR NEW.`creator_external_session_key` IS NOT OLD.`creator_external_session_key` OR NEW.`target_type` IS NOT OLD.`target_type` OR NEW.`target_id` IS NOT OLD.`target_id` OR NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR NEW.`created_at`<>OLD.`created_at` OR NEW.`metadata` IS NOT OLD.`metadata`;
	SELECT RAISE(ABORT,'interaction response receipt missing') WHERE NEW.`status` IN ('open','resolved') AND NOT EXISTS(SELECT 1 FROM `work_interaction_responses` r WHERE r.`org_id`=NEW.`org_id` AND r.`interaction_id`=NEW.`id` AND r.`resolved_request_version`=NEW.`version` AND r.`resolution_fence`=NEW.`resolution_fence` AND ((NEW.`status`='resolved' AND r.`resolves_request`=1) OR (NEW.`status`='open' AND r.`resolves_request`=0)));
END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_delete_guard` BEFORE DELETE ON `work_interactions` BEGIN SELECT RAISE(ABORT,'interactions are retained'); END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_insert_guard` BEFORE INSERT ON `work_interaction_responses`
BEGIN
	SELECT RAISE(ABORT,'invalid interaction response state') WHERE NEW.`responder_type` NOT IN ('user','tedi','external_agent') OR NEW.`response_kind` NOT IN ('answer','input_provided','handoff_accepted','handoff_declined','coordination_update') OR NEW.`resolves_request` NOT IN (0,1) OR length(NEW.`resolution_fence`)=0;
	SELECT RAISE(ABORT,'interaction response lost resolution race') WHERE EXISTS(SELECT 1 FROM `work_interaction_responses` prior WHERE prior.`interaction_id`=NEW.`interaction_id` AND prior.`resolved_request_version`=NEW.`resolved_request_version`);
	SELECT RAISE(ABORT,'interaction response is stale or unauthorized') WHERE NOT EXISTS(
		SELECT 1 FROM `work_interactions` request WHERE request.`org_id`=NEW.`org_id` AND request.`id`=NEW.`interaction_id` AND request.`status`='open' AND request.`version`+1=NEW.`resolved_request_version` AND (request.`expires_at` IS NULL OR request.`expires_at`>NEW.`responded_at`) AND (request.`target_type` IS NULL OR (request.`target_type`=NEW.`responder_type` AND request.`target_id`=NEW.`responder_id`))
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
END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_apply` AFTER INSERT ON `work_interaction_responses`
BEGIN
	UPDATE `work_interactions` SET `status`='resolved', `resolved_at`=NEW.`responded_at`, `resolution_fence`=NEW.`resolution_fence`, `version`=NEW.`resolved_request_version`
	WHERE NEW.`resolves_request`=1 AND `org_id`=NEW.`org_id` AND `id`=NEW.`interaction_id` AND `status`='open' AND `version`+1=NEW.`resolved_request_version`;
	UPDATE `work_interactions` SET `status`='open', `resolved_at`=NULL, `resolution_fence`=NEW.`resolution_fence`, `version`=NEW.`resolved_request_version`
	WHERE NEW.`resolves_request`=0 AND `org_id`=NEW.`org_id` AND `id`=NEW.`interaction_id` AND `status`='open' AND `version`+1=NEW.`resolved_request_version`;
END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_immutable_update` BEFORE UPDATE ON `work_interaction_responses` BEGIN SELECT RAISE(ABORT,'interaction responses are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `work_interaction_response_immutable_delete` BEFORE DELETE ON `work_interaction_responses` BEGIN SELECT RAISE(ABORT,'interaction responses are immutable'); END;--> statement-breakpoint

CREATE TRIGGER `work_resource_pool_insert_guard` BEFORE INSERT ON `work_resource_pools`
BEGIN
	SELECT RAISE(ABORT,'invalid resource pool initial state') WHERE NEW.`allocation_mode` NOT IN ('exclusive','capacity') OR NEW.`version`<>1 OR NEW.`capacity`<=0 OR (NEW.`allocation_mode`='exclusive' AND NEW.`capacity`<>1);
END;--> statement-breakpoint
CREATE TRIGGER `work_resource_pool_update_guard` BEFORE UPDATE ON `work_resource_pools`
BEGIN
	SELECT RAISE(ABORT,'resource pool scope/version is immutable') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`resource_key`<>OLD.`resource_key` OR NEW.`version`<>OLD.`version`+1;
	SELECT RAISE(ABORT,'invalid resource allocation mode') WHERE NEW.`allocation_mode` NOT IN ('exclusive','capacity');
	SELECT RAISE(ABORT,'exclusive resource capacity must equal one') WHERE NEW.`allocation_mode`='exclusive' AND NEW.`capacity`<>1;
	SELECT RAISE(ABORT,'resource capacity below active reservations') WHERE NEW.`capacity` < (SELECT COALESCE(SUM(r.`quantity`),0) FROM `work_resource_reservations` r WHERE r.`org_id`=OLD.`org_id` AND r.`pool_id`=OLD.`id` AND r.`state`='active' AND julianday(r.`expires_at`)>julianday('now'));
END;--> statement-breakpoint

CREATE TRIGGER `work_budget_envelope_scope_insert_guard` BEFORE INSERT ON `work_budget_envelopes`
BEGIN
	SELECT RAISE(ABORT,'invalid budget envelope initial state') WHERE NEW.`version`<>1 OR NEW.`currency`<>'USD';
	SELECT RAISE(ABORT,'invalid budget scope') WHERE NOT (
		(NEW.`scope_type`='organization' AND NEW.`scope_id`=NEW.`org_id`) OR
		(NEW.`scope_type`='project' AND EXISTS(SELECT 1 FROM `projects` p WHERE p.`org_id`=NEW.`org_id` AND p.`id`=NEW.`scope_id`)) OR
		(NEW.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_cases` c WHERE c.`org_id`=NEW.`org_id` AND c.`id`=NEW.`scope_id`)) OR
		(NEW.`scope_type`='work_item' AND EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`scope_id`))
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_budget_envelope_update_guard` BEFORE UPDATE ON `work_budget_envelopes`
BEGIN
	SELECT RAISE(ABORT,'budget envelope scope/version is immutable') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`scope_type`<>OLD.`scope_type` OR NEW.`scope_id`<>OLD.`scope_id` OR NEW.`currency`<>OLD.`currency` OR NEW.`version`<>OLD.`version`+1;
	SELECT RAISE(ABORT,'budget below commitments') WHERE NEW.`limit_micros` < (
		SELECT COALESCE(SUM(COALESCE(r.`consumed_micros`,r.`amount_micros`)),0) FROM `work_budget_reservations` r WHERE r.`org_id`=OLD.`org_id` AND r.`envelope_id`=OLD.`id` AND r.`state`='consumed'
	) + (
		SELECT COALESCE(SUM(r.`amount_micros`),0) FROM `work_budget_reservations` r WHERE r.`org_id`=OLD.`org_id` AND r.`envelope_id`=OLD.`id` AND r.`state`='active' AND julianday(r.`expires_at`)>julianday('now')
	);
END;--> statement-breakpoint

CREATE TRIGGER `work_admission_scope_insert_guard` BEFORE INSERT ON `work_admissions`
BEGIN
	SELECT RAISE(ABORT,'invalid admission receipt state') WHERE NEW.`decision` NOT IN ('admitted','rejected') OR NEW.`executor_type` NOT IN ('tedi','external_agent');
	SELECT RAISE(ABORT,'admission receipt is not current') WHERE NOT EXISTS(SELECT 1 FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id` AND wi.`version`=NEW.`work_item_version` AND wi.`admission_spec_revision`=NEW.`admission_spec_revision`);
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'invalid rejection receipt') WHERE NEW.`decision`='rejected' AND (NEW.`rejection_key` IS NULL OR NEW.`rejection_code` IS NULL OR NEW.`rejection_reason` IS NULL OR NEW.`expires_at`<=NEW.`decided_at`);
	SELECT RAISE(ABORT,'admitted receipt cannot carry rejection') WHERE NEW.`decision`='admitted' AND (NEW.`rejection_key` IS NOT NULL OR NEW.`rejection_code` IS NOT NULL OR NEW.`rejection_reason` IS NOT NULL);
END;--> statement-breakpoint
CREATE TRIGGER `work_admission_insert_guard` BEFORE INSERT ON `work_admissions`
WHEN NEW.`decision`='admitted'
BEGIN
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
	SELECT RAISE(ABORT,'admission approval missing') WHERE EXISTS(
		SELECT 1 FROM (
			SELECT value AS authority FROM json_each((SELECT wi.`required_authorities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`))
			UNION ALL SELECT 'risk:high' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='high'
			UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='critical'
		) required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version`=NEW.`work_item_version` AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`decided_at`)
	);
END;--> statement-breakpoint
CREATE TRIGGER `work_admission_immutable_update` BEFORE UPDATE ON `work_admissions` BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `work_admission_immutable_delete` BEFORE DELETE ON `work_admissions` BEGIN SELECT RAISE(ABORT,'admissions are immutable'); END;--> statement-breakpoint

CREATE TRIGGER `work_resource_reservation_insert_guard` BEFORE INSERT ON `work_resource_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid resource reservation initial state') WHERE NEW.`state`<>'active' OR NEW.`version`<>1 OR NEW.`settled_at` IS NOT NULL;
	SELECT RAISE(ABORT,'resource reservation does not match admission requirement') WHERE NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_resource_requirements` req ON req.`org_id`=a.`org_id` AND req.`work_item_id`=a.`work_item_id` AND req.`resource_key`=NEW.`resource_key` JOIN `work_resource_pools` pool ON pool.`org_id`=req.`org_id` AND pool.`resource_key`=req.`resource_key`
		WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`id`=NEW.`admission_id` AND a.`decision`='admitted' AND a.`expires_at`>NEW.`reserved_at` AND pool.`id`=NEW.`pool_id` AND pool.`version`=NEW.`pool_version` AND pool.`enabled`=1 AND req.`quantity`=NEW.`quantity`
	);
	SELECT RAISE(ABORT,'resource capacity exhausted') WHERE NEW.`quantity`+(SELECT COALESCE(SUM(r.`quantity`),0) FROM `work_resource_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`pool_id`=NEW.`pool_id` AND r.`state`='active' AND r.`expires_at`>NEW.`reserved_at`) > (SELECT pool.`capacity` FROM `work_resource_pools` pool WHERE pool.`org_id`=NEW.`org_id` AND pool.`id`=NEW.`pool_id`);
END;--> statement-breakpoint
CREATE TRIGGER `work_resource_reservation_update_guard` BEFORE UPDATE ON `work_resource_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid resource reservation transition') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`admission_id`<>OLD.`admission_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`pool_id`<>OLD.`pool_id` OR NEW.`pool_version`<>OLD.`pool_version` OR NEW.`resource_key`<>OLD.`resource_key` OR NEW.`quantity`<>OLD.`quantity` OR NEW.`version`<>OLD.`version`+1 OR OLD.`state`<>'active' OR NEW.`state` NOT IN ('active','released','consumed','expired');
	SELECT RAISE(ABORT,'resource heartbeat lacks active attempt') WHERE NEW.`state`='active' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('queued','running','waiting','retrying') AND a.`expires_at`=NEW.`expires_at`);
	SELECT RAISE(ABORT,'resource release lacks settlement or losing start') WHERE NEW.`state`='released' AND NOT (EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`admission_id`=NEW.`admission_id`));
	SELECT RAISE(ABORT,'resource consume lacks settlement') WHERE NEW.`state`='consumed' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired'));
	SELECT RAISE(ABORT,'resource expiry lacks timeout') WHERE NEW.`state`='expired' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state`='expired');
END;--> statement-breakpoint
CREATE TRIGGER `work_resource_reservation_delete_guard` BEFORE DELETE ON `work_resource_reservations` BEGIN SELECT RAISE(ABORT,'resource reservations are retained'); END;--> statement-breakpoint

CREATE TRIGGER `work_budget_reservation_insert_guard` BEFORE INSERT ON `work_budget_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid budget reservation initial state') WHERE NEW.`state`<>'active' OR NEW.`version`<>1 OR NEW.`settled_at` IS NOT NULL OR NEW.`consumed_micros` IS NOT NULL;
	SELECT RAISE(ABORT,'budget reservation does not match admission envelope') WHERE NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_items` wi ON wi.`org_id`=a.`org_id` AND wi.`id`=a.`work_item_id` JOIN `work_budget_envelopes` envelope ON envelope.`org_id`=a.`org_id` AND envelope.`id`=NEW.`envelope_id`
		WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`id`=NEW.`admission_id` AND a.`decision`='admitted' AND a.`expires_at`>NEW.`reserved_at` AND envelope.`version`=NEW.`envelope_version` AND envelope.`enabled`=1 AND envelope.`reservation_micros`=NEW.`amount_micros` AND (
			envelope.`scope_type`='organization' AND envelope.`scope_id`=a.`org_id` OR envelope.`scope_type`='work_item' AND envelope.`scope_id`=a.`work_item_id` OR envelope.`scope_type`='project' AND envelope.`scope_id`=wi.`project_id` OR envelope.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_case_items` ci WHERE ci.`org_id`=a.`org_id` AND ci.`work_item_id`=a.`work_item_id` AND ci.`case_id`=envelope.`scope_id`)
		)
	);
	SELECT RAISE(ABORT,'budget exhausted') WHERE NEW.`amount_micros`+
		(SELECT COALESCE(SUM(COALESCE(r.`consumed_micros`,r.`amount_micros`)),0) FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`envelope_id`=NEW.`envelope_id` AND r.`state`='consumed')+
		(SELECT COALESCE(SUM(r.`amount_micros`),0) FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`envelope_id`=NEW.`envelope_id` AND r.`state`='active' AND r.`expires_at`>NEW.`reserved_at`)
		> (SELECT envelope.`limit_micros` FROM `work_budget_envelopes` envelope WHERE envelope.`org_id`=NEW.`org_id` AND envelope.`id`=NEW.`envelope_id`);
END;--> statement-breakpoint
CREATE TRIGGER `work_budget_reservation_update_guard` BEFORE UPDATE ON `work_budget_reservations`
BEGIN
	SELECT RAISE(ABORT,'invalid budget reservation transition') WHERE NEW.`id`<>OLD.`id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`admission_id`<>OLD.`admission_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`envelope_id`<>OLD.`envelope_id` OR NEW.`envelope_version`<>OLD.`envelope_version` OR NEW.`amount_micros`<>OLD.`amount_micros` OR NEW.`version`<>OLD.`version`+1 OR OLD.`state`<>'active' OR NEW.`state` NOT IN ('active','released','consumed','expired');
	SELECT RAISE(ABORT,'invalid consumed budget amount') WHERE NEW.`state`='consumed' AND (NEW.`consumed_micros` IS NULL OR NEW.`consumed_micros`<0 OR NEW.`consumed_micros`>NEW.`amount_micros`);
	SELECT RAISE(ABORT,'budget heartbeat lacks active attempt') WHERE NEW.`state`='active' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('queued','running','waiting','retrying') AND a.`expires_at`=NEW.`expires_at`);
	SELECT RAISE(ABORT,'budget release lacks settlement or losing start') WHERE NEW.`state`='released' AND NOT (EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`admission_id`=NEW.`admission_id`));
	SELECT RAISE(ABORT,'budget consume lacks settlement') WHERE NEW.`state`='consumed' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state` IN ('finished','failed','cancelled','expired'));
	SELECT RAISE(ABORT,'budget expiry lacks timeout') WHERE NEW.`state`='expired' AND NOT EXISTS(SELECT 1 FROM `work_attempts` a WHERE a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`admission_id`=NEW.`admission_id` AND a.`runtime_state`='expired');
END;--> statement-breakpoint
CREATE TRIGGER `work_budget_reservation_delete_guard` BEFORE DELETE ON `work_budget_reservations` BEGIN SELECT RAISE(ABORT,'budget reservations are retained'); END;--> statement-breakpoint

CREATE TRIGGER `work_attempt_admission_insert_guard` BEFORE INSERT ON `work_attempts`
BEGIN
	SELECT RAISE(ABORT,'attempt does not match active admission') WHERE NEW.`admission_id` IS NULL OR NOT EXISTS(
		SELECT 1 FROM `work_admissions` a JOIN `work_items` wi ON wi.`org_id`=a.`org_id` AND wi.`id`=a.`work_item_id`
		WHERE a.`id`=NEW.`admission_id` AND a.`org_id`=NEW.`org_id` AND a.`work_item_id`=NEW.`work_item_id` AND a.`decision`='admitted' AND NEW.`expires_at` IS NOT NULL AND a.`expires_at`=NEW.`expires_at` AND a.`expires_at`>NEW.`started_at` AND a.`executor_type`=NEW.`executor_type` AND a.`executor_id`=NEW.`executor_id` AND a.`executor_session_id` IS NEW.`executor_session_id` AND a.`external_session_key` IS NEW.`external_session_key` AND wi.`version`=a.`work_item_version` AND wi.`admission_spec_revision`=a.`admission_spec_revision` AND wi.`disposition`='accepted'
	);
	SELECT RAISE(ABORT,'attempt dependency blocked') WHERE EXISTS(SELECT 1 FROM `work_item_relations` rel JOIN `work_items` prerequisite ON prerequisite.`org_id`=rel.`org_id` AND prerequisite.`id`=rel.`from_work_item_id` WHERE rel.`org_id`=NEW.`org_id` AND rel.`to_work_item_id`=NEW.`work_item_id` AND rel.`relation_type`='blocks' AND prerequisite.`disposition` NOT IN ('completed','cancelled'));
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
	SELECT RAISE(ABORT,'attempt capability revoked') WHERE EXISTS(SELECT 1 FROM json_each((SELECT wi.`required_capabilities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) required WHERE NOT EXISTS(SELECT 1 FROM `org_capabilities` c JOIN `capability_links` l ON l.`organization_id`=c.`organization_id` AND l.`capability_id`=c.`id` WHERE c.`organization_id`=NEW.`org_id` AND c.`status`='active' AND (c.`id`=required.`value` OR c.`slug`=required.`value`) AND l.`entity_kind`=NEW.`executor_type` AND l.`entity_id`=NEW.`executor_id`));
	SELECT RAISE(ABORT,'attempt approval expired or revoked') WHERE EXISTS(SELECT 1 FROM (SELECT value AS authority FROM json_each((SELECT wi.`required_authorities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) UNION ALL SELECT 'risk:high' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='high' UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='critical') required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version`=(SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`started_at`));
	SELECT RAISE(ABORT,'attempt resource reservation missing or pool revoked') WHERE EXISTS(SELECT 1 FROM `work_resource_requirements` req WHERE req.`org_id`=NEW.`org_id` AND req.`work_item_id`=NEW.`work_item_id` AND NOT EXISTS(SELECT 1 FROM `work_resource_reservations` r JOIN `work_resource_pools` pool ON pool.`org_id`=r.`org_id` AND pool.`id`=r.`pool_id` WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`resource_key`=req.`resource_key` AND r.`quantity`=req.`quantity` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at` AND pool.`resource_key`=req.`resource_key` AND pool.`version`=r.`pool_version` AND pool.`enabled`=1));
	SELECT RAISE(ABORT,'attempt budget reservation missing') WHERE EXISTS(SELECT 1 FROM `work_budget_envelopes` envelope JOIN `work_items` wi ON wi.`org_id`=envelope.`org_id` AND wi.`id`=NEW.`work_item_id` WHERE envelope.`org_id`=NEW.`org_id` AND envelope.`enabled`=1 AND (envelope.`scope_type`='organization' AND envelope.`scope_id`=NEW.`org_id` OR envelope.`scope_type`='work_item' AND envelope.`scope_id`=NEW.`work_item_id` OR envelope.`scope_type`='project' AND envelope.`scope_id`=wi.`project_id` OR envelope.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_case_items` ci WHERE ci.`org_id`=NEW.`org_id` AND ci.`work_item_id`=NEW.`work_item_id` AND ci.`case_id`=envelope.`scope_id`)) AND NOT EXISTS(SELECT 1 FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`envelope_id`=envelope.`id` AND r.`envelope_version`=envelope.`version` AND r.`amount_micros`=envelope.`reservation_micros` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at`));
END;--> statement-breakpoint
CREATE TRIGGER `work_attempt_admission_update_guard` BEFORE UPDATE ON `work_attempts`
BEGIN
	SELECT RAISE(ABORT,'attempt fence or terminal state is immutable') WHERE NEW.`admission_id` IS NOT OLD.`admission_id` OR NEW.`org_id`<>OLD.`org_id` OR NEW.`work_item_id`<>OLD.`work_item_id` OR NEW.`executor_type`<>OLD.`executor_type` OR NEW.`executor_id`<>OLD.`executor_id` OR NEW.`executor_session_id` IS NOT OLD.`executor_session_id` OR NEW.`external_session_key` IS NOT OLD.`external_session_key` OR NEW.`version`<>OLD.`version`+1 OR OLD.`runtime_state` NOT IN ('queued','running','waiting','retrying');
	SELECT RAISE(ABORT,'active attempt requires bounded expiry') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`expires_at` IS NULL;
	SELECT RAISE(ABORT,'inactive tedi executor') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='tedi' AND NOT EXISTS(SELECT 1 FROM `tedis` t WHERE t.`organization_id`=NEW.`org_id` AND t.`id`=NEW.`executor_id` AND t.`retired_at` IS NULL);
	SELECT RAISE(ABORT,'inactive external executor session') WHERE NEW.`runtime_state` IN ('queued','running','waiting','retrying') AND NEW.`executor_type`='external_agent' AND NOT EXISTS(SELECT 1 FROM `external_agent_sessions` s JOIN `external_agent_principals` p ON p.`organization_id`=s.`organization_id` AND p.`id`=s.`principal_id` WHERE s.`organization_id`=NEW.`org_id` AND s.`principal_id`=NEW.`executor_id` AND s.`id`=NEW.`executor_session_id` AND s.`external_session_key`=NEW.`external_session_key` AND s.`status`='active' AND p.`status`='active');
END;--> statement-breakpoint
