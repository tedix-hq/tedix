-- Lane 2: port the surviving D1 triggers for work_admissions, work_attempts,
-- work_approval_proposals, work_approval_decisions, work_resource_pools,
-- work_resource_reservations, work_budget_envelopes and
-- work_budget_reservations, plus the work_due and commitment_wake_outbox
-- projections those tables feed, and the review.json checks/indexes.
-- Timestamps stay text; ISO comparisons are lexical and 'now' comparisons use
-- timestamptz casts guarded by pg_input_is_valid, matching julianday() NULL
-- semantics. Guard functions serialize on the organization row like the
-- interaction/case ports do.
BEGIN;
LOCK TABLE work_admissions, work_attempts, work_approval_proposals,
 work_approval_decisions, work_resource_pools, work_resource_reservations,
 work_budget_envelopes, work_budget_reservations, work_due,
 commitment_wake_outbox IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE work_admissions ADD CONSTRAINT chk_work_admission_identity
 CHECK ((executor_type IN ('human','tedi') AND executor_session_id IS NULL AND external_session_key IS NULL) OR (executor_type = 'external_agent' AND executor_session_id IS NOT NULL AND external_session_key IS NOT NULL));
ALTER TABLE work_admissions ADD CONSTRAINT chk_work_admission_decision
 CHECK ((decision = 'admitted' AND rejection_code IS NULL AND rejection_reason IS NULL AND rejection_key IS NULL) OR (decision = 'rejected' AND rejection_code IS NOT NULL AND rejection_reason IS NOT NULL AND rejection_key IS NOT NULL));
ALTER TABLE work_attempts ADD CONSTRAINT chk_work_attempt_identity
 CHECK ((executor_type IN ('human','tedi') AND executor_session_id IS NULL AND external_session_key IS NULL) OR (executor_type = 'external_agent' AND executor_session_id IS NOT NULL AND external_session_key IS NOT NULL));
ALTER TABLE work_attempts ADD CONSTRAINT chk_work_attempt_terminal_state
 CHECK ((runtime_state IN ('failed','expired','finished','cancelled') AND finished_at IS NOT NULL AND outcome IS NOT NULL) OR (runtime_state IN ('queued','running','waiting','retrying') AND finished_at IS NULL AND outcome IS NULL));
ALTER TABLE work_budget_envelopes ADD CONSTRAINT chk_work_budget_limit CHECK (limit_micros >= 0);
ALTER TABLE work_budget_envelopes ADD CONSTRAINT chk_work_budget_reservation CHECK (reservation_micros >= 0 AND reservation_micros <= limit_micros);
ALTER TABLE work_budget_reservations ADD CONSTRAINT chk_work_budget_reservation_amount CHECK (amount_micros >= 0);
ALTER TABLE work_resource_pools ADD CONSTRAINT chk_work_resource_pool_capacity CHECK (capacity > 0);
ALTER TABLE work_resource_pools ADD CONSTRAINT chk_work_resource_pool_mode CHECK (allocation_mode <> 'exclusive' OR capacity = 1);
ALTER TABLE work_resource_requirements ADD CONSTRAINT chk_work_resource_requirement_quantity CHECK (quantity > 0);
ALTER TABLE work_resource_reservations ADD CONSTRAINT chk_work_resource_reservation_quantity CHECK (quantity > 0);

CREATE UNIQUE INDEX uniq_work_approval_pending_scope
 ON work_approval_proposals (org_id,work_item_id,work_item_version,authority_key,action,approver_type,approver_id)
 WHERE status='pending';
CREATE UNIQUE INDEX uniq_work_attempt_active
 ON work_attempts (org_id,work_item_id)
 WHERE runtime_state IN ('queued','running','waiting','retrying');
CREATE INDEX idx_work_attempt_org_item_started
 ON work_attempts (org_id,work_item_id,started_at DESC,id DESC);

