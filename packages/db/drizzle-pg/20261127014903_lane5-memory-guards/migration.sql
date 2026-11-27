-- Install entity guards and rebuild citation links without racing canonical writes.
DO $install$
BEGIN
LOCK TABLE memory_facts, memory_fact_citations, memory_entities, memory_entity_aliases, memory_entity_mentions, memory_entity_resolution_decisions, memory_entity_resolution_heads, memory_entity_resolutions IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION emit_memory_entities_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NEW.organization_id != OLD.organization_id THEN
RAISE EXCEPTION 'memory entity organization is immutable';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entities_org_immutable BEFORE UPDATE OF organization_id ON memory_entities FOR EACH ROW EXECUTE FUNCTION emit_memory_entities_org_immutable();

CREATE FUNCTION emit_memory_entity_aliases_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NEW.organization_id != OLD.organization_id THEN
RAISE EXCEPTION 'memory entity alias organization is immutable';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_aliases_org_immutable BEFORE UPDATE OF organization_id ON memory_entity_aliases FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_aliases_org_immutable();

CREATE FUNCTION emit_memory_entity_mentions_no_update() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'memory_entity_mentions are immutable';
END;
$function$;
CREATE TRIGGER memory_entity_mentions_no_update BEFORE UPDATE ON memory_entity_mentions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_mentions_no_update();

CREATE FUNCTION emit_memory_entity_mentions_no_delete() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'memory_entity_mentions are immutable';
END;
$function$;
CREATE TRIGGER memory_entity_mentions_no_delete BEFORE DELETE ON memory_entity_mentions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_mentions_no_delete();

CREATE FUNCTION emit_memory_entity_decisions_terminal_no_update() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF OLD.status IN ('accepted', 'rejected') THEN
RAISE EXCEPTION 'terminal entity resolution decisions are immutable';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_decisions_terminal_no_update BEFORE UPDATE ON memory_entity_resolution_decisions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_decisions_terminal_no_update();

CREATE FUNCTION emit_memory_entity_decisions_terminal_no_delete() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF OLD.status IN ('accepted', 'rejected') THEN
RAISE EXCEPTION 'terminal entity resolution decisions are immutable';
END IF;
RETURN OLD;
END;
$function$;
CREATE TRIGGER memory_entity_decisions_terminal_no_delete BEFORE DELETE ON memory_entity_resolution_decisions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_decisions_terminal_no_delete();

CREATE FUNCTION emit_memory_entity_decisions_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NEW.organization_id != OLD.organization_id THEN
RAISE EXCEPTION 'entity resolution decision organization is immutable';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_decisions_org_immutable BEFORE UPDATE OF organization_id ON memory_entity_resolution_decisions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_decisions_org_immutable();

CREATE FUNCTION emit_memory_entity_heads_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NEW.organization_id != OLD.organization_id THEN
RAISE EXCEPTION 'entity resolution head organization is immutable';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_heads_org_immutable BEFORE UPDATE OF organization_id ON memory_entity_resolution_heads FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_heads_org_immutable();

CREATE FUNCTION emit_memory_entity_resolution_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NOT EXISTS (
			SELECT 1
			FROM memory_entity_resolution_decisions d
			JOIN memory_entity_resolution_heads h
			  ON h.organization_id = d.organization_id
			 AND h.mention_id = d.mention_id
			WHERE d.id = NEW.decision_id
			  AND d.organization_id = NEW.organization_id
			  AND d.mention_id = NEW.mention_id
			  AND d.status = 'accepted'
			  AND h.current_resolution_id = NEW.id
			  AND h.current_entity_id IS NOT DISTINCT FROM NEW.entity_id
			  AND h.last_decision_id = d.id
			  AND (
					(NEW.entity_id IS NULL
					 AND d.operation = 'rollback'
					 AND d.target_entity_id IS NULL)
					OR EXISTS (
						SELECT 1
						FROM memory_entities e
						WHERE e.id = NEW.entity_id
						  AND e.organization_id = NEW.organization_id
						  AND e.id = d.target_entity_id
						  AND e.status = 'active'
						  AND e.version = d.expected_entity_version
					)
			  )
		) THEN
