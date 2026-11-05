-- These analytics lookup indexes belong only to the logs database. The main
-- database intentionally omits them to stay below D1's size limit.
CREATE INDEX "idx_audit_events_trace_timestamp" ON "audit_events" (json_extract("metadata", '$.traceId'), "timestamp");
CREATE INDEX "idx_audit_events_execution_timestamp" ON "audit_events" (json_extract("metadata", '$.executionId'), "timestamp");
CREATE INDEX "idx_audit_events_org_app_timestamp" ON "audit_events" ("organization_id", json_extract("metadata", '$.appId'), "timestamp");
CREATE INDEX "idx_audit_events_org_actor_timestamp" ON "audit_events" ("organization_id", "actor_id", "timestamp");
