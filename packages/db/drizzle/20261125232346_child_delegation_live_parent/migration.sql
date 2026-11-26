-- Child delegation grants descend only to a live parent run, never cover
-- critical risk or explicit authorities, and allow a narrower child.
-- Same guards as 20261121184852_work_child_delegation and
-- 20261123165022_credit_budgets_need_no_attempt_reservation with:
--   * parent_attempt.runtime_state='running' and unexpired at admission time
--   * child risk/capabilities/authorities may be a subset of the parent's
--   * inherited authority satisfies only non-critical risk:* requirements
-- Rollback: recreate both triggers from those migrations.
DROP TRIGGER `work_admission_insert_guard`;
--> statement-breakpoint
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
		) required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version` BETWEEN COALESCE((SELECT json_extract(e.`payload`, '$.planningApproval.fromVersion') FROM `work_events` e WHERE e.`org_id`=NEW.`org_id` AND e.`work_item_id`=NEW.`work_item_id` AND e.`event_type`='work.specification_updated' AND json_extract(e.`payload`, '$.planningApproval.toVersion')=NEW.`work_item_version` AND json_extract(e.`payload`, '$.planningApproval.admissionSpecRevision')=NEW.`admission_spec_revision` ORDER BY e.`sequence` DESC LIMIT 1), NEW.`work_item_version`) AND NEW.`work_item_version` AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`decided_at`)
		AND NOT (substr(required.authority,1,5)='risk:' AND required.authority<>'risk:critical' AND EXISTS (SELECT 1 FROM work_items child
 JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
 JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=json_extract(child.metadata,'$.childDelegation.parentAttemptId')
 JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
 JOIN organizations org ON org.id=child.org_id
 WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
 AND parent_attempt.runtime_state='running' AND parent_attempt.expires_at>NEW.decided_at
 AND json_extract(child.metadata,'$.childDelegation.parentRevision')=parent.admission_spec_revision
 AND json_extract(child.metadata,'$.childDelegation.approvalMode')='auto'
 AND COALESCE(json_extract(org.metadata,'$.workDelegation.approvalMode'),'auto')='auto'
 AND (child.risk_level=parent.risk_level OR child.risk_level='low' OR (child.risk_level='medium' AND parent.risk_level IN ('high','critical')) OR (child.risk_level='high' AND parent.risk_level='critical'))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_capabilities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_authorities)))
))
	);
END;
--> statement-breakpoint
DROP TRIGGER `work_attempt_admission_insert_guard`;
--> statement-breakpoint
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
	SELECT RAISE(ABORT,'attempt approval expired or revoked') WHERE EXISTS(
		SELECT 1 FROM (
			SELECT value AS authority FROM json_each((SELECT wi.`required_authorities` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`))
			UNION ALL SELECT 'risk:high' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='high'
			UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.`risk_level` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)='critical'
		) required WHERE NOT EXISTS(SELECT 1 FROM `work_approval_proposals` p JOIN `work_approval_decisions` d ON d.`proposal_id`=p.`id` AND d.`decision`='approved' AND d.`resolved_proposal_version`=p.`version` WHERE p.`org_id`=NEW.`org_id` AND p.`work_item_id`=NEW.`work_item_id` AND p.`work_item_version` BETWEEN COALESCE((SELECT json_extract(e.`payload`, '$.planningApproval.fromVersion') FROM `work_events` e WHERE e.`org_id`=NEW.`org_id` AND e.`work_item_id`=NEW.`work_item_id` AND e.`event_type`='work.specification_updated' AND json_extract(e.`payload`, '$.planningApproval.toVersion')=(SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) AND json_extract(e.`payload`, '$.planningApproval.admissionSpecRevision')=(SELECT wi.`admission_spec_revision` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) ORDER BY e.`sequence` DESC LIMIT 1), (SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`)) AND (SELECT wi.`version` FROM `work_items` wi WHERE wi.`org_id`=NEW.`org_id` AND wi.`id`=NEW.`work_item_id`) AND p.`action`='admission' AND p.`authority_key`=required.authority AND p.`status`='approved' AND p.`expires_at`>NEW.`started_at`)
		AND NOT (substr(required.authority,1,5)='risk:' AND required.authority<>'risk:critical' AND EXISTS (SELECT 1 FROM work_items child
 JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
 JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=json_extract(child.metadata,'$.childDelegation.parentAttemptId')
 JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
 JOIN organizations org ON org.id=child.org_id
 WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
 AND parent_attempt.runtime_state='running' AND parent_attempt.expires_at>NEW.started_at
 AND json_extract(child.metadata,'$.childDelegation.parentRevision')=parent.admission_spec_revision
 AND json_extract(child.metadata,'$.childDelegation.approvalMode')='auto'
 AND COALESCE(json_extract(org.metadata,'$.workDelegation.approvalMode'),'auto')='auto'
 AND (child.risk_level=parent.risk_level OR child.risk_level='low' OR (child.risk_level='medium' AND parent.risk_level IN ('high','critical')) OR (child.risk_level='high' AND parent.risk_level='critical'))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_capabilities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_capabilities)))
 AND NOT EXISTS (SELECT 1 FROM json_each(child.required_authorities) c WHERE c.value NOT IN (SELECT value FROM json_each(parent.required_authorities)))
))
	);
	SELECT RAISE(ABORT,'attempt resource reservation missing or pool revoked') WHERE EXISTS(SELECT 1 FROM `work_resource_requirements` req WHERE req.`org_id`=NEW.`org_id` AND req.`work_item_id`=NEW.`work_item_id` AND NOT EXISTS(SELECT 1 FROM `work_resource_reservations` r JOIN `work_resource_pools` pool ON pool.`org_id`=r.`org_id` AND pool.`id`=r.`pool_id` WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`resource_key`=req.`resource_key` AND r.`quantity`=req.`quantity` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at` AND pool.`resource_key`=req.`resource_key` AND pool.`version`=r.`pool_version` AND pool.`enabled`=1));
	SELECT RAISE(ABORT,'attempt budget reservation missing') WHERE EXISTS(SELECT 1 FROM `work_budget_envelopes` envelope JOIN `work_items` wi ON wi.`org_id`=envelope.`org_id` AND wi.`id`=NEW.`work_item_id` WHERE envelope.`org_id`=NEW.`org_id` AND envelope.`enabled`=1 AND envelope.`currency`<>'credits' AND (envelope.`scope_type`='organization' AND envelope.`scope_id`=NEW.`org_id` OR envelope.`scope_type`='work_item' AND envelope.`scope_id` IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
 SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
 UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
 WHERE parent.org_id=NEW.org_id AND json_type(child.metadata,'$.childDelegation.parentAttemptId')='text'
 ) SELECT id FROM ancestors) OR envelope.`scope_type`='project' AND envelope.`scope_id`=wi.`project_id` OR envelope.`scope_type`='case' AND EXISTS(SELECT 1 FROM `work_case_items` ci WHERE ci.`org_id`=NEW.`org_id` AND ci.`work_item_id`=NEW.`work_item_id` AND ci.`case_id`=envelope.`scope_id`)) AND NOT EXISTS(SELECT 1 FROM `work_budget_reservations` r WHERE r.`org_id`=NEW.`org_id` AND r.`work_item_id`=NEW.`work_item_id` AND r.`admission_id`=NEW.`admission_id` AND r.`envelope_id`=envelope.`id` AND r.`envelope_version`=envelope.`version` AND r.`amount_micros`=envelope.`reservation_micros` AND r.`state`='active' AND r.`expires_at`=NEW.`expires_at`));
END;