RAISE EXCEPTION 'entity resolution acceptance fence failed';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_resolution_acceptance_guard BEFORE INSERT ON memory_entity_resolutions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_resolution_acceptance_guard();

CREATE FUNCTION emit_memory_entity_resolutions_update_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
IF NEW.organization_id != OLD.organization_id
		  OR NEW.mention_id != OLD.mention_id
		  OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
		  OR NEW.decision_id != OLD.decision_id
		  OR NEW.resolution_kind != OLD.resolution_kind
		  OR NEW.confidence != OLD.confidence
		  OR NEW.valid_from != OLD.valid_from
		  OR NEW.created_at != OLD.created_at
		  OR OLD.status != 'active'
		  OR NEW.status != 'revoked'
		  OR NEW.valid_to IS NULL THEN
RAISE EXCEPTION 'entity resolutions only permit active-to-revoked closure';
END IF;
RETURN NEW;
END;
$function$;
CREATE TRIGGER memory_entity_resolutions_update_guard BEFORE UPDATE ON memory_entity_resolutions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_resolutions_update_guard();

CREATE FUNCTION emit_memory_entity_resolutions_no_delete() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'entity resolutions are immutable';
END;
$function$;
CREATE TRIGGER memory_entity_resolutions_no_delete BEFORE DELETE ON memory_entity_resolutions FOR EACH ROW EXECUTE FUNCTION emit_memory_entity_resolutions_no_delete();

CREATE UNIQUE INDEX uniq_memory_entity_resolution_active ON memory_entity_resolutions(organization_id,mention_id) WHERE status = 'active';

ALTER TABLE "memory_entities" ADD CONSTRAINT "chk_memory_entity_name" CHECK (length(trim("display_name")) > 0 AND length("normalized_name") > 0);

ALTER TABLE "memory_entities" ADD CONSTRAINT "chk_memory_entity_version" CHECK ("version" >= 0);

ALTER TABLE "memory_entities" ADD CONSTRAINT "chk_memory_entity_merge_state" CHECK (("status" = 'merged' AND "merged_into_entity_id" IS NOT NULL AND "merged_into_entity_id" != "id") OR ("status" != 'merged' AND "merged_into_entity_id" IS NULL));

ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "chk_memory_entity_alias_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "memory_entity_aliases" ADD CONSTRAINT "chk_memory_entity_alias_validity" CHECK ("valid_to" IS NULL OR ("valid_to")::timestamptz > ("valid_from")::timestamptz);

ALTER TABLE "memory_entity_mentions" ADD CONSTRAINT "chk_memory_entity_mention_surface" CHECK (length(trim("surface_form")) > 0 AND length("normalized_form") > 0);

ALTER TABLE "memory_entity_mentions" ADD CONSTRAINT "chk_memory_entity_mention_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "memory_entity_mentions" ADD CONSTRAINT "chk_memory_entity_mention_span" CHECK (("char_start" IS NULL AND "char_end" IS NULL) OR ("char_start" >= 0 AND "char_end" > "char_start"));

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_versions" CHECK ("expected_mention_version" >= 0 AND "version" >= 0 AND ("expected_entity_version" IS NULL OR "expected_entity_version" >= 0));

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_review_pair" CHECK (("reviewed_by_type" IS NULL AND "reviewed_by_id" IS NULL) OR ("reviewed_by_type" IS NOT NULL AND "reviewed_by_id" IS NOT NULL));

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_independence" CHECK ("reviewed_by_id" IS NULL OR "reviewed_by_type" != "proposed_by_type" OR "reviewed_by_id" != "proposed_by_id");

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_review_state" CHECK (("status" = 'proposed' AND "reviewed_by_id" IS NULL AND "reviewed_at" IS NULL AND "applied_at" IS NULL) OR ("status" = 'rejected' AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "applied_at" IS NULL) OR ("status" = 'accepted' AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "applied_at" IS NOT NULL));

