-- Worked port of WORK_ITEM_ORG_COUNT_TRIGGERS; not part of the core scaffold migration.
BEGIN;
-- Install and backfill under the same lock so no write can fall between them.
LOCK TABLE work_items IN SHARE ROW EXCLUSIVE MODE;
DELETE FROM work_item_org_counts;
INSERT INTO work_item_org_counts (org_id, total)
SELECT org_id, count(*) FROM work_items GROUP BY org_id;

CREATE FUNCTION maintain_work_item_org_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO work_item_org_counts (org_id, total) VALUES (NEW.org_id, 1)
    ON CONFLICT (org_id) DO UPDATE SET total = work_item_org_counts.total + 1;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER work_item_org_counts_change
AFTER INSERT OR DELETE OR UPDATE OF org_id ON work_items
FOR EACH ROW EXECUTE FUNCTION maintain_work_item_org_counts();
COMMIT;
