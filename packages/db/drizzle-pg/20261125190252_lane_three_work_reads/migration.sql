-- Counts, guards and backfill install under one lock and transaction.
DO $install$
BEGIN
LOCK TABLE work_items, work_item_org_counts, work_cases, work_case_items, work_case_dependencies IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX idx_work_items_continuity_project ON work_items (org_id, project_id, id);
CREATE INDEX idx_work_items_continuity_objective ON work_items (org_id, objective_id, id);

DELETE FROM work_item_org_counts;
INSERT INTO work_item_org_counts (org_id, total)
SELECT org_id, count(*) FROM work_items GROUP BY org_id;

CREATE FUNCTION maintain_work_item_org_counts() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id THEN RETURN NULL; END IF;
 IF TG_OP IN ('DELETE', 'UPDATE') THEN
  UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
 END IF;
 IF TG_OP IN ('INSERT', 'UPDATE') THEN
  INSERT INTO work_item_org_counts (org_id,total) VALUES (NEW.org_id,1)
  ON CONFLICT (org_id) DO UPDATE SET total = work_item_org_counts.total + 1;
 END IF;
 RETURN NULL;
END;
$function$;
CREATE TRIGGER work_item_org_counts_change
AFTER INSERT OR DELETE OR UPDATE OF org_id ON work_items
FOR EACH ROW EXECUTE FUNCTION maintain_work_item_org_counts();

ALTER TABLE work_cases ADD CONSTRAINT chk_work_case_owner CHECK (length(accountable_owner_id) > 0);
ALTER TABLE work_case_dependencies ADD CONSTRAINT chk_work_case_dependency_not_self CHECK (prerequisite_case_id <> dependent_case_id);

CREATE FUNCTION enforce_work_case() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
 -- Serialize case transitions, membership and graph edits, including concurrent cycles.
 PERFORM 1 FROM organizations WHERE id=NEW.org_id FOR NO KEY UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.stage NOT IN ('investigating','planning','executing','monitoring') OR NEW.version<>1 OR NEW.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'invalid case initial state';
  END IF;
 ELSE
  IF OLD.stage='closed' THEN RAISE EXCEPTION 'closed case is terminal'; END IF;
  IF NEW.stage NOT IN ('investigating','planning','executing','monitoring','closed') OR NEW.version<>OLD.version+1
   OR NEW.id<>OLD.id OR NEW.org_id<>OLD.org_id OR (NEW.stage='closed')<>(NEW.closed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'invalid case transition';
  END IF;
 END IF;
 IF NOT (
  (NEW.accountable_owner_type='user' AND EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=NEW.org_id AND m.user_id=NEW.accountable_owner_id AND m.status='active')) OR
  (NEW.accountable_owner_type='tedi' AND EXISTS(SELECT 1 FROM tedis t WHERE t.organization_id=NEW.org_id AND t.id=NEW.accountable_owner_id AND t.retired_at IS NULL)) OR
  (NEW.accountable_owner_type='system' AND NEW.accountable_owner_id='tedix')
 ) THEN RAISE EXCEPTION 'invalid case owner'; END IF;
 IF NEW.objective_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tedi_objectives o WHERE o.org_id=NEW.org_id AND o.id=NEW.objective_id) THEN
  RAISE EXCEPTION 'cross-org case objective';
 END IF;
 IF TG_OP='UPDATE' AND NEW.stage='closed' AND EXISTS(
  SELECT 1 FROM work_case_items ci JOIN work_items wi ON wi.org_id=ci.org_id AND wi.id=ci.work_item_id
  WHERE ci.org_id=NEW.org_id AND ci.case_id=NEW.id AND wi.disposition NOT IN ('completed','cancelled')
 ) THEN RAISE EXCEPTION 'case has non-terminal work'; END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER work_case_owner_guard BEFORE INSERT OR UPDATE ON work_cases
FOR EACH ROW EXECUTE FUNCTION enforce_work_case();

CREATE FUNCTION enforce_work_case_item() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE scope_org text; scope_case text;
BEGIN
 IF TG_OP='DELETE' THEN scope_org:=OLD.org_id; scope_case:=OLD.case_id;
 ELSE scope_org:=NEW.org_id; scope_case:=NEW.case_id; END IF;
 PERFORM 1 FROM organizations WHERE id=scope_org FOR NO KEY UPDATE;
 IF EXISTS(SELECT 1 FROM work_cases c WHERE c.org_id=scope_org AND c.id=scope_case AND c.stage='closed') THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'closed case work links are retained';
  ELSE RAISE EXCEPTION 'closed case cannot accept work'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER work_case_item_guard BEFORE INSERT OR DELETE ON work_case_items
FOR EACH ROW EXECUTE FUNCTION enforce_work_case_item();

CREATE FUNCTION enforce_work_case_dependency() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE scope_org text; source_case text; target_case text;
BEGIN
 IF TG_OP='DELETE' THEN scope_org:=OLD.org_id; source_case:=OLD.prerequisite_case_id; target_case:=OLD.dependent_case_id;
 ELSE scope_org:=NEW.org_id; source_case:=NEW.prerequisite_case_id; target_case:=NEW.dependent_case_id; END IF;
 PERFORM 1 FROM organizations WHERE id=scope_org FOR NO KEY UPDATE;
 IF EXISTS(SELECT 1 FROM work_cases c WHERE c.org_id=scope_org AND c.id IN (source_case,target_case) AND c.stage='closed') THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'closed case dependencies are retained';
  ELSE RAISE EXCEPTION 'closed case cannot accept dependencies'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(
  WITH RECURSIVE reachable(id) AS (
   SELECT target_case
   UNION SELECT d.dependent_case_id FROM work_case_dependencies d JOIN reachable r ON d.prerequisite_case_id=r.id WHERE d.org_id=scope_org
  ) SELECT 1 FROM reachable WHERE id=source_case
 ) THEN RAISE EXCEPTION 'case dependency cycle'; END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER work_case_dependency_guard BEFORE INSERT OR DELETE ON work_case_dependencies
FOR EACH ROW EXECUTE FUNCTION enforce_work_case_dependency();
END;
$install$;
