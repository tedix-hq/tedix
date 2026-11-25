-- tedix: destructive-reviewed Work-Item: fc3b38ca-7426-4d8c-bac1-d5ab8f21521c
-- Deletes only derived timers. Canonical Work, Attempts and events are preserved.
--> statement-breakpoint
CREATE TRIGGER work_due_lane_stale_insert AFTER INSERT ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='lane-stale' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT a.org_id,'lane-stale',a.id,strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2),'pending','' FROM work_attempts a
WHERE (a.org_id=NEW.org_id AND a.id=NEW.id) AND (a.executor_type='external_agent' AND json_extract(a.metadata,'$.lane')=1 AND a.outcome IS NULL AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_lane_stale_update AFTER UPDATE ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='lane-stale' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT a.org_id,'lane-stale',a.id,strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2),'pending','' FROM work_attempts a
WHERE (a.org_id=NEW.org_id AND a.id=NEW.id) AND (a.executor_type='external_agent' AND json_extract(a.metadata,'$.lane')=1 AND a.outcome IS NULL AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_lane_stale_delete AFTER DELETE ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='lane-stale' AND object_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_due_outbound_review_insert AFTER INSERT ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='outbound-review' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'outbound-review',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.work_kind='outbound' AND w.disposition NOT IN ('completed','cancelled') AND json_extract(w.metadata,'$.outbound.status') IN ('reviewing','feedback')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_outbound_review_update AFTER UPDATE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='outbound-review' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'outbound-review',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.work_kind='outbound' AND w.disposition NOT IN ('completed','cancelled') AND json_extract(w.metadata,'$.outbound.status') IN ('reviewing','feedback')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_outbound_review_delete AFTER DELETE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='outbound-review' AND object_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_due_stale_delegation_insert AFTER INSERT ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='stale-delegation' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_stale_delegation_update AFTER UPDATE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='stale-delegation' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_stale_delegation_delete AFTER DELETE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='stale-delegation' AND object_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_due_uncontracted_child_insert AFTER INSERT ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='uncontracted-child' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_uncontracted_child_update AFTER UPDATE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='uncontracted-child' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_uncontracted_child_delete AFTER DELETE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='uncontracted-child' AND object_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_due_repository_observer_insert AFTER INSERT ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='repository-observer' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'repository-observer',w.id,iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline))),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.repository_observer=1 AND w.disposition IN ('proposed','accepted') AND (json_extract(w.metadata,'$.event.kind')='push' OR (json_extract(w.metadata,'$.event.kind')='ship_red' AND w.deadline IS NOT NULL AND json_extract(w.metadata,'$.observerEscalatedAt') IS NULL AND coalesce(json_extract(w.metadata,'$.latestReport.stillRed'),json_extract(w.metadata,'$.report.stillRed'),1)=1))) AND (iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline)))) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_repository_observer_update AFTER UPDATE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='repository-observer' AND object_id=NEW.id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'repository-observer',w.id,iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline))),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.id) AND (w.repository_observer=1 AND w.disposition IN ('proposed','accepted') AND (json_extract(w.metadata,'$.event.kind')='push' OR (json_extract(w.metadata,'$.event.kind')='ship_red' AND w.deadline IS NOT NULL AND json_extract(w.metadata,'$.observerEscalatedAt') IS NULL AND coalesce(json_extract(w.metadata,'$.latestReport.stillRed'),json_extract(w.metadata,'$.report.stillRed'),1)=1))) AND (iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline)))) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_repository_observer_delete AFTER DELETE ON work_items BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='repository-observer' AND object_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_due_maintenance_attempt_insert AFTER INSERT ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='stale-delegation' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='uncontracted-child' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_maintenance_attempt_update AFTER UPDATE ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='stale-delegation' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='uncontracted-child' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_maintenance_attempt_delete AFTER DELETE ON work_attempts BEGIN
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='stale-delegation' AND object_id=OLD.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (w.org_id=OLD.org_id AND w.id=OLD.work_item_id) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='uncontracted-child' AND object_id=OLD.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=OLD.org_id AND w.id=OLD.work_item_id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_maintenance_event_insert AFTER INSERT ON work_events BEGIN
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='uncontracted-child' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='outbound-review' AND object_id=NEW.work_item_id;
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'outbound-review',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0),'pending','' FROM work_items w
WHERE (w.org_id=NEW.org_id AND w.id=NEW.work_item_id) AND (w.work_kind='outbound' AND w.disposition NOT IN ('completed','cancelled') AND json_extract(w.metadata,'$.outbound.status') IN ('reviewing','feedback')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
CREATE TRIGGER work_due_outbound_policy_update AFTER UPDATE OF metadata ON organizations BEGIN
DELETE FROM work_due WHERE org_id=NEW.id AND kind='outbound-review';
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'outbound-review',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0),'pending','' FROM work_items w
WHERE (w.org_id=NEW.id) AND (w.work_kind='outbound' AND w.disposition NOT IN ('completed','cancelled') AND json_extract(w.metadata,'$.outbound.status') IN ('reviewing','feedback')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
END;
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT a.org_id,'lane-stale',a.id,strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2),'pending','' FROM work_attempts a
WHERE (1) AND (a.executor_type='external_agent' AND json_extract(a.metadata,'$.lane')=1 AND a.outcome IS NULL AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',(julianday(a.heartbeat_at)+julianday(a.expires_at))/2)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'outbound-review',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0),'pending','' FROM work_items w
WHERE (1) AND (w.work_kind='outbound' AND w.disposition NOT IN ('completed','cancelled') AND json_extract(w.metadata,'$.outbound.status') IN ('reviewing','feedback')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',julianday(coalesce(json_extract(w.metadata,'$.outbound.reviewRequestedAt'),(SELECT max(occurred_at) FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.event_type='outbound.action'),w.updated_at,w.created_at))+coalesce((SELECT json_extract(o.metadata,'$.outboundReview.reviewTimeoutMinutes') FROM organizations o WHERE o.id=w.org_id),30)/1440.0)) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'stale-delegation',w.id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days'),'pending','' FROM work_items w
WHERE (1) AND (w.disposition='accepted' AND json_extract(w.provenance,'$.source')='kernelRuntime.directDelegation' AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND (SELECT a.runtime_state FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1)='failed') AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(w.updated_at,w.created_at)),julianday((SELECT a.finished_at FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id ORDER BY a.attempt_number DESC LIMIT 1))),'+7 days')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'uncontracted-child',w.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending','' FROM work_items w
WHERE (1) AND (w.disposition IN ('accepted','proposed') AND w.delegation_root_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=w.org_id AND a.work_item_id=w.id AND a.runtime_state IN ('queued','running','waiting','retrying')) AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id=w.org_id AND e.work_item_id=w.id AND e.id=w.id AND json_type(e.payload,'$.taskContract')='object')) AND (strftime('%Y-%m-%dT%H:%M:%fZ','now')) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
SELECT w.org_id,'repository-observer',w.id,iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline))),'pending','' FROM work_items w
WHERE (1) AND (w.repository_observer=1 AND w.disposition IN ('proposed','accepted') AND (json_extract(w.metadata,'$.event.kind')='push' OR (json_extract(w.metadata,'$.event.kind')='ship_red' AND w.deadline IS NOT NULL AND json_extract(w.metadata,'$.observerEscalatedAt') IS NULL AND coalesce(json_extract(w.metadata,'$.latestReport.stillRed'),json_extract(w.metadata,'$.report.stillRed'),1)=1))) AND (iif(json_extract(w.metadata,'$.event.kind')='push',strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at,'+24 hours'),max(w.deadline,coalesce(json_extract(w.metadata,'$.observerRetryAt'),w.deadline)))) IS NOT NULL
ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
