DROP INDEX "idx_provider_execution_authorized";
CREATE INDEX "idx_provider_execution_authorized" ON "provider_execution_attempts" ("authorized_at", "billing_reservation_id");
CREATE INDEX "idx_call_costs_reservation_health" ON "tedi_call_costs" ("billing_reservation_id", "success", "org_id", "gateway_log_id", "snapshot_at");
