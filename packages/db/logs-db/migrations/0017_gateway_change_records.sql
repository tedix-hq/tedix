-- Sealed gateway change records, moved by d1-retention in whole checkpoints.
CREATE TABLE "gateway_change_records" (
	"sequence" integer PRIMARY KEY,
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"resource" text NOT NULL,
	"actor_id" text NOT NULL,
	"recorded_at" text NOT NULL,
	"record" text NOT NULL,
	"record_digest" text,
	"chain_hash" text
);
CREATE UNIQUE INDEX "idx_gateway_change_records_id" ON "gateway_change_records" ("id");
CREATE INDEX "idx_gateway_change_records_org_sequence" ON "gateway_change_records" ("organization_id", "sequence");
CREATE INDEX "idx_gateway_change_records_org_recorded_at" ON "gateway_change_records" ("organization_id", "recorded_at");
CREATE INDEX "idx_gateway_change_records_recorded_at" ON "gateway_change_records" ("recorded_at");
CREATE INDEX "idx_gateway_change_records_unsealed" ON "gateway_change_records" ("organization_id", "sequence") WHERE chain_hash is null;
CREATE INDEX "idx_gateway_change_records_sealed" ON "gateway_change_records" ("organization_id", "sequence") WHERE chain_hash is not null;
