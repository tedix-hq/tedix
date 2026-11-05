-- 0006 has not been applied. Build indexes on an empty shadow table;
-- advance audit_events_rebuild.cursor in bounded statements before 0007.
-- All writes to the original table are mirrored in the same transaction.
CREATE TABLE "audit_events_v2" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" text,
	"ip_address" text,
	"user_agent" text,
	"timestamp" integer NOT NULL
);
CREATE INDEX "idx_audit_events_org_timestamp_logs" ON "audit_events_v2" ("organization_id", "timestamp");
CREATE INDEX "idx_audit_events_timestamp_logs" ON "audit_events_v2" ("timestamp");
CREATE INDEX "idx_audit_events_resource_logs" ON "audit_events_v2" ("organization_id", "resource_type", "resource_id", "timestamp");
CREATE INDEX "idx_audit_events_trace_timestamp" ON "audit_events_v2" (json_extract("metadata", '$.traceId'), "timestamp");
CREATE INDEX "idx_audit_events_execution_timestamp" ON "audit_events_v2" (json_extract("metadata", '$.executionId'), "timestamp");
CREATE INDEX "idx_audit_events_org_app_timestamp" ON "audit_events_v2" ("organization_id", json_extract("metadata", '$.appId'), "timestamp");
CREATE INDEX "idx_audit_events_org_actor_timestamp" ON "audit_events_v2" ("organization_id", "actor_id", "timestamp");

CREATE TABLE audit_events_rebuild (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 cursor INTEGER NOT NULL,
 stop INTEGER NOT NULL,
 complete INTEGER NOT NULL DEFAULT 0 CHECK (complete = 0 OR cursor = stop)
);
INSERT INTO audit_events_rebuild(id, cursor, stop)
 SELECT 1, COALESCE((SELECT MIN(rowid) - 1 FROM audit_events), 0),
 COALESCE((SELECT MAX(rowid) FROM audit_events), 0);

CREATE TRIGGER audit_events_rebuild_insert AFTER INSERT ON audit_events BEGIN
 INSERT INTO audit_events_v2 (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, timestamp) VALUES (NEW.id, NEW.organization_id, NEW.actor_id, NEW.actor_type, NEW.action, NEW.resource_type, NEW.resource_id, NEW.metadata, NEW.ip_address, NEW.user_agent, NEW.timestamp);
END;
CREATE TRIGGER audit_events_rebuild_update AFTER UPDATE ON audit_events BEGIN
 DELETE FROM audit_events_v2 WHERE id = OLD.id;
 INSERT INTO audit_events_v2 (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, timestamp) VALUES (NEW.id, NEW.organization_id, NEW.actor_id, NEW.actor_type, NEW.action, NEW.resource_type, NEW.resource_id, NEW.metadata, NEW.ip_address, NEW.user_agent, NEW.timestamp);
END;
CREATE TRIGGER audit_events_rebuild_delete AFTER DELETE ON audit_events BEGIN
 DELETE FROM audit_events_v2 WHERE id = OLD.id;
END;
-- Cursor advancement and copying are one statement: a failed batch rolls both
-- back. The bound also prevents an accidental unbounded operator update.
CREATE TRIGGER audit_events_rebuild_copy AFTER UPDATE OF cursor ON audit_events_rebuild BEGIN
 SELECT CASE WHEN NEW.cursor < OLD.cursor OR NEW.cursor > OLD.stop
  OR NEW.cursor - OLD.cursor > 1000 THEN RAISE(ABORT, 'copy at most 1000 rowids') END;
 INSERT INTO audit_events_v2 (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, timestamp)
 SELECT id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, user_agent, timestamp FROM audit_events
 WHERE rowid > OLD.cursor AND rowid <= NEW.cursor
 ON CONFLICT(id) DO NOTHING;
END;
