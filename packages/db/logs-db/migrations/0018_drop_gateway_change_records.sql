-- The change ledger lives in each organization's log store, and the main
-- tables are dropped. This copy never received a row (checked empty on
-- both logs databases, 21 Nov 2026).
DROP TABLE IF EXISTS "gateway_change_records";
