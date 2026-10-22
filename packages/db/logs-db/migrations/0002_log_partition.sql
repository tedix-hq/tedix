-- Logs database schema, rendered by scripts/logs-db-schema.ts.
-- Log tables without foreign keys, plus logs-local metadata.
CREATE TABLE "log_partition" (
	"id" text PRIMARY KEY,
	"state" text NOT NULL,
	"from_ts" text NOT NULL,
	"to_ts" text,
	"created_at" text NOT NULL
);