CREATE FUNCTION work_admission_scope_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.executor_type='human' AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.executor_id AND m.kind='human' AND m.status='active') THEN
  RAISE EXCEPTION 'inactive human executor' USING ERRCODE='23514';
 END IF;
 IF NEW.decision NOT IN ('admitted','rejected') OR NEW.executor_type NOT IN ('human','tedi','external_agent') THEN
  RAISE EXCEPTION 'invalid admission receipt state' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id AND wi.version=NEW.work_item_version AND wi.admission_spec_revision=NEW.admission_spec_revision) THEN
  RAISE EXCEPTION 'admission receipt is not current' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='tedi' AND NOT EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.executor_id AND t.retired_at IS NULL) THEN
  RAISE EXCEPTION 'inactive tedi executor' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='external_agent' AND NOT EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.executor_id AND s.id=NEW.executor_session_id AND s.external_session_key=NEW.external_session_key AND s.status='active' AND p.status='active') THEN
  RAISE EXCEPTION 'inactive external executor session' USING ERRCODE='23514';
 END IF;
 IF NEW.decision='rejected' AND (NEW.rejection_key IS NULL OR NEW.rejection_code IS NULL OR NEW.rejection_reason IS NULL OR NEW.expires_at<=NEW.decided_at) THEN
  RAISE EXCEPTION 'invalid rejection receipt' USING ERRCODE='23514';
 END IF;
 IF NEW.decision='admitted' AND (NEW.rejection_key IS NOT NULL OR NEW.rejection_code IS NOT NULL OR NEW.rejection_reason IS NOT NULL) THEN
  RAISE EXCEPTION 'admitted receipt cannot carry rejection' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_admission_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NOT EXISTS(SELECT 1 FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id AND wi.version=NEW.work_item_version AND wi.admission_spec_revision=NEW.admission_spec_revision AND wi.disposition='accepted') THEN
  RAISE EXCEPTION 'stale admission specification' USING ERRCODE='23514';
 END IF;
 IF NEW.expires_at<=NEW.decided_at THEN
  RAISE EXCEPTION 'expired admission' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM work_item_relations rel JOIN work_items prerequisite ON prerequisite.org_id=rel.org_id AND prerequisite.id=rel.from_work_item_id WHERE rel.org_id=NEW.org_id AND rel.to_work_item_id=NEW.work_item_id AND rel.relation_type='blocks' AND prerequisite.disposition NOT IN ('completed','cancelled')) THEN
  RAISE EXCEPTION 'admission dependency blocked' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.runtime_state IN ('queued','running','waiting','retrying') AND (a.expires_at IS NULL OR a.expires_at>NEW.decided_at)) THEN
  RAISE EXCEPTION 'work already running' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='tedi' AND NOT EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.executor_id AND t.retired_at IS NULL) THEN
  RAISE EXCEPTION 'inactive tedi executor' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='external_agent' AND NOT EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.executor_id AND s.id=NEW.executor_session_id AND s.external_session_key=NEW.external_session_key AND s.status='active' AND p.status='active') THEN
  RAISE EXCEPTION 'inactive external executor session' USING ERRCODE='23514';
 END IF;
 IF EXISTS(
  SELECT 1 FROM jsonb_array_elements_text((SELECT wi.required_capabilities FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)) required
  WHERE NOT EXISTS(SELECT 1 FROM org_capabilities c JOIN capability_links l ON l.organization_id=c.organization_id AND l.capability_id=c.id WHERE c.organization_id=NEW.org_id AND c.status='active' AND (c.id=required.value OR c.slug=required.value) AND l.entity_kind=NEW.executor_type AND l.entity_id=NEW.executor_id)
 ) THEN
  RAISE EXCEPTION 'executor capability missing' USING ERRCODE='23514';
 END IF;
 IF NOT (EXISTS (SELECT 1 FROM work_items child
  JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
  JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=child.metadata #>> '{childDelegation,parentAttemptId}'
  JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
  JOIN organizations org ON org.id=child.org_id
  WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
  AND child.metadata #>> '{childDelegation,parentRevision}'=parent.admission_spec_revision
  AND child.metadata #>> '{childDelegation,approvalMode}'='auto'
  AND coalesce(org.metadata #>> '{workDelegation,approvalMode}','auto')='auto'
  AND child.risk_level=parent.risk_level
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(child.required_capabilities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(parent.required_capabilities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(parent.required_authorities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(child.required_authorities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(child.required_authorities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(parent.required_authorities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(parent.required_capabilities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(child.required_capabilities) p))
 )) AND EXISTS(
  SELECT 1 FROM (
   SELECT value AS authority FROM jsonb_array_elements_text((SELECT wi.required_authorities FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id))
   UNION ALL SELECT 'risk:high' WHERE (SELECT wi.risk_level FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)='high'
   UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.risk_level FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)='critical'
  ) required WHERE NOT EXISTS(SELECT 1 FROM work_approval_proposals p JOIN work_approval_decisions d ON d.proposal_id=p.id AND d.decision='approved' AND d.resolved_proposal_version=p.version WHERE p.org_id=NEW.org_id AND p.work_item_id=NEW.work_item_id AND p.work_item_version BETWEEN COALESCE((SELECT (e.payload #>> '{planningApproval,fromVersion}')::bigint FROM work_events e WHERE e.org_id=NEW.org_id AND e.work_item_id=NEW.work_item_id AND e.event_type='work.specification_updated' AND (e.payload #>> '{planningApproval,toVersion}')::bigint=NEW.work_item_version AND (e.payload #>> '{planningApproval,admissionSpecRevision}')=NEW.admission_spec_revision ORDER BY e.sequence DESC LIMIT 1), NEW.work_item_version) AND NEW.work_item_version AND p.action='admission' AND p.authority_key=required.authority AND p.status='approved' AND p.expires_at>NEW.decided_at)
 ) THEN
  RAISE EXCEPTION 'admission approval missing' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_admission_fact_cap_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF (SELECT count(*) FROM work_resource_requirements requirement WHERE requirement.org_id=NEW.org_id AND requirement.work_item_id=NEW.work_item_id) > 500 THEN
  RAISE EXCEPTION 'resource requirement facts exceed admission cap' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM work_budget_envelopes envelope WHERE envelope.org_id=NEW.org_id AND envelope.enabled AND (
  (envelope.scope_type='organization' AND envelope.scope_id=NEW.org_id)
  OR (envelope.scope_type='work_item' AND envelope.scope_id IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
   SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
   UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
   WHERE parent.org_id=NEW.org_id AND jsonb_typeof(child.metadata #> '{childDelegation,parentAttemptId}')='string'
  ) SELECT id FROM ancestors))
  OR (envelope.scope_type='project' AND envelope.scope_id=(SELECT item.project_id FROM work_items item WHERE item.org_id=NEW.org_id AND item.id=NEW.work_item_id))
  OR (envelope.scope_type='case' AND EXISTS(SELECT 1 FROM work_case_items case_item WHERE case_item.org_id=NEW.org_id AND case_item.work_item_id=NEW.work_item_id AND case_item.case_id=envelope.scope_id))
 )) > 1000 THEN
  RAISE EXCEPTION 'budget envelope facts exceed admission cap' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_admission_immutable_update_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'admissions are immutable' USING ERRCODE='23514';
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_admission_immutable_delete_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'admissions are immutable' USING ERRCODE='23514';
 RETURN OLD;
END;
$$;

CREATE FUNCTION work_attempt_admission_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.admission_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM work_admissions a JOIN work_items wi ON wi.org_id=a.org_id AND wi.id=a.work_item_id
  WHERE a.id=NEW.admission_id AND a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.decision='admitted' AND NEW.expires_at IS NOT NULL AND a.expires_at=NEW.expires_at AND a.expires_at>NEW.started_at AND a.executor_type=NEW.executor_type AND a.executor_id=NEW.executor_id AND a.executor_session_id IS NOT DISTINCT FROM NEW.executor_session_id AND a.external_session_key IS NOT DISTINCT FROM NEW.external_session_key AND wi.version=a.work_item_version AND wi.admission_spec_revision=a.admission_spec_revision AND wi.disposition='accepted'
 ) THEN
  RAISE EXCEPTION 'attempt does not match active admission' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM work_item_relations rel JOIN work_items prerequisite ON prerequisite.org_id=rel.org_id AND prerequisite.id=rel.from_work_item_id WHERE rel.org_id=NEW.org_id AND rel.to_work_item_id=NEW.work_item_id AND rel.relation_type='blocks' AND prerequisite.disposition NOT IN ('completed','cancelled')) THEN
  RAISE EXCEPTION 'attempt dependency blocked' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='tedi' AND NOT EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.executor_id AND t.retired_at IS NULL) THEN
  RAISE EXCEPTION 'inactive tedi executor' USING ERRCODE='23514';
 END IF;
 IF NEW.executor_type='external_agent' AND NOT EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.executor_id AND s.id=NEW.executor_session_id AND s.external_session_key=NEW.external_session_key AND s.status='active' AND p.status='active') THEN
  RAISE EXCEPTION 'inactive external executor session' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text((SELECT wi.required_capabilities FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)) required WHERE NOT EXISTS(SELECT 1 FROM org_capabilities c JOIN capability_links l ON l.organization_id=c.organization_id AND l.capability_id=c.id WHERE c.organization_id=NEW.org_id AND c.status='active' AND (c.id=required.value OR c.slug=required.value) AND l.entity_kind=NEW.executor_type AND l.entity_id=NEW.executor_id)) THEN
  RAISE EXCEPTION 'attempt capability revoked' USING ERRCODE='23514';
 END IF;
 IF NOT (EXISTS (SELECT 1 FROM work_items child
  JOIN work_items parent ON parent.org_id=child.org_id AND parent.id=child.parent_work_item_id
  JOIN work_attempts parent_attempt ON parent_attempt.org_id=parent.org_id AND parent_attempt.work_item_id=parent.id AND parent_attempt.id=child.metadata #>> '{childDelegation,parentAttemptId}'
  JOIN work_admissions parent_admission ON parent_admission.id=parent_attempt.admission_id AND parent_admission.org_id=parent.org_id AND parent_admission.work_item_id=parent.id AND parent_admission.decision='admitted' AND parent_admission.admission_spec_revision=parent.admission_spec_revision
  JOIN organizations org ON org.id=child.org_id
  WHERE child.org_id=NEW.org_id AND child.id=NEW.work_item_id AND parent.disposition IN ('accepted','completed')
  AND child.metadata #>> '{childDelegation,parentRevision}'=parent.admission_spec_revision
  AND child.metadata #>> '{childDelegation,approvalMode}'='auto'
  AND coalesce(org.metadata #>> '{workDelegation,approvalMode}','auto')='auto'
  AND child.risk_level=parent.risk_level
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(child.required_capabilities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(parent.required_capabilities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(parent.required_authorities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(child.required_authorities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(child.required_authorities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(parent.required_authorities) p))
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(parent.required_capabilities) c WHERE c.value NOT IN (SELECT p.value FROM jsonb_array_elements_text(child.required_capabilities) p))
 )) AND EXISTS(SELECT 1 FROM (SELECT value AS authority FROM jsonb_array_elements_text((SELECT wi.required_authorities FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)) UNION ALL SELECT 'risk:high' WHERE (SELECT wi.risk_level FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)='high' UNION ALL SELECT 'risk:critical' WHERE (SELECT wi.risk_level FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)='critical') required WHERE NOT EXISTS(SELECT 1 FROM work_approval_proposals p JOIN work_approval_decisions d ON d.proposal_id=p.id AND d.decision='approved' AND d.resolved_proposal_version=p.version WHERE p.org_id=NEW.org_id AND p.work_item_id=NEW.work_item_id AND p.work_item_version BETWEEN COALESCE((SELECT (e.payload #>> '{planningApproval,fromVersion}')::bigint FROM work_events e WHERE e.org_id=NEW.org_id AND e.work_item_id=NEW.work_item_id AND e.event_type='work.specification_updated' AND (e.payload #>> '{planningApproval,toVersion}')::bigint=(SELECT wi.version FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id) AND (e.payload #>> '{planningApproval,admissionSpecRevision}')=(SELECT wi.admission_spec_revision FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id) ORDER BY e.sequence DESC LIMIT 1),(SELECT wi.version FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id)) AND (SELECT wi.version FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id) AND p.action='admission' AND p.authority_key=required.authority AND p.status='approved' AND p.expires_at>NEW.started_at)) THEN
  RAISE EXCEPTION 'attempt approval expired or revoked' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM work_resource_requirements req WHERE req.org_id=NEW.org_id AND req.work_item_id=NEW.work_item_id AND NOT EXISTS(SELECT 1 FROM work_resource_reservations r JOIN work_resource_pools pool ON pool.org_id=r.org_id AND pool.id=r.pool_id WHERE r.org_id=NEW.org_id AND r.work_item_id=NEW.work_item_id AND r.admission_id=NEW.admission_id AND r.resource_key=req.resource_key AND r.quantity=req.quantity AND r.state='active' AND r.expires_at=NEW.expires_at AND pool.resource_key=req.resource_key AND pool.version=r.pool_version AND pool.enabled)) THEN
  RAISE EXCEPTION 'attempt resource reservation missing or pool revoked' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM work_budget_envelopes envelope JOIN work_items wi ON wi.org_id=envelope.org_id AND wi.id=NEW.work_item_id WHERE envelope.org_id=NEW.org_id AND envelope.enabled AND envelope.currency<>'credits' AND (envelope.scope_type='organization' AND envelope.scope_id=NEW.org_id OR envelope.scope_type='work_item' AND envelope.scope_id IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
  SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
  UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
  WHERE parent.org_id=NEW.org_id AND jsonb_typeof(child.metadata #> '{childDelegation,parentAttemptId}')='string'
 ) SELECT id FROM ancestors) OR envelope.scope_type='project' AND envelope.scope_id=wi.project_id OR envelope.scope_type='case' AND EXISTS(SELECT 1 FROM work_case_items ci WHERE ci.org_id=NEW.org_id AND ci.work_item_id=NEW.work_item_id AND ci.case_id=envelope.scope_id)) AND NOT EXISTS(SELECT 1 FROM work_budget_reservations r WHERE r.org_id=NEW.org_id AND r.work_item_id=NEW.work_item_id AND r.admission_id=NEW.admission_id AND r.envelope_id=envelope.id AND r.envelope_version=envelope.version AND r.amount_micros=envelope.reservation_micros AND r.state='active' AND r.expires_at=NEW.expires_at)) THEN
  RAISE EXCEPTION 'attempt budget reservation missing' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_attempt_admission_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.admission_id IS DISTINCT FROM OLD.admission_id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.executor_type<>OLD.executor_type OR NEW.executor_id<>OLD.executor_id OR NEW.executor_session_id IS DISTINCT FROM OLD.executor_session_id OR NEW.external_session_key IS DISTINCT FROM OLD.external_session_key OR NEW.version<>OLD.version+1 OR OLD.runtime_state NOT IN ('queued','running','waiting','retrying') THEN
  RAISE EXCEPTION 'attempt fence or terminal state is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.runtime_state IN ('queued','running','waiting','retrying') AND NEW.expires_at IS NULL THEN
  RAISE EXCEPTION 'active attempt requires bounded expiry' USING ERRCODE='23514';
 END IF;
 IF NEW.runtime_state IN ('queued','running','waiting','retrying') AND NEW.executor_type='tedi' AND NOT EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.executor_id AND t.retired_at IS NULL) THEN
  RAISE EXCEPTION 'inactive tedi executor' USING ERRCODE='23514';
 END IF;
 IF NEW.runtime_state IN ('queued','running','waiting','retrying') AND NEW.executor_type='external_agent' AND NOT EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.executor_id AND s.id=NEW.executor_session_id AND s.external_session_key=NEW.external_session_key AND s.status='active' AND p.status='active') THEN
  RAISE EXCEPTION 'inactive external executor session' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_proposal_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.status<>'pending' OR NEW.version<>1 OR NEW.resolution_fence IS NOT NULL OR NEW.expires_at<=NEW.created_at THEN
  RAISE EXCEPTION 'invalid approval proposal state' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.work_item_id AND wi.version=NEW.work_item_version) THEN
  RAISE EXCEPTION 'stale approval work item' USING ERRCODE='23514';
 END IF;
 IF NEW.requester_type=NEW.approver_type AND NEW.requester_id=NEW.approver_id THEN
  RAISE EXCEPTION 'self approval is forbidden' USING ERRCODE='23514';
 END IF;
 IF NOT (
  (NEW.approver_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.approver_id AND m.status='active')) OR
  (NEW.approver_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.approver_id AND t.retired_at IS NULL))
 ) THEN
  RAISE EXCEPTION 'invalid approval approver' USING ERRCODE='23514';
 END IF;
 IF NOT (
  (NEW.requester_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.requester_id AND m.status='active')) OR
  (NEW.requester_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.requester_id AND t.retired_at IS NULL)) OR
  (NEW.requester_type='external_agent' AND EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.requester_id AND s.id=NEW.requester_session_id AND s.external_session_key=NEW.requester_external_session_key AND s.status='active' AND p.status='active')) OR
  (NEW.requester_type='system' AND NEW.requester_id='tedix')
 ) THEN
  RAISE EXCEPTION 'invalid approval requester' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_proposal_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF OLD.status<>'pending' OR NEW.version<>OLD.version+1 OR NEW.resolution_fence IS NULL THEN
  RAISE EXCEPTION 'invalid approval resolution' USING ERRCODE='23514';
 END IF;
 IF NEW.org_id<>OLD.org_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.work_item_version<>OLD.work_item_version OR NEW.authority_key<>OLD.authority_key OR NEW.action<>OLD.action OR NEW.requester_type<>OLD.requester_type OR NEW.requester_id<>OLD.requester_id OR NEW.approver_type<>OLD.approver_type OR NEW.approver_id<>OLD.approver_id OR NEW.expires_at<>OLD.expires_at THEN
  RAISE EXCEPTION 'approval scope is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.status='expired' AND (OLD.expires_at>NEW.resolved_at OR NEW.resolved_at IS NULL) THEN
  RAISE EXCEPTION 'invalid approval expiry' USING ERRCODE='23514';
 END IF;
 IF NEW.status<>'expired' AND NOT EXISTS(SELECT 1 FROM work_approval_decisions d WHERE d.proposal_id=NEW.id AND d.resolved_proposal_version=NEW.version AND d.decision=NEW.status) THEN
  RAISE EXCEPTION 'approval resolution requires decision receipt' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_proposal_delete_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'approval proposals are retained' USING ERRCODE='23514';
 RETURN OLD;
