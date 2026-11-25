-- Interaction lifecycle guards and projections, including due and commitment wakes.
DO $install$
DECLARE row record;
BEGIN
 LOCK TABLE work_interactions,work_interaction_responses,work_interaction_reply_drafts,work_interaction_card_revisions IN SHARE ROW EXCLUSIVE MODE;
UPDATE work_interactions SET source=metadata->>'source',delegated_owner_id=metadata #>> '{delegatedApproval,ownerId}';
EXECUTE $definition$
CREATE FUNCTION work_interaction_store_projection_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 NEW.source := NEW.metadata->>'source';
 NEW.delegated_owner_id := NEW.metadata #>> '{delegatedApproval,ownerId}';
 RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_00_store_projection BEFORE INSERT OR UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_store_projection_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION card_revision_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'Card revisions are append-only' USING ERRCODE = '23514';
RETURN OLD;
END;
$body$;
CREATE TRIGGER card_revision_no_delete BEFORE DELETE ON work_interaction_card_revisions FOR EACH ROW EXECUTE FUNCTION card_revision_no_delete_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION card_revision_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'Card revisions are append-only' USING ERRCODE = '23514';
RETURN NEW;
END;
$body$;
CREATE TRIGGER card_revision_no_update BEFORE UPDATE ON work_interaction_card_revisions FOR EACH ROW EXECUTE FUNCTION card_revision_no_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION card_revision_projection_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.status='open' AND NEW.status='open' AND OLD.target_type='user'
 AND NEW.version=OLD.version+1
 AND (NEW.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}')
 AND ((NEW.metadata #>> '{cardRevision}'))::numeric=coalesce(((OLD.metadata #>> '{cardRevision}'))::numeric,1)+1
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id AND r.revision=((NEW.metadata #>> '{cardRevision}'))::numeric AND r.body=(NEW.metadata #>> '{cardContent}') AND ((r.proposal IS NULL AND (NEW.metadata #> '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #> '{proposal}')) OR (r.proposal IS NOT NULL AND (r.proposal)::jsonb IS NOT DISTINCT FROM ((NEW.metadata #> '{proposal}'))::jsonb)))) OR (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.creator_type='system' AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='open' AND NEW.version=OLD.version
 AND (NEW.metadata #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{followThrough}')
 AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=OLD.org_id AND r.interaction_id=OLD.id AND r.resolved_request_version=OLD.version AND (r.metadata #>> '{cardAction}')='ask_changes')) THEN
IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind<>OLD.kind OR NEW.subject<>OLD.subject OR NEW.prompt<>OLD.prompt OR NEW.creator_type<>OLD.creator_type OR NEW.creator_id<>OLD.creator_id OR NEW.creator_session_id IS DISTINCT FROM OLD.creator_session_id OR NEW.creator_external_session_key IS DISTINCT FROM OLD.creator_external_session_key OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
 RAISE EXCEPTION 'interaction immutable fields changed' USING ERRCODE = '23514';
 END IF;
IF NEW.resolution_fence IS DISTINCT FROM OLD.resolution_fence OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
 RAISE EXCEPTION 'card revision changed resolution state' USING ERRCODE = '23514';
 END IF;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER card_revision_projection_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION card_revision_projection_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION commitment_wake_outbox_interaction_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.status = 'open' AND (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) IS NOT NULL THEN
INSERT INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction:' || NEW.id || ':' || (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), 'commitment_wake', NEW.org_id, 'interaction', NEW.id,
  (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), to_char((((coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))::timestamptz + interval '+30 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER commitment_wake_outbox_interaction_insert AFTER INSERT ON work_interactions FOR EACH ROW EXECUTE FUNCTION commitment_wake_outbox_interaction_insert_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION commitment_wake_outbox_interaction_response_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.resolves_request = true AND (NEW.responded_at) IS NOT NULL THEN
INSERT INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction_response:' || NEW.id || ':' || (NEW.responded_at), 'commitment_wake', NEW.org_id, 'interaction_response', NEW.id,
  (NEW.responded_at), to_char((((NEW.responded_at))::timestamptz + interval '+30 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER commitment_wake_outbox_interaction_response_insert AFTER INSERT ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION commitment_wake_outbox_interaction_response_insert_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION commitment_wake_outbox_interaction_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.status = 'open' AND (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) IS NOT NULL THEN
INSERT INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction:' || NEW.id || ':' || (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), 'commitment_wake', NEW.org_id, 'interaction', NEW.id,
  (coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), to_char((((coalesce(NEW.due_at, to_char(((NEW.created_at)::timestamptz + interval '+2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))::timestamptz + interval '+30 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER commitment_wake_outbox_interaction_update AFTER UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION commitment_wake_outbox_interaction_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION deck_curation_projection_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.target_type='user' AND OLD.status IN ('open','cancelled') AND NEW.status IN ('open','cancelled')
 AND NEW.version=OLD.version+1
 AND (NEW.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}' #- '{curation}') IS NOT DISTINCT FROM (OLD.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}' #- '{curation}')
 AND ((NEW.metadata #>> '{cardRevision}'))::numeric=coalesce(((OLD.metadata #>> '{cardRevision}'))::numeric,1)+1
 AND (NEW.metadata #>> '{curation,schema}')='tedix.deck-curation.v1'
 AND (NEW.metadata #>> '{curation,status}')=NEW.status
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id
  AND r.revision=((NEW.metadata #>> '{cardRevision}'))::numeric AND r.body=(NEW.metadata #>> '{cardContent}')
  AND (r.instruction IS NOT NULL) AND (r.instruction)::jsonb=((NEW.metadata #> '{curation}'))::jsonb
  AND ((r.cause='agent_rewrite' AND OLD.status='open') OR (r.cause='restore' AND (OLD.metadata #>> '{curation,schema}')='tedix.deck-curation.v1'))
  AND ((r.proposal IS NULL AND (NEW.metadata #> '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #> '{proposal}')) OR (r.proposal IS NOT NULL AND (r.proposal)::jsonb IS NOT DISTINCT FROM ((NEW.metadata #> '{proposal}'))::jsonb))) THEN
IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind<>OLD.kind OR NEW.subject<>OLD.subject OR NEW.prompt<>OLD.prompt OR NEW.creator_type<>OLD.creator_type OR NEW.creator_id<>OLD.creator_id OR NEW.creator_session_id IS DISTINCT FROM OLD.creator_session_id OR NEW.creator_external_session_key IS DISTINCT FROM OLD.creator_external_session_key OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
 RAISE EXCEPTION 'interaction immutable fields changed' USING ERRCODE = '23514';
 END IF;
IF NEW.resolution_fence IS DISTINCT FROM OLD.resolution_fence OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.expired_at IS DISTINCT FROM OLD.expired_at OR (NEW.status='open' AND NEW.cancelled_at IS NOT NULL) OR (NEW.status='cancelled' AND NEW.cancelled_at IS NULL) THEN
 RAISE EXCEPTION 'curation changed decision state' USING ERRCODE = '23514';
 END IF;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER deck_curation_projection_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION deck_curation_projection_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_due_interaction_review_dispatch_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='interaction-review-dispatch' AND object_id=OLD.id;
RETURN OLD;
END;
$body$;
CREATE TRIGGER work_due_interaction_review_dispatch_delete AFTER DELETE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_due_interaction_review_dispatch_delete_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_due_interaction_review_dispatch_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='interaction-review-dispatch' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,(CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(((metadata #>> '{followThrough,reviewWakeVersion}'))::numeric,0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request = true OR (r.metadata #>> '{corrects}') IS NOT NULL)
				AND coalesce((r.metadata #>> '{delivery}'),'')<>'none'
				AND r.id IS DISTINCT FROM (work_interactions.metadata #>> '{followThrough,receipt,responseId}')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request = true OR (newer.metadata #>> '{corrects}') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.id) AND ((CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_due_interaction_review_dispatch_insert AFTER INSERT ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_due_interaction_review_dispatch_insert_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_due_interaction_review_dispatch_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='interaction-review-dispatch' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,(CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(((metadata #>> '{followThrough,reviewWakeVersion}'))::numeric,0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request = true OR (r.metadata #>> '{corrects}') IS NOT NULL)
				AND coalesce((r.metadata #>> '{delivery}'),'')<>'none'
				AND r.id IS DISTINCT FROM (work_interactions.metadata #>> '{followThrough,receipt,responseId}')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request = true OR (newer.metadata #>> '{corrects}') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.id) AND ((CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_due_interaction_review_dispatch_update AFTER UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_due_interaction_review_dispatch_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_due_review_response_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,(CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(((metadata #>> '{followThrough,reviewWakeVersion}'))::numeric,0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request = true OR (r.metadata #>> '{corrects}') IS NOT NULL)
				AND coalesce((r.metadata #>> '{delivery}'),'')<>'none'
				AND r.id IS DISTINCT FROM (work_interactions.metadata #>> '{followThrough,receipt,responseId}')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request = true OR (newer.metadata #>> '{corrects}') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.interaction_id AND org_id=NEW.org_id) AND ((CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_due_review_response_insert AFTER INSERT ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_due_review_response_insert_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_due_review_response_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,(CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(((metadata #>> '{followThrough,reviewWakeVersion}'))::numeric,0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request = true OR (r.metadata #>> '{corrects}') IS NOT NULL)
				AND coalesce((r.metadata #>> '{delivery}'),'')<>'none'
				AND r.id IS DISTINCT FROM (work_interactions.metadata #>> '{followThrough,receipt,responseId}')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request = true OR (newer.metadata #>> '{corrects}') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.interaction_id AND org_id=NEW.org_id) AND ((CASE WHEN status='open' THEN coalesce((metadata #>> '{followThrough,reviewAt}'),to_char(((created_at)::timestamptz + interval '+3 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE coalesce((metadata #>> '{followThrough,continuationRetryAt}'),to_char(((resolved_at)::timestamptz + interval '+5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_due_review_response_update AFTER UPDATE ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_due_review_response_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_delegate_creator_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF (NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id)
 AND (CASE jsonb_typeof((NEW.metadata #> '{delegatedApproval}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{delegatedApproval}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{delegatedApproval}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{delegatedApproval}')) END) IS NOT NULL
 AND NEW.target_type IN ('tedi','external_agent')
 AND NEW.target_id = OLD.creator_id THEN
RAISE EXCEPTION 'The card creator cannot be its delegate' USING ERRCODE = '23514';
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_delegate_creator_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_delegate_creator_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_delegation_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF (NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.metadata IS DISTINCT FROM OLD.metadata
) AND NOT (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND NEW.metadata IS DISTINCT FROM OLD.metadata
 AND OLD.target_type='user' AND OLD.creator_type IN ('tedi','external_agent')
 AND (NEW.metadata #- '{notification}' #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{notification}' #- '{followThrough}') OR (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.status='open' AND NEW.status='open' AND OLD.target_type='user'
 AND NEW.version=OLD.version+1
 AND (NEW.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}')
 AND ((NEW.metadata #>> '{cardRevision}'))::numeric=coalesce(((OLD.metadata #>> '{cardRevision}'))::numeric,1)+1
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id AND r.revision=((NEW.metadata #>> '{cardRevision}'))::numeric AND r.body=(NEW.metadata #>> '{cardContent}') AND ((r.proposal IS NULL AND (NEW.metadata #> '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #> '{proposal}')) OR (r.proposal IS NOT NULL AND (r.proposal)::jsonb IS NOT DISTINCT FROM ((NEW.metadata #> '{proposal}'))::jsonb)))) OR (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.creator_type='system' AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='open' AND NEW.version=OLD.version
 AND (NEW.metadata #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{followThrough}')
 AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=OLD.org_id AND r.interaction_id=OLD.id AND r.resolved_request_version=OLD.version AND (r.metadata #>> '{cardAction}')='ask_changes')))
 AND NOT (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND OLD.target_type='user' AND OLD.status IN ('open','cancelled') AND NEW.status IN ('open','cancelled')
 AND NEW.version=OLD.version+1
 AND (NEW.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}' #- '{curation}') IS NOT DISTINCT FROM (OLD.metadata #- '{cardContent}' #- '{cardRevision}' #- '{proposal}' #- '{curation}')
 AND ((NEW.metadata #>> '{cardRevision}'))::numeric=coalesce(((OLD.metadata #>> '{cardRevision}'))::numeric,1)+1
 AND (NEW.metadata #>> '{curation,schema}')='tedix.deck-curation.v1'
 AND (NEW.metadata #>> '{curation,status}')=NEW.status
 AND EXISTS (SELECT 1 FROM work_interaction_card_revisions r WHERE r.org_id=OLD.org_id AND r.request_id=OLD.id
  AND r.revision=((NEW.metadata #>> '{cardRevision}'))::numeric AND r.body=(NEW.metadata #>> '{cardContent}')
  AND (r.instruction IS NOT NULL) AND (r.instruction)::jsonb=((NEW.metadata #> '{curation}'))::jsonb
  AND ((r.cause='agent_rewrite' AND OLD.status='open') OR (r.cause='restore' AND (OLD.metadata #>> '{curation,schema}')='tedix.deck-curation.v1'))
  AND ((r.proposal IS NULL AND (NEW.metadata #> '{proposal}') IS NOT DISTINCT FROM (OLD.metadata #> '{proposal}')) OR (r.proposal IS NOT NULL AND (r.proposal)::jsonb IS NOT DISTINCT FROM ((NEW.metadata #> '{proposal}'))::jsonb))))
 AND NOT (NEW.id IS NOT DISTINCT FROM OLD.id
 AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
 AND NEW.work_item_id IS NOT DISTINCT FROM OLD.work_item_id
 AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
 AND NEW.kind IS NOT DISTINCT FROM OLD.kind
 AND NEW.subject IS NOT DISTINCT FROM OLD.subject
 AND NEW.prompt IS NOT DISTINCT FROM OLD.prompt
 AND NEW.creator_type IS NOT DISTINCT FROM OLD.creator_type
 AND NEW.creator_id IS NOT DISTINCT FROM OLD.creator_id
 AND NEW.creator_session_id IS NOT DISTINCT FROM OLD.creator_session_id
 AND NEW.creator_external_session_key IS NOT DISTINCT FROM OLD.creator_external_session_key
 AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
 AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
 AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
 AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
 AND OLD.target_type='user' AND OLD.status='open' AND NEW.status='expired'
 AND NEW.version=OLD.version+1
 AND NEW.resolution_fence IS NOT NULL AND NEW.resolution_fence IS DISTINCT FROM OLD.resolution_fence
 AND NEW.resolved_at IS NULL AND NEW.cancelled_at IS NULL
 AND NEW.expired_at=(NEW.metadata #>> '{supersession,at}')
 AND extract(epoch FROM (NEW.expired_at)::timestamptz)>=extract(epoch FROM (OLD.created_at)::timestamptz)
 AND (NEW.metadata #- '{supersession}') IS NOT DISTINCT FROM (OLD.metadata #- '{supersession}')
 AND (CASE jsonb_typeof((NEW.metadata #> '{supersession}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{supersession}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{supersession}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{supersession}')) END)='object'
 AND (CASE jsonb_typeof((NEW.metadata #> '{supersession,at}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{supersession,at}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{supersession,at}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{supersession,at}')) END)='text'
 AND (CASE jsonb_typeof((NEW.metadata #> '{supersession,supersededBy}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{supersession,supersededBy}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{supersession,supersededBy}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{supersession,supersededBy}')) END)='text'
 AND (NEW.metadata #>> '{supersession,reason}')='newer_support_draft'
 AND (CASE jsonb_typeof((OLD.metadata #> '{supportTicketId}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((OLD.metadata #> '{supportTicketId}'))::text WHEN 'number' THEN CASE WHEN ((OLD.metadata #> '{supportTicketId}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((OLD.metadata #> '{supportTicketId}')) END)='text'
 AND (CASE jsonb_typeof((OLD.metadata #> '{supportVersion}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((OLD.metadata #> '{supportVersion}'))::text WHEN 'number' THEN CASE WHEN ((OLD.metadata #> '{supportVersion}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((OLD.metadata #> '{supportVersion}')) END)='integer'
 AND ((OLD.metadata #>> '{source}')='support-draft' OR (
  (OLD.metadata #>> '{source}')='night-source-adapter'
  AND (OLD.metadata #>> '{originalSource}')='support-work-draft'
  AND (OLD.metadata #>> '{sourceKey}')='support-draft:' || (OLD.metadata #>> '{supportTicketId}') || ':' || ((OLD.metadata #>> '{supportVersion}'))::numeric
  AND (OLD.metadata #>> '{decisionDeck,classId}')='support.reply'
  AND (OLD.metadata #>> '{decisionDeck,kind}')='outbound'))
 AND EXISTS (SELECT 1 FROM work_interactions newer WHERE
  newer.id=(NEW.metadata #>> '{supersession,supersededBy}')
  AND newer.org_id=OLD.org_id AND newer.target_type=OLD.target_type AND newer.target_id=OLD.target_id
  AND (newer.metadata #>> '{source}')='support-draft'
  AND (newer.metadata #>> '{supportTicketId}')=(OLD.metadata #>> '{supportTicketId}')
  AND (CASE jsonb_typeof((newer.metadata #> '{supportVersion}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((newer.metadata #> '{supportVersion}'))::text WHEN 'number' THEN CASE WHEN ((newer.metadata #> '{supportVersion}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((newer.metadata #> '{supportVersion}')) END)='integer'
  AND ((newer.metadata #>> '{supportVersion}'))::numeric>((OLD.metadata #>> '{supportVersion}'))::numeric))
 AND NOT (NEW.id IS NOT DISTINCT FROM OLD.id
 AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
 AND NEW.work_item_id IS NOT DISTINCT FROM OLD.work_item_id
 AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
 AND NEW.kind IS NOT DISTINCT FROM OLD.kind
 AND NEW.status IS NOT DISTINCT FROM OLD.status
 AND NEW.subject IS NOT DISTINCT FROM OLD.subject
 AND NEW.prompt IS NOT DISTINCT FROM OLD.prompt
 AND NEW.creator_type IS NOT DISTINCT FROM OLD.creator_type
 AND NEW.creator_id IS NOT DISTINCT FROM OLD.creator_id
 AND NEW.creator_session_id IS NOT DISTINCT FROM OLD.creator_session_id
 AND NEW.creator_external_session_key IS NOT DISTINCT FROM OLD.creator_external_session_key
 AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
 AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
 AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
 AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence
 AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
 AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
 AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
 AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
 AND NEW.version IS NOT DISTINCT FROM OLD.version
 AND OLD.target_type='user' AND OLD.status='open'
 AND (NEW.metadata #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{followThrough}')
 AND (coalesce((NEW.metadata #> '{followThrough}'),'{}') #- '{snoozedUntil}') IS NOT DISTINCT FROM (coalesce((OLD.metadata #> '{followThrough}'),'{}') #- '{snoozedUntil}')
 AND (CASE jsonb_typeof((NEW.metadata #> '{followThrough,snoozedUntil}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{followThrough,snoozedUntil}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{followThrough,snoozedUntil}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{followThrough,snoozedUntil}')) END)='text'
 AND extract(epoch FROM ((NEW.metadata #>> '{followThrough,snoozedUntil}'))::timestamptz) IS NOT NULL)
 AND NOT (NEW.id IS NOT DISTINCT FROM OLD.id
 AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
 AND NEW.work_item_id IS NOT DISTINCT FROM OLD.work_item_id
 AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
 AND NEW.kind IS NOT DISTINCT FROM OLD.kind
 AND NEW.subject IS NOT DISTINCT FROM OLD.subject
 AND NEW.prompt IS NOT DISTINCT FROM OLD.prompt
 AND NEW.creator_type IS NOT DISTINCT FROM OLD.creator_type
 AND NEW.creator_id IS NOT DISTINCT FROM OLD.creator_id
 AND NEW.creator_session_id IS NOT DISTINCT FROM OLD.creator_session_id
 AND NEW.creator_external_session_key IS NOT DISTINCT FROM OLD.creator_external_session_key
 AND NEW.status IS NOT DISTINCT FROM OLD.status
 AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
 AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
 AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence
 AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
 AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
 AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
 AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
 AND OLD.kind='coordination' AND OLD.target_type='tedi' AND NEW.target_type='user'
 AND OLD.status='open' AND NEW.version=OLD.version+1
 AND (CASE jsonb_typeof((OLD.metadata #> '{ownershipRoute}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((OLD.metadata #> '{ownershipRoute}'))::text WHEN 'number' THEN CASE WHEN ((OLD.metadata #> '{ownershipRoute}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((OLD.metadata #> '{ownershipRoute}')) END) IS NULL
 AND (NEW.metadata #- '{ownershipRoute}') IS NOT DISTINCT FROM (OLD.metadata)::jsonb
 AND (NEW.metadata #>> '{ownershipRoute,fromTediId}') IS NOT DISTINCT FROM OLD.target_id
 AND (NEW.metadata #>> '{ownershipRoute,recipientId}') IS NOT DISTINCT FROM NEW.target_id
 AND EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=OLD.org_id AND w.id=OLD.work_item_id AND w.disposition='proposed'
  AND w.accountable_owner_id IS NULL AND w.steward_type='tedi' AND w.steward_id=OLD.target_id)
 AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=OLD.org_id AND m.user_id=NEW.target_id
  AND m.kind='human' AND m.status='active' AND m.role IN ('owner','admin')))
 AND NOT (NEW.id IS NOT DISTINCT FROM OLD.id
 AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
 AND NEW.work_item_id IS NOT DISTINCT FROM OLD.work_item_id
 AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
 AND NEW.kind IS NOT DISTINCT FROM OLD.kind
 AND NEW.subject IS NOT DISTINCT FROM OLD.subject
 AND NEW.prompt IS NOT DISTINCT FROM OLD.prompt
 AND NEW.creator_type IS NOT DISTINCT FROM OLD.creator_type
 AND NEW.creator_id IS NOT DISTINCT FROM OLD.creator_id
 AND NEW.creator_session_id IS NOT DISTINCT FROM OLD.creator_session_id
 AND NEW.creator_external_session_key IS NOT DISTINCT FROM OLD.creator_external_session_key
 AND NEW.status IS NOT DISTINCT FROM OLD.status
 AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
 AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
 AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence
 AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
 AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
 AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
 AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
 AND OLD.target_type='user' AND OLD.status='open' AND NEW.version=OLD.version+1
 AND NEW.target_type IN ('tedi','external_agent')
 AND (CASE jsonb_typeof((OLD.metadata #> '{delegatedApproval}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((OLD.metadata #> '{delegatedApproval}'))::text WHEN 'number' THEN CASE WHEN ((OLD.metadata #> '{delegatedApproval}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((OLD.metadata #> '{delegatedApproval}')) END) IS NULL
 AND (NEW.metadata #- '{delegatedApproval}') IS NOT DISTINCT FROM (OLD.metadata)::jsonb
 AND (NEW.metadata #>> '{delegatedApproval,ownerId}') IS NOT DISTINCT FROM OLD.target_id
 AND (NEW.metadata #>> '{delegatedApproval,actorType}') IS NOT DISTINCT FROM NEW.target_type
 AND (NEW.metadata #>> '{delegatedApproval,actorId}') IS NOT DISTINCT FROM NEW.target_id
 AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=OLD.org_id AND (CASE (o.metadata #>> '{delegatedApprovals,enabled}') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)=1
  AND ((NEW.target_type='tedi' AND EXISTS (SELECT 1 FROM tedis t WHERE t.organization_id=OLD.org_id AND t.id=NEW.target_id AND t.owner_user_id=OLD.target_id AND t.status='active' AND t.retired_at IS NULL))
   OR (NEW.target_type='external_agent' AND EXISTS (SELECT 1 FROM jsonb_each_text(o.metadata #> '{delegatedApprovals,leadAgents}') lead JOIN external_agent_principals a ON a.organization_id=OLD.org_id AND a.id=lead.value AND a.status='active' WHERE lead.key=OLD.target_id AND lead.value=NEW.target_id))))
 AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=OLD.org_id AND m.user_id=OLD.target_id AND m.status='active'))
 AND NOT (NEW.id IS NOT DISTINCT FROM OLD.id
 AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
 AND NEW.work_item_id IS NOT DISTINCT FROM OLD.work_item_id
 AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
 AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
 AND NEW.kind IS NOT DISTINCT FROM OLD.kind
 AND NEW.subject IS NOT DISTINCT FROM OLD.subject
 AND NEW.prompt IS NOT DISTINCT FROM OLD.prompt
 AND NEW.creator_type IS NOT DISTINCT FROM OLD.creator_type
 AND NEW.creator_id IS NOT DISTINCT FROM OLD.creator_id
 AND NEW.creator_session_id IS NOT DISTINCT FROM OLD.creator_session_id
 AND NEW.creator_external_session_key IS NOT DISTINCT FROM OLD.creator_external_session_key
 AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
 AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND NEW.status IS NOT DISTINCT FROM OLD.status
 AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at
 AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
 AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence
 AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
 AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at
 AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
 AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
 AND NEW.version IS NOT DISTINCT FROM OLD.version
 AND OLD.target_type='user' AND OLD.status IN ('open','resolved')
 AND OLD.creator_type IN ('user','system')
 AND (NEW.metadata #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{followThrough}')
 AND (coalesce((NEW.metadata #> '{followThrough}'),'{}') #- '{reviewWakeVersion}' #- '{reviewRunId}' #- '{continuationWakeAt}' #- '{continuationRunId}' #- '{continuationRetryAt}')
 IS NOT DISTINCT FROM (coalesce((OLD.metadata #> '{followThrough}'),'{}') #- '{reviewWakeVersion}' #- '{reviewRunId}' #- '{continuationWakeAt}' #- '{continuationRunId}' #- '{continuationRetryAt}')) THEN
IF OLD.kind<>'question' OR OLD.status<>'open' OR NEW.status<>'open' OR
  OLD.target_type<>'user' OR NEW.target_type<>'tedi' OR NEW.version<>OLD.version+1 OR
  NEW.resolution_fence IS DISTINCT FROM OLD.resolution_fence OR
  NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.expired_at IS DISTINCT FROM OLD.expired_at OR
  (CASE jsonb_typeof((OLD.metadata #> '{delegation}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((OLD.metadata #> '{delegation}'))::text WHEN 'number' THEN CASE WHEN ((OLD.metadata #> '{delegation}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((OLD.metadata #> '{delegation}')) END) IS NOT NULL OR
  (CASE jsonb_typeof((NEW.metadata #> '{delegation}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{delegation}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{delegation}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{delegation}')) END) IS DISTINCT FROM 'object' OR
  (NEW.metadata #>> '{delegation,fromType}') IS DISTINCT FROM 'user' OR
  (NEW.metadata #>> '{delegation,fromId}') IS DISTINCT FROM OLD.target_id OR
  (NEW.metadata #>> '{delegation,toTediId}') IS DISTINCT FROM NEW.target_id OR
  (CASE jsonb_typeof((NEW.metadata #> '{delegation,delegatedAt}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((NEW.metadata #> '{delegation,delegatedAt}'))::text WHEN 'number' THEN CASE WHEN ((NEW.metadata #> '{delegation,delegatedAt}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((NEW.metadata #> '{delegation,delegatedAt}')) END) IS DISTINCT FROM 'text' OR
  extract(epoch FROM ((NEW.metadata #>> '{delegation,delegatedAt}'))::timestamptz) IS NULL OR
  (NEW.metadata #>> '{delegation,delegatedAt}')<OLD.created_at OR
  (OLD.expires_at IS NOT NULL AND OLD.expires_at<=(NEW.metadata #>> '{delegation,delegatedAt}')) OR
  (NEW.metadata #- '{delegation}')<>(OLD.metadata)::jsonb OR
  NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=OLD.org_id AND m.user_id=OLD.target_id AND m.status='active') OR
  NOT EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.target_id AND t.status='active' AND t.retired_at IS NULL) THEN
 RAISE EXCEPTION 'invalid interaction delegation' USING ERRCODE = '23514';
 END IF;
IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind<>OLD.kind OR NEW.subject<>OLD.subject OR NEW.prompt<>OLD.prompt OR NEW.creator_type<>OLD.creator_type OR NEW.creator_id<>OLD.creator_id OR NEW.creator_session_id IS DISTINCT FROM OLD.creator_session_id OR NEW.creator_external_session_key IS DISTINCT FROM OLD.creator_external_session_key OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
 RAISE EXCEPTION 'interaction immutable fields changed' USING ERRCODE = '23514';
 END IF;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_delegation_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_delegation_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'interactions are retained' USING ERRCODE = '23514';
RETURN OLD;
END;
$body$;
CREATE TRIGGER work_interaction_delete_guard BEFORE DELETE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_delete_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_follow_through_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF (NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
 AND NEW.metadata IS DISTINCT FROM OLD.metadata
 AND OLD.target_type='user' AND OLD.creator_type IN ('tedi','external_agent')
 AND (NEW.metadata #- '{notification}' #- '{followThrough}') IS NOT DISTINCT FROM (OLD.metadata #- '{notification}' #- '{followThrough}')) THEN
IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind<>OLD.kind OR NEW.subject<>OLD.subject OR NEW.prompt<>OLD.prompt OR NEW.creator_type<>OLD.creator_type OR NEW.creator_id<>OLD.creator_id OR NEW.creator_session_id IS DISTINCT FROM OLD.creator_session_id OR NEW.creator_external_session_key IS DISTINCT FROM OLD.creator_external_session_key OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
 RAISE EXCEPTION 'interaction immutable fields changed' USING ERRCODE = '23514';
 END IF;
IF NOT (
  (OLD.status IN ('open','resolved') AND NEW.status IS NOT DISTINCT FROM OLD.status
   AND NEW.version IN (OLD.version,OLD.version+1)
   AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence
   AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at)
  OR (OLD.status='open' AND NEW.status='cancelled' AND NEW.version=OLD.version+1
   AND NEW.resolution_fence IS NOT NULL AND NEW.resolved_at IS NULL AND NEW.expired_at IS NULL AND NEW.cancelled_at IS NOT NULL)
 ) THEN
 RAISE EXCEPTION 'invalid interaction maintenance transition' USING ERRCODE = '23514';
 END IF;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_follow_through_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_follow_through_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.kind NOT IN ('question','input','handoff','coordination') OR (NEW.target_type IS NULL)<>(NEW.target_id IS NULL) OR NEW.status<>'open' OR NEW.version<>1 OR NEW.resolution_fence IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expired_at IS NOT NULL THEN
 RAISE EXCEPTION 'invalid interaction initial state' USING ERRCODE = '23514';
 END IF;
IF NEW.target_type IS NOT NULL AND NOT (
		(NEW.target_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.target_id AND m.status='active')) OR
		(NEW.target_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.target_id AND t.retired_at IS NULL)) OR
		(NEW.target_type='external_agent' AND EXISTS(SELECT 1 FROM external_agent_principals p WHERE p.organization_id=NEW.org_id AND p.id=NEW.target_id AND p.status='active'))
	) THEN
 RAISE EXCEPTION 'invalid interaction target' USING ERRCODE = '23514';
 END IF;
IF NOT (
		(NEW.creator_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.creator_id AND m.status='active')) OR
		(NEW.creator_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.creator_id AND t.retired_at IS NULL)) OR
		(NEW.creator_type='external_agent' AND EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.creator_id AND s.id=NEW.creator_session_id AND s.external_session_key=NEW.creator_external_session_key AND s.status='active' AND p.status='active')) OR
		(NEW.creator_type='system' AND NEW.creator_id='tedix')
	) THEN
 RAISE EXCEPTION 'invalid interaction creator' USING ERRCODE = '23514';
 END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_insert_guard BEFORE INSERT ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_insert_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_reply_draft_immutable_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'reply drafts are immutable' USING ERRCODE = '23514';
RETURN OLD;
END;
$body$;
CREATE TRIGGER work_interaction_reply_draft_immutable_delete BEFORE DELETE ON work_interaction_reply_drafts FOR EACH ROW EXECUTE FUNCTION work_interaction_reply_draft_immutable_delete_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_reply_draft_immutable_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'reply drafts are immutable' USING ERRCODE = '23514';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_reply_draft_immutable_update BEFORE UPDATE ON work_interaction_reply_drafts FOR EACH ROW EXECUTE FUNCTION work_interaction_reply_draft_immutable_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_reply_draft_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NEW.drafter_type<>'tedi' OR length(NEW.id)=0 OR extract(epoch FROM (NEW.created_at)::timestamptz) IS NULL THEN
 RAISE EXCEPTION 'invalid reply draft state' USING ERRCODE = '23514';
 END IF;
IF NOT EXISTS(
  SELECT 1 FROM work_interactions i WHERE i.org_id=NEW.org_id AND i.id=NEW.interaction_id AND
   i.status='open' AND i.kind='question' AND i.target_type='user' AND i.target_id IS NOT NULL AND
   i.created_at<=NEW.created_at AND (i.expires_at IS NULL OR i.expires_at>NEW.created_at) AND
   (i.metadata #>> '{schema}') IS NOT DISTINCT FROM 'tedix.decision-capture.v1' AND
   (i.metadata #>> '{triage,status}') IS NOT DISTINCT FROM 'ok' AND
   (i.metadata #>> '{triage,urgency}') IS NOT DISTINCT FROM 'later' AND
   ((CASE jsonb_typeof((i.metadata #> '{triage,urgentLabels}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((i.metadata #> '{triage,urgentLabels}'))::text WHEN 'number' THEN CASE WHEN ((i.metadata #> '{triage,urgentLabels}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((i.metadata #> '{triage,urgentLabels}')) END) IS NULL OR ((CASE jsonb_typeof((i.metadata #> '{triage,urgentLabels}')) WHEN 'string' THEN 'text' WHEN 'boolean' THEN ((i.metadata #> '{triage,urgentLabels}'))::text WHEN 'number' THEN CASE WHEN ((i.metadata #> '{triage,urgentLabels}'))::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof((i.metadata #> '{triage,urgentLabels}')) END)='array' AND jsonb_array_length(i.metadata #> '{triage,urgentLabels}')=0))) THEN
 RAISE EXCEPTION 'reply draft request is not an open quiet human question' USING ERRCODE = '23514';
 END IF;
IF NOT EXISTS(
  SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.drafter_id AND t.status='active' AND t.retired_at IS NULL) THEN
 RAISE EXCEPTION 'reply drafter is not an active tedi in the organization' USING ERRCODE = '23514';
 END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_reply_draft_insert_guard BEFORE INSERT ON work_interaction_reply_drafts FOR EACH ROW EXECUTE FUNCTION work_interaction_reply_draft_insert_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_response_apply_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
UPDATE work_interactions SET status='resolved', resolved_at=NEW.responded_at, resolution_fence=NEW.resolution_fence, version=NEW.resolved_request_version
	WHERE NEW.resolves_request = true AND org_id=NEW.org_id AND id=NEW.interaction_id AND status='open' AND version+1=NEW.resolved_request_version;
UPDATE work_interactions SET status='open', resolved_at=NULL, resolution_fence=NEW.resolution_fence, version=NEW.resolved_request_version
	WHERE NEW.resolves_request = false AND org_id=NEW.org_id AND id=NEW.interaction_id AND status='open' AND version+1=NEW.resolved_request_version;
UPDATE work_interactions SET version=NEW.resolved_request_version
	WHERE NEW.resolves_request = false AND org_id=NEW.org_id AND id=NEW.interaction_id AND status='resolved' AND version+1=NEW.resolved_request_version;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_response_apply AFTER INSERT ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_response_apply_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_response_immutable_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'interaction responses are immutable' USING ERRCODE = '23514';
RETURN OLD;
END;
$body$;
CREATE TRIGGER work_interaction_response_immutable_delete BEFORE DELETE ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_response_immutable_delete_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_response_immutable_update_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
RAISE EXCEPTION 'interaction responses are immutable' USING ERRCODE = '23514';
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_response_immutable_update BEFORE UPDATE ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_response_immutable_update_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_response_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
PERFORM 1 FROM work_interactions WHERE org_id=NEW.org_id AND id=NEW.interaction_id FOR UPDATE;
IF NEW.responder_type NOT IN ('user','tedi','external_agent') OR NEW.response_kind NOT IN ('answer','input_provided','handoff_accepted','handoff_declined','coordination_update') OR NEW.resolves_request NOT IN (false,true) OR length(NEW.resolution_fence)=0 THEN
 RAISE EXCEPTION 'invalid interaction response state' USING ERRCODE = '23514';
 END IF;
IF EXISTS(SELECT 1 FROM work_interaction_responses prior WHERE prior.interaction_id=NEW.interaction_id AND prior.resolved_request_version=NEW.resolved_request_version) THEN
 RAISE EXCEPTION 'interaction response lost resolution race' USING ERRCODE = '23514';
 END IF;
IF NOT EXISTS(
		SELECT 1 FROM work_interactions request WHERE request.org_id=NEW.org_id AND request.id=NEW.interaction_id AND request.version+1=NEW.resolved_request_version AND (
			(request.status='open' AND (request.expires_at IS NULL OR request.expires_at>NEW.responded_at) AND (request.target_type IS NULL OR (request.target_type=NEW.responder_type AND request.target_id=NEW.responder_id)))
			OR
			(request.status='open' AND (request.expires_at IS NULL OR request.expires_at>NEW.responded_at) AND request.kind='question' AND request.target_type='user' AND NEW.responder_type='tedi' AND NEW.resolves_request = true AND (NEW.metadata #>> '{draftOutcome}')='auto' AND EXISTS(
				SELECT 1 FROM work_interaction_reply_drafts d WHERE d.org_id=NEW.org_id AND d.interaction_id=NEW.interaction_id AND d.id=(NEW.metadata #>> '{draftId}') AND d.drafter_type='tedi' AND d.drafter_id=NEW.responder_id AND d.delivery='auto'
			))
			OR
			(request.status='resolved' AND request.kind='question' AND request.target_type='user' AND NEW.responder_type='user' AND request.target_id=NEW.responder_id AND NEW.resolves_request = false AND EXISTS(
				SELECT 1 FROM work_interaction_responses auto WHERE auto.org_id=request.org_id AND auto.interaction_id=request.id AND auto.resolves_request = true AND auto.responder_type='tedi' AND (auto.metadata #>> '{draftOutcome}')='auto' AND auto.id=(NEW.metadata #>> '{corrects}')
			))
		)
	) THEN
 RAISE EXCEPTION 'interaction response is stale or unauthorized' USING ERRCODE = '23514';
 END IF;
IF NOT EXISTS(
		SELECT 1 FROM work_interactions request WHERE request.org_id=NEW.org_id AND request.id=NEW.interaction_id AND (
			(request.kind='question' AND NEW.response_kind='answer') OR (request.kind='input' AND NEW.response_kind='input_provided') OR
			(request.kind='handoff' AND NEW.response_kind IN ('handoff_accepted','handoff_declined')) OR (request.kind='coordination' AND NEW.response_kind='coordination_update')
		)
	) THEN
 RAISE EXCEPTION 'interaction response kind does not match request' USING ERRCODE = '23514';
 END IF;
IF NOT (
		(NEW.responder_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.responder_id AND m.status='active')) OR
		(NEW.responder_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.responder_id AND t.retired_at IS NULL)) OR
		(NEW.responder_type='external_agent' AND EXISTS(SELECT 1 FROM external_agent_sessions s JOIN external_agent_principals p ON p.organization_id=s.organization_id AND p.id=s.principal_id WHERE s.organization_id=NEW.org_id AND s.principal_id=NEW.responder_id AND s.id=NEW.responder_session_id AND s.external_session_key=NEW.responder_external_session_key AND s.status='active' AND p.status='active'))
	) THEN
 RAISE EXCEPTION 'invalid response actor' USING ERRCODE = '23514';
 END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_response_insert_guard BEFORE INSERT ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_response_insert_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION work_interaction_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
IF NOT (NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
IF OLD.status='open' AND (NEW.status NOT IN ('open','resolved','cancelled','expired') OR NEW.version<>OLD.version+1 OR NEW.resolution_fence IS NULL OR
		(NEW.status='open' AND (NEW.resolved_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expired_at IS NOT NULL)) OR
		(NEW.status='resolved' AND (NEW.resolved_at IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expired_at IS NOT NULL)) OR
		(NEW.status='cancelled' AND (NEW.resolved_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.expired_at IS NOT NULL)) OR
		(NEW.status='expired' AND (NEW.resolved_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expired_at IS NULL))) THEN
 RAISE EXCEPTION 'invalid interaction transition' USING ERRCODE = '23514';
 END IF;
IF OLD.status<>'open' AND NOT (
		OLD.status='resolved' AND NEW.status='resolved' AND NEW.version=OLD.version+1 AND NEW.resolution_fence IS NOT DISTINCT FROM OLD.resolution_fence AND NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at AND NEW.cancelled_at IS NULL AND NEW.expired_at IS NULL AND
		EXISTS(SELECT 1 FROM work_interaction_responses r WHERE r.org_id=NEW.org_id AND r.interaction_id=NEW.id AND r.resolved_request_version=NEW.version AND r.resolves_request = false AND r.responder_type='user' AND (r.metadata #>> '{corrects}') IS NOT NULL)
	) THEN
 RAISE EXCEPTION 'invalid interaction transition' USING ERRCODE = '23514';
 END IF;
IF NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind<>OLD.kind OR NEW.subject<>OLD.subject OR NEW.prompt<>OLD.prompt OR NEW.creator_type<>OLD.creator_type OR NEW.creator_id<>OLD.creator_id OR NEW.creator_session_id IS DISTINCT FROM OLD.creator_session_id OR NEW.creator_external_session_key IS DISTINCT FROM OLD.creator_external_session_key OR NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at<>OLD.created_at OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
 RAISE EXCEPTION 'interaction immutable fields changed' USING ERRCODE = '23514';
 END IF;
IF OLD.status='open' AND NEW.status IN ('open','resolved') AND NOT EXISTS(SELECT 1 FROM work_interaction_responses r WHERE r.org_id=NEW.org_id AND r.interaction_id=NEW.id AND r.resolved_request_version=NEW.version AND r.resolution_fence=NEW.resolution_fence AND ((NEW.status='resolved' AND r.resolves_request = true) OR (NEW.status='open' AND r.resolves_request = false))) THEN
 RAISE EXCEPTION 'interaction response receipt missing' USING ERRCODE = '23514';
 END IF;
END IF;
RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_update_guard BEFORE UPDATE ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_update_guard_fn();
$definition$;
EXECUTE $definition$
CREATE FUNCTION refresh_work_interaction_decision_history(p_org text, p_id text) RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
 DELETE FROM work_interaction_decision_history WHERE org_id=p_org AND interaction_id=p_id;
 INSERT INTO work_interaction_decision_history(org_id,interaction_id,response_id,target_type,target_id,relation_key,responded_at)
 SELECT i.org_id,i.id,a.id,i.target_type,i.target_id,jsonb_build_array('work',i.work_item_id)::text,a.responded_at
 FROM work_interactions i JOIN work_interaction_responses a ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request
 WHERE i.org_id=p_org AND i.id=p_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL AND i.work_item_id IS NOT NULL
 UNION
 SELECT i.org_id,i.id,a.id,i.target_type,i.target_id,jsonb_build_array('source',s.value->>'kind',s.value->>'id',s.value->>'tediId')::text,a.responded_at
 FROM work_interactions i JOIN work_interaction_responses a ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request
 CROSS JOIN LATERAL (SELECT coalesce(nullif(i.metadata->'decisionSources','null'::jsonb),i.metadata #> '{decisionDeck,sources}')) sources(value)
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sources.value)='array' THEN sources.value ELSE '[]'::jsonb END) s(value)
 WHERE i.org_id=p_org AND i.id=p_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL AND s.value->>'kind' IS NOT NULL AND s.value->>'id' IS NOT NULL;
END;
$body$;
CREATE FUNCTION work_interaction_decision_history_fn() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_TABLE_NAME='work_interactions' THEN
  DELETE FROM work_interaction_decision_history WHERE org_id=OLD.org_id AND interaction_id=OLD.id;
  PERFORM refresh_work_interaction_decision_history(NEW.org_id,NEW.id);
 ELSE
  IF TG_OP='UPDATE' THEN DELETE FROM work_interaction_decision_history WHERE response_id=OLD.id; END IF;
  PERFORM refresh_work_interaction_decision_history(NEW.org_id,NEW.interaction_id);
 END IF;
 RETURN NEW;
END;
$body$;
CREATE TRIGGER work_interaction_decision_history_request_update AFTER UPDATE OF org_id,id,work_item_id,target_type,target_id,status,metadata ON work_interactions FOR EACH ROW EXECUTE FUNCTION work_interaction_decision_history_fn();
CREATE TRIGGER work_interaction_decision_history_response_insert AFTER INSERT ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_decision_history_fn();
CREATE TRIGGER work_interaction_decision_history_response_update AFTER UPDATE OF org_id,id,interaction_id,resolves_request,responded_at ON work_interaction_responses FOR EACH ROW EXECUTE FUNCTION work_interaction_decision_history_fn();
$definition$;
DELETE FROM work_interaction_decision_history;
FOR row IN SELECT org_id,id FROM work_interactions WHERE status='resolved' LOOP
 PERFORM refresh_work_interaction_decision_history(row.org_id,row.id);
END LOOP;
END;
$install$;
