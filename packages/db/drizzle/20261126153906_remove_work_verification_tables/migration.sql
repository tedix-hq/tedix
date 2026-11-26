-- tedix: destructive-reviewed Work-Item: 92b87d69-6105-4aef-b302-adbc4c698d5a
-- Preconditions: deployed event cutover with the old writers stopped, and a
-- recoverable backup. The copy below adds any missing history event; an event that
-- already exists is kept as it is. The guard then compares every source row with
-- its event, and missing or changed history aborts removal. Never bypass it.

--> statement-breakpoint
INSERT OR IGNORE INTO work_events(id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at)
SELECT 'work-observation:verification:' || s.id, s.org_id, s.work_item_id, 'work.observation_recorded', 'system', 'work-observation-migration', json_object('schema', 'tedix.work-observation.v1', 'kind', 'verification', 'record', json_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'evidenceId', s.evidence_id, 'source', s.source, 'verifierType', s.verifier_type, 'verifierId', s.verifier_id, 'claimed', json(s.claimed), 'observed', json(s.observed), 'matchesClaim', json(CASE WHEN s.matches_claim THEN 'true' ELSE 'false' END), 'observedAt', s.observed_at)), s.observed_at
FROM work_evidence_verifications s ORDER BY s.observed_at, s.id;
--> statement-breakpoint
INSERT OR IGNORE INTO work_events(id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at)
SELECT 'work-observation:confirmation:' || s.id, s.org_id, s.work_item_id, 'work.observation_recorded', 'system', 'work-observation-migration', json_object('schema', 'tedix.work-observation.v1', 'kind', 'confirmation', 'record', json_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'principalType', s.principal_type, 'principalId', s.principal_id, 'sessionId', s.session_id, 'evidenceRef', s.evidence_ref, 'stance', s.stance, 'body', s.body, 'occurredAt', s.occurred_at, 'createdAt', s.created_at)), s.occurred_at
FROM work_item_corroborations s ORDER BY s.occurred_at, s.created_at, s.id;
--> statement-breakpoint
DROP TABLE IF EXISTS work_observation_removal_guard;
--> statement-breakpoint
CREATE TABLE work_observation_removal_guard (
 reconciled INTEGER NOT NULL CHECK (reconciled = 1)
);
--> statement-breakpoint
WITH source AS (SELECT s.*, json_object('schema', 'tedix.work-observation.v1', 'kind', 'verification', 'record', json_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'evidenceId', s.evidence_id, 'source', s.source, 'verifierType', s.verifier_type, 'verifierId', s.verifier_id, 'claimed', json(s.claimed), 'observed', json(s.observed), 'matchesClaim', json(CASE WHEN s.matches_claim THEN 'true' ELSE 'false' END), 'observedAt', s.observed_at)) AS expected_payload FROM work_evidence_verifications s)
INSERT INTO work_observation_removal_guard(reconciled)
SELECT NOT EXISTS (
 SELECT 1 FROM source s LEFT JOIN work_events e ON e.id = 'work-observation:verification:' || s.id
 WHERE e.id IS NULL OR e.org_id IS NOT s.org_id OR e.work_item_id IS NOT s.work_item_id
 OR e.event_type IS NOT 'work.observation_recorded' OR e.actor_type IS NOT 'system'
 OR e.actor_id IS NOT 'work-observation-migration' OR e.occurred_at IS NOT s.observed_at
 OR EXISTS (SELECT fullkey, type, atom FROM json_tree(s.expected_payload)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(e.payload))
 OR EXISTS (SELECT fullkey, type, atom FROM json_tree(e.payload)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(s.expected_payload))
);
--> statement-breakpoint
WITH source AS (SELECT s.*, json_object('schema', 'tedix.work-observation.v1', 'kind', 'confirmation', 'record', json_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'principalType', s.principal_type, 'principalId', s.principal_id, 'sessionId', s.session_id, 'evidenceRef', s.evidence_ref, 'stance', s.stance, 'body', s.body, 'occurredAt', s.occurred_at, 'createdAt', s.created_at)) AS expected_payload FROM work_item_corroborations s)
INSERT INTO work_observation_removal_guard(reconciled)
SELECT NOT EXISTS (
 SELECT 1 FROM source s LEFT JOIN work_events e ON e.id = 'work-observation:confirmation:' || s.id
 WHERE e.id IS NULL OR e.org_id IS NOT s.org_id OR e.work_item_id IS NOT s.work_item_id
 OR e.event_type IS NOT 'work.observation_recorded' OR e.actor_type IS NOT 'system'
 OR e.actor_id IS NOT 'work-observation-migration' OR e.occurred_at IS NOT s.occurred_at
 OR EXISTS (SELECT fullkey, type, atom FROM json_tree(s.expected_payload)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(e.payload))
 OR EXISTS (SELECT fullkey, type, atom FROM json_tree(e.payload)
            EXCEPT SELECT fullkey, type, atom FROM json_tree(s.expected_payload))
);
--> statement-breakpoint
DROP TABLE work_observation_removal_guard;
--> statement-breakpoint
DROP TABLE `work_evidence_verifications`;
--> statement-breakpoint
DROP TABLE `work_item_corroborations`;