END;
$$;

CREATE FUNCTION work_approval_decision_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=(SELECT p.org_id FROM work_approval_proposals p WHERE p.id=NEW.proposal_id) FOR NO KEY UPDATE;
 IF NEW.decision NOT IN ('approved','rejected') THEN
  RAISE EXCEPTION 'invalid approval decision' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM work_approval_proposals p WHERE p.id=NEW.proposal_id AND p.status='pending' AND p.resolution_fence IS NULL AND p.version+1=NEW.resolved_proposal_version AND p.expires_at>NEW.decided_at AND p.approver_type=NEW.decider_type AND p.approver_id=NEW.decider_id AND NOT(p.requester_type=NEW.decider_type AND p.requester_id=NEW.decider_id)
 ) THEN
  RAISE EXCEPTION 'approval decision lost resolution race' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM work_approval_proposals p WHERE p.id=NEW.proposal_id AND (
   (NEW.decider_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=p.org_id AND m.user_id=NEW.decider_id AND m.status='active')) OR
   (NEW.decider_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=p.org_id AND t.id=NEW.decider_id AND t.retired_at IS NULL))
  )
 ) THEN
  RAISE EXCEPTION 'inactive approval decider' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_decision_apply_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 UPDATE work_approval_proposals SET status=NEW.decision, resolution_fence=replace(gen_random_uuid()::text,'-',''), resolved_at=NEW.decided_at, version=NEW.resolved_proposal_version
 WHERE id=NEW.proposal_id AND status='pending' AND resolution_fence IS NULL AND version+1=NEW.resolved_proposal_version;
 RETURN NULL;
