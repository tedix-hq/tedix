-- Attach rollback change capture at the D1 to Postgres switch.
-- Run after the final delta copy and before CORE_STORE=postgres takes traffic.
-- Every later insert, update and delete in the core schemas (public and
-- catalog) is recorded in cutover_changes for replay into D1 on rollback.
-- Safe to run again: each trigger is replaced. Partitions inherit the trigger
-- from their partitioned parent, so they are skipped here.
DO $attach$
DECLARE
	target regclass;
BEGIN
	FOR target IN
		SELECT c.oid::regclass
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname IN ('public', 'catalog')
			AND c.relkind IN ('r', 'p')
			AND NOT c.relispartition
			AND c.relname NOT IN ('cutover_changes', 'core_copy_migrations')
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS cutover_capture ON %s', target);
		EXECUTE format(
			'CREATE TRIGGER cutover_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION cutover_capture()',
			target
		);
	END LOOP;
END;
$attach$;
