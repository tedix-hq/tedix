-- Kernel request history and finished cron runs, moved by d1-retention.
CREATE TABLE "kernel_request_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" text NOT NULL,
	"created_at" text NOT NULL
);
CREATE UNIQUE INDEX "kernel_request_events_version_unique" ON "kernel_request_events" ("request_id", "version");
CREATE INDEX "kernel_request_events_created_idx" ON "kernel_request_events" ("created_at");
CREATE TABLE "platform_cron_executions" (
	"id" text PRIMARY KEY,
	"schedule_id" text NOT NULL,
	"cron" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"status" text NOT NULL DEFAULT 'running',
	"duration_ms" integer,
	"affected_row_counts" text NOT NULL,
	"error" text,
	"created_at" text NOT NULL
);
CREATE UNIQUE INDEX "idx_platform_cron_executions_fire" ON "platform_cron_executions" ("schedule_id", "scheduled_at");
CREATE INDEX "idx_platform_cron_executions_status_started" ON "platform_cron_executions" ("status", "started_at");
CREATE INDEX "idx_platform_cron_executions_created" ON "platform_cron_executions" ("created_at");
