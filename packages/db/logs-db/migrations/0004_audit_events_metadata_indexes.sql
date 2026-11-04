-- Mirrors the main migration that adds the audit_events metadata indexes for
-- queries/analytics-audit.ts: trace, execution, app and actor lookups walked
-- every tenant row in this store (1,679,000 rows read, 7 s, for one trace).
CREATE INDEX "idx_audit_events_trace_timestamp" ON "audit_events" (json_extract("metadata", '$.traceId'), "timestamp");
CREATE INDEX "idx_audit_events_execution_timestamp" ON "audit_events" (json_extract("metadata", '$.executionId'), "timestamp");
CREATE INDEX "idx_audit_events_org_app_timestamp" ON "audit_events" ("organization_id", json_extract("metadata", '$.appId'), "timestamp");
CREATE INDEX "idx_audit_events_org_actor_timestamp" ON "audit_events" ("organization_id", "actor_id", "timestamp");