END;
$$;

CREATE FUNCTION work_admission_decision_freshness_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=(SELECT p.org_id FROM work_approval_proposals p WHERE p.id=NEW.proposal_id) FOR NO KEY UPDATE;
 IF EXISTS (SELECT 1 FROM work_approval_proposals p WHERE p.id=NEW.proposal_id AND p.action='admission'
  AND NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.org_id=p.org_id AND wi.id=p.work_item_id AND wi.version=p.work_item_version)) THEN
  RAISE EXCEPTION 'stale admission approval decision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_decision_immutable_update_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'approval decisions are immutable' USING ERRCODE='23514';
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_approval_decision_immutable_delete_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'approval decisions are immutable' USING ERRCODE='23514';
 RETURN OLD;
END;
$$;

CREATE FUNCTION work_resource_pool_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.allocation_mode NOT IN ('exclusive','capacity') OR NEW.version<>1 OR NEW.capacity<=0 OR (NEW.allocation_mode='exclusive' AND NEW.capacity<>1) THEN
  RAISE EXCEPTION 'invalid resource pool initial state' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_resource_pool_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.resource_key<>OLD.resource_key OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'resource pool scope/version is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.allocation_mode NOT IN ('exclusive','capacity') THEN
  RAISE EXCEPTION 'invalid resource allocation mode' USING ERRCODE='23514';
 END IF;
 IF NEW.allocation_mode='exclusive' AND NEW.capacity<>1 THEN
  RAISE EXCEPTION 'exclusive resource capacity must equal one' USING ERRCODE='23514';
 END IF;
 IF NEW.capacity < (SELECT COALESCE(SUM(r.quantity),0) FROM work_resource_reservations r WHERE r.org_id=OLD.org_id AND r.pool_id=OLD.id AND r.state='active' AND pg_input_is_valid(r.expires_at,'timestamp with time zone') AND r.expires_at::timestamptz>now()) THEN
  RAISE EXCEPTION 'resource capacity below active reservations' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_resource_reservation_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.state<>'active' OR NEW.version<>1 OR NEW.settled_at IS NOT NULL THEN
  RAISE EXCEPTION 'invalid resource reservation initial state' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM work_admissions a JOIN work_resource_requirements req ON req.org_id=a.org_id AND req.work_item_id=a.work_item_id AND req.resource_key=NEW.resource_key JOIN work_resource_pools pool ON pool.org_id=req.org_id AND pool.resource_key=req.resource_key
  WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.id=NEW.admission_id AND a.decision='admitted' AND a.expires_at>NEW.reserved_at AND pool.id=NEW.pool_id AND pool.version=NEW.pool_version AND pool.enabled AND req.quantity=NEW.quantity
 ) THEN
  RAISE EXCEPTION 'resource reservation does not match admission requirement' USING ERRCODE='23514';
 END IF;
 IF NEW.quantity+(SELECT COALESCE(SUM(r.quantity),0) FROM work_resource_reservations r WHERE r.org_id=NEW.org_id AND r.pool_id=NEW.pool_id AND r.state='active' AND r.expires_at>NEW.reserved_at) > (SELECT pool.capacity FROM work_resource_pools pool WHERE pool.org_id=NEW.org_id AND pool.id=NEW.pool_id) THEN
  RAISE EXCEPTION 'resource capacity exhausted' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_resource_reservation_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.admission_id<>OLD.admission_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.pool_id<>OLD.pool_id OR NEW.pool_version<>OLD.pool_version OR NEW.resource_key<>OLD.resource_key OR NEW.quantity<>OLD.quantity OR NEW.version<>OLD.version+1 OR OLD.state<>'active' OR NEW.state NOT IN ('active','released','consumed','expired') THEN
  RAISE EXCEPTION 'invalid resource reservation transition' USING ERRCODE='23514';
 END IF;
 IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('queued','running','waiting','retrying') AND a.expires_at=NEW.expires_at) THEN
  RAISE EXCEPTION 'resource heartbeat lacks active attempt' USING ERRCODE='23514';
 END IF;
 IF NEW.state='released' AND NOT (EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.admission_id=NEW.admission_id)) THEN
  RAISE EXCEPTION 'resource release lacks settlement or losing start' USING ERRCODE='23514';
 END IF;
 IF NEW.state='consumed' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('finished','failed','cancelled','expired')) THEN
  RAISE EXCEPTION 'resource consume lacks settlement' USING ERRCODE='23514';
 END IF;
 IF NEW.state='expired' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state='expired') THEN
  RAISE EXCEPTION 'resource expiry lacks timeout' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_resource_reservation_delete_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'resource reservations are retained' USING ERRCODE='23514';
 RETURN OLD;