ALTER TABLE "memory_entity_resolution_decisions" ADD CONSTRAINT "chk_memory_entity_resolution_operation_shape" CHECK (("operation" IN ('link_mention', 'reassign_mention') AND "mention_id" IS NOT NULL AND "target_entity_id" IS NOT NULL AND "rollback_of_decision_id" IS NULL) OR ("operation" = 'rollback' AND "mention_id" IS NOT NULL AND "rollback_of_decision_id" IS NOT NULL) OR ("operation" = 'link_alias' AND "alias_id" IS NOT NULL AND "target_entity_id" IS NOT NULL) OR ("operation" IN ('merge_entities', 'split_entity') AND "source_entity_id" IS NOT NULL));

ALTER TABLE "memory_entity_resolution_heads" ADD CONSTRAINT "chk_memory_entity_head_version" CHECK ("version" >= 0);

ALTER TABLE "memory_entity_resolution_heads" ADD CONSTRAINT "chk_memory_entity_head_shape" CHECK (("current_resolution_id" IS NULL AND "current_entity_id" IS NULL AND "last_decision_id" IS NULL) OR ("current_resolution_id" IS NOT NULL AND "last_decision_id" IS NOT NULL));

ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "chk_memory_entity_resolution_shape" CHECK (("resolution_kind" = 'linked' AND "entity_id" IS NOT NULL) OR ("resolution_kind" = 'unresolved' AND "entity_id" IS NULL));

ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "chk_memory_entity_resolution_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "memory_entity_resolutions" ADD CONSTRAINT "chk_memory_entity_resolution_validity" CHECK (("status" = 'active' AND "valid_to" IS NULL) OR ("status" = 'revoked' AND "valid_to" IS NOT NULL AND ("valid_to")::timestamptz >= ("valid_from")::timestamptz));

CREATE FUNCTION sync_memory_fact_citations() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  DELETE FROM memory_fact_citations WHERE consolidated_fact_id = OLD.id;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  INSERT INTO memory_fact_citations(organization_id,cited_fact_id,consolidated_fact_id)
  SELECT NEW.organization_id, citation.value ->> 'id', NEW.id
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.metadata #> '{consolidation,evidence,sources}') = 'array' THEN NEW.metadata #> '{consolidation,evidence,sources}' ELSE '[]'::jsonb END) citation(value)
  WHERE jsonb_typeof(citation.value) = 'object' AND jsonb_typeof(citation.value -> 'id') = 'string'
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END;
$function$;
CREATE TRIGGER memory_fact_citations_insert AFTER INSERT ON memory_facts FOR EACH ROW EXECUTE FUNCTION sync_memory_fact_citations();
CREATE TRIGGER memory_fact_citations_update AFTER UPDATE OF metadata,organization_id,id ON memory_facts FOR EACH ROW EXECUTE FUNCTION sync_memory_fact_citations();
CREATE TRIGGER memory_fact_citations_delete AFTER DELETE ON memory_facts FOR EACH ROW EXECUTE FUNCTION sync_memory_fact_citations();
DELETE FROM memory_fact_citations;
INSERT INTO memory_fact_citations(organization_id,cited_fact_id,consolidated_fact_id)
SELECT f.organization_id, citation.value ->> 'id', f.id
FROM memory_facts f CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.metadata #> '{consolidation,evidence,sources}') = 'array' THEN f.metadata #> '{consolidation,evidence,sources}' ELSE '[]'::jsonb END) citation(value)
WHERE jsonb_typeof(citation.value) = 'object' AND jsonb_typeof(citation.value -> 'id') = 'string'
ON CONFLICT DO NOTHING;
END;
$install$;
