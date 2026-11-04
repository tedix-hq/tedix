-- Mirrors the main migration that drops the 0004 audit_events metadata
-- indexes: on the main database they took about 400 MB and pushed it to its
-- 10 GB limit. The logs-only replacement is tracked on the audit Work Item.
DROP INDEX IF EXISTS "idx_audit_events_trace_timestamp";
DROP INDEX IF EXISTS "idx_audit_events_execution_timestamp";
DROP INDEX IF EXISTS "idx_audit_events_org_app_timestamp";
DROP INDEX IF EXISTS "idx_audit_events_org_actor_timestamp";
