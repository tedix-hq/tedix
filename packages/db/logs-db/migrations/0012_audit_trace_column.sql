ALTER TABLE "audit_events" ADD COLUMN "trace_id" text GENERATED ALWAYS AS (CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.traceId') END) VIRTUAL;
CREATE INDEX "idx_audit_events_trace_id_timestamp" ON "audit_events" ("trace_id", "timestamp");
