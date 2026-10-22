-- Drizzle Kit rc.5 records column-level UNIQUE constraints that rc.4 omitted
-- from SQLite snapshots. Existing migrations already created these constraints;
-- this no-op advances the append-only snapshot ledger without changing schema.
SELECT 1;
