-- Detach rollback change capture once D1 rollback is no longer needed, or
-- before a fresh copy into Postgres. Leaves cutover_changes and its rows in
-- place. Safe to run again: only existing cutover_capture triggers are dropped.
DO $detach$
DECLARE
	target regclass;
BEGIN
	FOR target IN
		SELECT t.tgrelid::regclass
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		WHERE t.tgname = 'cutover_capture'
			AND NOT t.tgisinternal
			AND NOT c.relispartition
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS cutover_capture ON %s', target);
	END LOOP;
END;
$detach$;