END;
$$;

CREATE FUNCTION work_budget_envelope_scope_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.version<>1 OR NEW.currency NOT IN ('USD','credits') OR (NEW.currency='credits' AND NEW.reservation_micros<>0) THEN
  RAISE EXCEPTION 'invalid budget envelope initial state' USING ERRCODE='23514';
 END IF;
 IF NOT (
  (NEW.scope_type='organization' AND NEW.scope_id=NEW.org_id) OR
  (NEW.scope_type='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.org_id=NEW.org_id AND p.id=NEW.scope_id)) OR
  (NEW.scope_type='case' AND EXISTS(SELECT 1 FROM work_cases c WHERE c.org_id=NEW.org_id AND c.id=NEW.scope_id)) OR
  (NEW.scope_type='work_item' AND EXISTS(SELECT 1 FROM work_items wi WHERE wi.org_id=NEW.org_id AND wi.id=NEW.scope_id)) OR
  (NEW.scope_type='objective' AND NEW.currency='credits' AND EXISTS(SELECT 1 FROM tedi_objectives o WHERE o.org_id=NEW.org_id AND o.id=NEW.scope_id))
 ) THEN
  RAISE EXCEPTION 'invalid budget scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_budget_envelope_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id OR NEW.currency<>OLD.currency OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'budget envelope scope/version is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.limit_micros < (
  SELECT COALESCE(SUM(COALESCE(r.consumed_micros,r.amount_micros)),0) FROM work_budget_reservations r WHERE r.org_id=OLD.org_id AND r.envelope_id=OLD.id AND r.state='consumed'
 ) + (
  SELECT COALESCE(SUM(r.amount_micros),0) FROM work_budget_reservations r WHERE r.org_id=OLD.org_id AND r.envelope_id=OLD.id AND r.state='active' AND pg_input_is_valid(r.expires_at,'timestamp with time zone') AND r.expires_at::timestamptz>now()
 ) THEN
  RAISE EXCEPTION 'budget below commitments' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_budget_reservation_insert_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.state<>'active' OR NEW.version<>1 OR NEW.settled_at IS NOT NULL OR NEW.consumed_micros IS NOT NULL THEN
  RAISE EXCEPTION 'invalid budget reservation initial state' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(
  SELECT 1 FROM work_admissions a JOIN work_items wi ON wi.org_id=a.org_id AND wi.id=a.work_item_id JOIN work_budget_envelopes envelope ON envelope.org_id=a.org_id AND envelope.id=NEW.envelope_id
  WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.id=NEW.admission_id AND a.decision='admitted' AND a.expires_at>NEW.reserved_at AND envelope.version=NEW.envelope_version AND envelope.enabled AND envelope.reservation_micros=NEW.amount_micros AND (
   envelope.scope_type='organization' AND envelope.scope_id=a.org_id OR envelope.scope_type='work_item' AND envelope.scope_id IN (WITH RECURSIVE ancestors(id,parent_id,metadata) AS (
    SELECT id,parent_work_item_id,metadata FROM work_items WHERE org_id=NEW.org_id AND id=NEW.work_item_id
    UNION SELECT parent.id,parent.parent_work_item_id,parent.metadata FROM work_items parent JOIN ancestors child ON parent.id=child.parent_id
    WHERE parent.org_id=NEW.org_id AND jsonb_typeof(child.metadata #> '{childDelegation,parentAttemptId}')='string'
   ) SELECT id FROM ancestors) OR envelope.scope_type='project' AND envelope.scope_id=wi.project_id OR envelope.scope_type='case' AND EXISTS(SELECT 1 FROM work_case_items ci WHERE ci.org_id=a.org_id AND ci.work_item_id=a.work_item_id AND ci.case_id=envelope.scope_id)
  )
 ) THEN
  RAISE EXCEPTION 'budget reservation does not match admission envelope' USING ERRCODE='23514';
 END IF;
 IF NEW.amount_micros+
  (SELECT COALESCE(SUM(COALESCE(r.consumed_micros,r.amount_micros)),0) FROM work_budget_reservations r WHERE r.org_id=NEW.org_id AND r.envelope_id=NEW.envelope_id AND r.state='consumed')+
  (SELECT COALESCE(SUM(r.amount_micros),0) FROM work_budget_reservations r WHERE r.org_id=NEW.org_id AND r.envelope_id=NEW.envelope_id AND r.state='active' AND r.expires_at>NEW.reserved_at)
  > (SELECT envelope.limit_micros FROM work_budget_envelopes envelope WHERE envelope.org_id=NEW.org_id AND envelope.id=NEW.envelope_id) THEN
  RAISE EXCEPTION 'budget exhausted' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_budget_reservation_update_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.admission_id<>OLD.admission_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.envelope_id<>OLD.envelope_id OR NEW.envelope_version<>OLD.envelope_version OR NEW.amount_micros<>OLD.amount_micros OR NEW.version<>OLD.version+1 OR OLD.state<>'active' OR NEW.state NOT IN ('active','released','consumed','expired') THEN
  RAISE EXCEPTION 'invalid budget reservation transition' USING ERRCODE='23514';
 END IF;
 IF NEW.state='consumed' AND (NEW.consumed_micros IS NULL OR NEW.consumed_micros<0 OR NEW.consumed_micros>NEW.amount_micros) THEN
  RAISE EXCEPTION 'invalid consumed budget amount' USING ERRCODE='23514';
 END IF;
 IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('queued','running','waiting','retrying') AND a.expires_at=NEW.expires_at) THEN
  RAISE EXCEPTION 'budget heartbeat lacks active attempt' USING ERRCODE='23514';
 END IF;
 IF NEW.state='released' AND NOT (EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('finished','failed','cancelled','expired')) OR NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.admission_id=NEW.admission_id)) THEN
  RAISE EXCEPTION 'budget release lacks settlement or losing start' USING ERRCODE='23514';
 END IF;
 IF NEW.state='consumed' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state IN ('finished','failed','cancelled','expired')) THEN
  RAISE EXCEPTION 'budget consume lacks settlement' USING ERRCODE='23514';
 END IF;
 IF NEW.state='expired' AND NOT EXISTS(SELECT 1 FROM work_attempts a WHERE a.org_id=NEW.org_id AND a.work_item_id=NEW.work_item_id AND a.admission_id=NEW.admission_id AND a.runtime_state='expired') THEN
  RAISE EXCEPTION 'budget expiry lacks timeout' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION work_budget_reservation_delete_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'budget reservations are retained' USING ERRCODE='23514';
 RETURN OLD;
