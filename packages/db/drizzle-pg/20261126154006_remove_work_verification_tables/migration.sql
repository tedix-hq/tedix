-- tedix: destructive-reviewed Work-Item: 92b87d69-6105-4aef-b302-adbc4c698d5a
-- Operator preconditions: verified deployed event cutover; all organizations copied
-- and reconciled using the cutover revision; old writers stopped; recoverable backup
-- and separate production destructive authorization recorded on Work.
-- Missing or changed history aborts removal. Never bypass this reconciliation.

--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM work_evidence_verifications s LEFT JOIN work_events e ON e.id = 'work-observation:verification:' || s.id
  WHERE e.id IS NULL OR e.org_id IS DISTINCT FROM s.org_id OR e.work_item_id IS DISTINCT FROM s.work_item_id
 OR e.event_type IS DISTINCT FROM 'work.observation_recorded' OR e.actor_type IS DISTINCT FROM 'system'
 OR e.actor_id IS DISTINCT FROM 'work-observation-migration' OR e.occurred_at IS DISTINCT FROM s.observed_at
  OR e.payload IS DISTINCT FROM jsonb_build_object('schema', 'tedix.work-observation.v1', 'kind', 'verification', 'record', jsonb_build_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'evidenceId', s.evidence_id, 'source', s.source, 'verifierType', s.verifier_type, 'verifierId', s.verifier_id, 'claimed', s.claimed, 'observed', s.observed, 'matchesClaim', s.matches_claim, 'observedAt', s.observed_at))
 ) THEN RAISE EXCEPTION 'Work verification history is not reconciled; removal refused'; END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM work_item_corroborations s LEFT JOIN work_events e ON e.id = 'work-observation:confirmation:' || s.id
  WHERE e.id IS NULL OR e.org_id IS DISTINCT FROM s.org_id OR e.work_item_id IS DISTINCT FROM s.work_item_id
 OR e.event_type IS DISTINCT FROM 'work.observation_recorded' OR e.actor_type IS DISTINCT FROM 'system'
 OR e.actor_id IS DISTINCT FROM 'work-observation-migration' OR e.occurred_at IS DISTINCT FROM s.occurred_at
  OR e.payload IS DISTINCT FROM jsonb_build_object('schema', 'tedix.work-observation.v1', 'kind', 'confirmation', 'record', jsonb_build_object('id', s.id, 'orgId', s.org_id, 'workItemId', s.work_item_id, 'principalType', s.principal_type, 'principalId', s.principal_id, 'sessionId', s.session_id, 'evidenceRef', s.evidence_ref, 'stance', s.stance, 'body', s.body, 'occurredAt', s.occurred_at, 'createdAt', s.created_at))
 ) THEN RAISE EXCEPTION 'Work confirmation history is not reconciled; removal refused'; END IF;
END $$;
--> statement-breakpoint
DROP TABLE "work_evidence_verifications";
--> statement-breakpoint
DROP TABLE "work_item_corroborations";
