-- Mirrors main migration 20261023124403_d1_hot_query_indexes for the shared
-- tedi_runtime_events shape: the orphan-run sweep seeks `run.started` rows in
-- a time window across every tedi.
CREATE INDEX "idx_tedi_runtime_events_global_kind_created" ON "tedi_runtime_events" ("kind","created_at");