END;
$$;

CREATE FUNCTION work_due_work_approval_redrive_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='work-approval-redrive' AND object_id=OLD.id;
  RETURN NULL;
 END IF;
 DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-approval-redrive' AND object_id=NEW.id;
 INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT org_id,'work-approval-redrive',id,created_at,'pending','' FROM work_approval_proposals
 WHERE id=NEW.id AND status='pending' AND approver_type='tedi' AND pg_input_is_valid(expires_at,'timestamp with time zone') AND expires_at::timestamptz>now() AND created_at IS NOT NULL
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
 RETURN NULL;
END;
$$;

CREATE FUNCTION work_due_work_attempt_lease_sweep_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='work-attempt-lease-sweep' AND object_id=OLD.id;
  RETURN NULL;
 END IF;
 DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-attempt-lease-sweep' AND object_id=NEW.id;
 INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT org_id,'work-attempt-lease-sweep',id,expires_at,'pending','' FROM work_attempts
 WHERE id=NEW.id AND runtime_state IN ('queued','running','waiting','retrying') AND expires_at IS NOT NULL
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
 RETURN NULL;
END;
$$;

CREATE FUNCTION work_due_lane_stale_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='lane-stale' AND object_id=OLD.id;
  RETURN NULL;
 END IF;
 DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='lane-stale' AND object_id=NEW.id;
 INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT a.org_id,'lane-stale',a.id,to_char(to_timestamp((extract(epoch from a.heartbeat_at::timestamptz)+extract(epoch from a.expires_at::timestamptz))/2) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_attempts a
 WHERE a.org_id=NEW.org_id AND a.id=NEW.id AND a.executor_type='external_agent' AND a.metadata #> '{lane}'='1'::jsonb AND a.outcome IS NULL AND a.runtime_state IN ('queued','running','waiting','retrying')
  AND pg_input_is_valid(a.heartbeat_at,'timestamp with time zone') AND pg_input_is_valid(a.expires_at,'timestamp with time zone')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
 RETURN NULL;
END;
$$;

CREATE FUNCTION work_due_maintenance_attempt_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE scope_org text; scope_item text;
BEGIN
 IF TG_OP='DELETE' THEN scope_org:=OLD.org_id; scope_item:=OLD.work_item_id;
 ELSE scope_org:=NEW.org_id; scope_item:=NEW.work_item_id; END IF;
 DELETE FROM work_due WHERE org_id=scope_org AND kind='stale-delegation' AND object_id=scope_item;
 INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT w.org_id,'stale-delegation',w.id,to_char(to_timestamp(greatest(
  extract(epoch from coalesce(w.updated_at,w.created_at)::timestamptz),
  extract(epoch from (SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)::timestamptz)
 )+604800) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_items w
 WHERE w.org_id=scope_org AND w.id=scope_item AND w.disposition='accepted' AND w.provenance #>> '{source}'='kernelRuntime.directDelegation'
  AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying'))
  AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed'
  AND pg_input_is_valid(coalesce(w.updated_at,w.created_at),'timestamp with time zone')
  AND pg_input_is_valid((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1),'timestamp with time zone')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
 DELETE FROM work_due WHERE org_id=scope_org AND kind='uncontracted-child' AND object_id=scope_item;
 INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT w.org_id,'uncontracted-child',w.id,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_items w
 WHERE w.org_id=scope_org AND w.id=scope_item AND w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying'))
  AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND jsonb_typeof(e.payload #> '{taskContract}')='object')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
 RETURN NULL;
END;
$$;

CREATE FUNCTION commitment_wake_outbox_work_approval_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('approved','rejected') AND NEW.resolved_at IS NOT NULL AND pg_input_is_valid(NEW.resolved_at,'timestamp with time zone') THEN
  INSERT INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
  VALUES ('work_approval:' || NEW.id || ':' || NEW.resolved_at, 'commitment_wake', NEW.org_id, 'work_approval', NEW.id,
   NEW.resolved_at, to_char(((NEW.resolved_at)::timestamptz + interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END;
$$;

CREATE TRIGGER work_admission_scope_insert_guard BEFORE INSERT ON work_admissions FOR EACH ROW EXECUTE FUNCTION work_admission_scope_insert_guard_fn();
CREATE TRIGGER work_admission_insert_guard BEFORE INSERT ON work_admissions FOR EACH ROW WHEN (NEW.decision='admitted') EXECUTE FUNCTION work_admission_insert_guard_fn();
CREATE TRIGGER work_admission_fact_cap_insert_guard BEFORE INSERT ON work_admissions FOR EACH ROW WHEN (NEW.decision='admitted') EXECUTE FUNCTION work_admission_fact_cap_insert_guard_fn();
CREATE TRIGGER work_admission_immutable_update BEFORE UPDATE ON work_admissions FOR EACH ROW EXECUTE FUNCTION work_admission_immutable_update_fn();
CREATE TRIGGER work_admission_immutable_delete BEFORE DELETE ON work_admissions FOR EACH ROW EXECUTE FUNCTION work_admission_immutable_delete_fn();
CREATE TRIGGER work_attempt_admission_insert_guard BEFORE INSERT ON work_attempts FOR EACH ROW EXECUTE FUNCTION work_attempt_admission_insert_guard_fn();
CREATE TRIGGER work_attempt_admission_update_guard BEFORE UPDATE ON work_attempts FOR EACH ROW EXECUTE FUNCTION work_attempt_admission_update_guard_fn();
CREATE TRIGGER work_approval_proposal_insert_guard BEFORE INSERT ON work_approval_proposals FOR EACH ROW EXECUTE FUNCTION work_approval_proposal_insert_guard_fn();
CREATE TRIGGER work_approval_proposal_update_guard BEFORE UPDATE ON work_approval_proposals FOR EACH ROW EXECUTE FUNCTION work_approval_proposal_update_guard_fn();
CREATE TRIGGER work_approval_proposal_delete_guard BEFORE DELETE ON work_approval_proposals FOR EACH ROW EXECUTE FUNCTION work_approval_proposal_delete_guard_fn();
CREATE TRIGGER work_approval_decision_insert_guard BEFORE INSERT ON work_approval_decisions FOR EACH ROW EXECUTE FUNCTION work_approval_decision_insert_guard_fn();
CREATE TRIGGER work_admission_decision_freshness_guard BEFORE INSERT ON work_approval_decisions FOR EACH ROW WHEN (NEW.decision='approved') EXECUTE FUNCTION work_admission_decision_freshness_guard_fn();
CREATE TRIGGER work_approval_decision_apply AFTER INSERT ON work_approval_decisions FOR EACH ROW EXECUTE FUNCTION work_approval_decision_apply_fn();
CREATE TRIGGER work_approval_decision_immutable_update BEFORE UPDATE ON work_approval_decisions FOR EACH ROW EXECUTE FUNCTION work_approval_decision_immutable_update_fn();
CREATE TRIGGER work_approval_decision_immutable_delete BEFORE DELETE ON work_approval_decisions FOR EACH ROW EXECUTE FUNCTION work_approval_decision_immutable_delete_fn();
CREATE TRIGGER work_resource_pool_insert_guard BEFORE INSERT ON work_resource_pools FOR EACH ROW EXECUTE FUNCTION work_resource_pool_insert_guard_fn();
CREATE TRIGGER work_resource_pool_update_guard BEFORE UPDATE ON work_resource_pools FOR EACH ROW EXECUTE FUNCTION work_resource_pool_update_guard_fn();
CREATE TRIGGER work_resource_reservation_insert_guard BEFORE INSERT ON work_resource_reservations FOR EACH ROW EXECUTE FUNCTION work_resource_reservation_insert_guard_fn();
CREATE TRIGGER work_resource_reservation_update_guard BEFORE UPDATE ON work_resource_reservations FOR EACH ROW EXECUTE FUNCTION work_resource_reservation_update_guard_fn();
CREATE TRIGGER work_resource_reservation_delete_guard BEFORE DELETE ON work_resource_reservations FOR EACH ROW EXECUTE FUNCTION work_resource_reservation_delete_guard_fn();
CREATE TRIGGER work_budget_envelope_scope_insert_guard BEFORE INSERT ON work_budget_envelopes FOR EACH ROW EXECUTE FUNCTION work_budget_envelope_scope_insert_guard_fn();
CREATE TRIGGER work_budget_envelope_update_guard BEFORE UPDATE ON work_budget_envelopes FOR EACH ROW EXECUTE FUNCTION work_budget_envelope_update_guard_fn();
CREATE TRIGGER work_budget_reservation_insert_guard BEFORE INSERT ON work_budget_reservations FOR EACH ROW EXECUTE FUNCTION work_budget_reservation_insert_guard_fn();
CREATE TRIGGER work_budget_reservation_update_guard BEFORE UPDATE ON work_budget_reservations FOR EACH ROW EXECUTE FUNCTION work_budget_reservation_update_guard_fn();
CREATE TRIGGER work_budget_reservation_delete_guard BEFORE DELETE ON work_budget_reservations FOR EACH ROW EXECUTE FUNCTION work_budget_reservation_delete_guard_fn();
CREATE TRIGGER work_due_work_approval_redrive AFTER INSERT OR UPDATE OR DELETE ON work_approval_proposals FOR EACH ROW EXECUTE FUNCTION work_due_work_approval_redrive_fn();
CREATE TRIGGER work_due_work_attempt_lease_sweep AFTER INSERT OR UPDATE OR DELETE ON work_attempts FOR EACH ROW EXECUTE FUNCTION work_due_work_attempt_lease_sweep_fn();
CREATE TRIGGER work_due_lane_stale AFTER INSERT OR UPDATE OR DELETE ON work_attempts FOR EACH ROW EXECUTE FUNCTION work_due_lane_stale_fn();
CREATE TRIGGER work_due_maintenance_attempt AFTER INSERT OR UPDATE OR DELETE ON work_attempts FOR EACH ROW EXECUTE FUNCTION work_due_maintenance_attempt_fn();
CREATE TRIGGER commitment_wake_outbox_work_approval AFTER INSERT OR UPDATE ON work_approval_proposals FOR EACH ROW EXECUTE FUNCTION commitment_wake_outbox_work_approval_fn();

-- Rebuild the derived work_due rows this lane owns while writes are locked.
DELETE FROM work_due WHERE kind IN ('work-approval-redrive','work-attempt-lease-sweep','lane-stale','stale-delegation','uncontracted-child');
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT org_id,'work-approval-redrive',id,created_at,'pending','' FROM work_approval_proposals
 WHERE status='pending' AND approver_type='tedi' AND pg_input_is_valid(expires_at,'timestamp with time zone') AND expires_at::timestamptz>now() AND created_at IS NOT NULL
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT org_id,'work-attempt-lease-sweep',id,expires_at,'pending','' FROM work_attempts
 WHERE runtime_state IN ('queued','running','waiting','retrying') AND expires_at IS NOT NULL
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT a.org_id,'lane-stale',a.id,to_char(to_timestamp((extract(epoch from a.heartbeat_at::timestamptz)+extract(epoch from a.expires_at::timestamptz))/2) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_attempts a
 WHERE a.executor_type='external_agent' AND a.metadata #> '{lane}'='1'::jsonb AND a.outcome IS NULL AND a.runtime_state IN ('queued','running','waiting','retrying')
  AND pg_input_is_valid(a.heartbeat_at,'timestamp with time zone') AND pg_input_is_valid(a.expires_at,'timestamp with time zone')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT w.org_id,'stale-delegation',w.id,to_char(to_timestamp(greatest(
  extract(epoch from coalesce(w.updated_at,w.created_at)::timestamptz),
  extract(epoch from (SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)::timestamptz)
 )+604800) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_items w
 WHERE w.disposition='accepted' AND w.provenance #>> '{source}'='kernelRuntime.directDelegation'
  AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying'))
  AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed'
  AND pg_input_is_valid(coalesce(w.updated_at,w.created_at),'timestamp with time zone')
  AND pg_input_is_valid((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1),'timestamp with time zone')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
 SELECT w.org_id,'uncontracted-child',w.id,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'pending','' FROM work_items w
 WHERE w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying'))
  AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND jsonb_typeof(e.payload #> '{taskContract}')='object')
 ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';

COMMIT;
