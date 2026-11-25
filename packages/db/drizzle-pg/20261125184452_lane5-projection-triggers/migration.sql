-- Install projection hooks atomically; canonical writes cannot race the installation.

DO $install$

BEGIN

LOCK TABLE capability_links, decision_edges, graph_projection_outbox, knowledge_entries, memory_domains, memory_edges, memory_entities, memory_entity_resolutions, memory_facts, org_capabilities, skill_entries, tedi_expertise, tedi_rationale_records, tedis IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION emit_graph_projection_capability_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'capability', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_capability_delete
AFTER DELETE ON "org_capabilities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_delete();

CREATE FUNCTION emit_graph_projection_capability_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'capability', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_capability_insert
AFTER INSERT ON "org_capabilities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_insert();

CREATE FUNCTION emit_graph_projection_capability_link_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'capability_link', OLD."id", 'delete',
		jsonb_build_object(
			'capabilityId', OLD."capability_id",
			'entityKind', OLD."entity_kind",
			'entityId', OLD."entity_id"
		));
RETURN OLD;
END;
$function$;

CREATE TRIGGER graph_projection_capability_link_delete
BEFORE DELETE ON "capability_links"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_link_delete();

CREATE FUNCTION emit_graph_projection_capability_link_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'capability_link', NEW."id", 'upsert',
		jsonb_build_object(
			'capabilityId', NEW."capability_id",
			'entityKind', NEW."entity_kind",
			'entityId', NEW."entity_id"
		));
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_capability_link_insert
AFTER INSERT ON "capability_links"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_link_insert();

CREATE FUNCTION emit_graph_projection_capability_link_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'capability link organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_capability_link_org_immutable
BEFORE UPDATE OF "organization_id" ON "capability_links"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_capability_link_org_immutable();

CREATE FUNCTION emit_graph_projection_capability_link_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'capability_link', NEW."id", 'upsert',
		jsonb_build_object(
			'capabilityId', NEW."capability_id",
			'entityKind', NEW."entity_kind",
			'entityId', NEW."entity_id"
		));
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_capability_link_update
AFTER UPDATE ON "capability_links"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_link_update();

CREATE FUNCTION emit_graph_projection_capability_link_update_old_tuple() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES (
		replace(gen_random_uuid()::text, '-', ''),
		OLD."organization_id",
		'capability_link',
		OLD."id" || ':old:' || replace(gen_random_uuid()::text, '-', ''),
		'delete',
		jsonb_build_object(
			'capabilityId', OLD."capability_id",
			'entityKind', OLD."entity_kind",
			'entityId', OLD."entity_id"
		)
	);
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_capability_link_update_old_tuple
BEFORE UPDATE OF "capability_id", "entity_kind", "entity_id" ON "capability_links"
FOR EACH ROW WHEN (NEW."capability_id" != OLD."capability_id"
  OR NEW."entity_kind" != OLD."entity_kind"
  OR NEW."entity_id" != OLD."entity_id")
EXECUTE FUNCTION emit_graph_projection_capability_link_update_old_tuple();

CREATE FUNCTION emit_graph_projection_capability_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'capability organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_capability_org_immutable
BEFORE UPDATE OF "organization_id" ON "org_capabilities"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_capability_org_immutable();

CREATE FUNCTION emit_graph_projection_capability_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'capability', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_capability_update
AFTER UPDATE ON "org_capabilities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_capability_update();

CREATE FUNCTION emit_graph_projection_decision_edges_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."org_id", 'decision_edge', OLD."id", 'delete',
			jsonb_build_object(
				'id', OLD."id", 'orgId', OLD."org_id", 'kind', OLD."kind",
				'fromKind', OLD."from_kind", 'fromId', OLD."from_id",
				'toKind', OLD."to_kind", 'toId', OLD."to_id"
			));
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_decision_edges_delete
AFTER DELETE ON "decision_edges"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_decision_edges_delete();

CREATE FUNCTION emit_graph_projection_decision_edges_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."org_id", 'decision_edge', NEW."id", 'upsert',
			jsonb_build_object(
				'id', NEW."id", 'orgId', NEW."org_id", 'kind', NEW."kind",
				'fromKind', NEW."from_kind", 'fromId', NEW."from_id",
				'toKind', NEW."to_kind", 'toId', NEW."to_id"
			));
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_decision_edges_insert
AFTER INSERT ON "decision_edges"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_decision_edges_insert();

CREATE FUNCTION emit_graph_projection_decision_edges_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."org_id", 'decision_edge', NEW."id", 'upsert',
			jsonb_build_object(
				'id', NEW."id", 'orgId', NEW."org_id", 'kind', NEW."kind",
				'fromKind', NEW."from_kind", 'fromId', NEW."from_id",
				'toKind', NEW."to_kind", 'toId', NEW."to_id"
			));
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_decision_edges_update
AFTER UPDATE ON "decision_edges"
FOR EACH ROW WHEN (OLD."confidence" IS DISTINCT FROM NEW."confidence"
	OR OLD."note" IS DISTINCT FROM NEW."note"
	OR OLD."occurred_at" IS DISTINCT FROM NEW."occurred_at")
EXECUTE FUNCTION emit_graph_projection_decision_edges_update();

CREATE FUNCTION emit_graph_projection_expertise_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), t."organization_id", 'tedi_expertise', OLD."id", 'delete',
		jsonb_build_object('tediId', OLD."tedi_id", 'domainId', OLD."domain_id")
	FROM "tedis" t
	WHERE t."id" = OLD."tedi_id";
RETURN OLD;
END;
$function$;

CREATE TRIGGER graph_projection_expertise_delete
BEFORE DELETE ON "tedi_expertise"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_expertise_delete();

CREATE FUNCTION emit_graph_projection_expertise_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), t."organization_id", 'tedi_expertise', NEW."id", 'upsert',
		jsonb_build_object('tediId', NEW."tedi_id", 'domainId', NEW."domain_id")
	FROM "tedis" t
	WHERE t."id" = NEW."tedi_id";
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_expertise_insert
AFTER INSERT ON "tedi_expertise"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_expertise_insert();

CREATE FUNCTION emit_graph_projection_expertise_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), t."organization_id", 'tedi_expertise', NEW."id", 'upsert',
		jsonb_build_object('tediId', NEW."tedi_id", 'domainId', NEW."domain_id")
	FROM "tedis" t
	WHERE t."id" = NEW."tedi_id";
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_expertise_update
AFTER UPDATE ON "tedi_expertise"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_expertise_update();

CREATE FUNCTION emit_graph_projection_expertise_update_old_tuple() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), t."organization_id", 'tedi_expertise',
		OLD."id" || ':old:' || replace(gen_random_uuid()::text, '-', ''), 'delete',
		jsonb_build_object('tediId', OLD."tedi_id", 'domainId', OLD."domain_id")
	FROM "tedis" t
	WHERE t."id" = OLD."tedi_id";
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_expertise_update_old_tuple
BEFORE UPDATE OF "tedi_id", "domain_id" ON "tedi_expertise"
FOR EACH ROW WHEN (NEW."tedi_id" != OLD."tedi_id"
  OR NEW."domain_id" != OLD."domain_id")
EXECUTE FUNCTION emit_graph_projection_expertise_update_old_tuple();

CREATE FUNCTION emit_graph_projection_knowledge_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'knowledge_entry', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_knowledge_delete
AFTER DELETE ON "knowledge_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_knowledge_delete();

CREATE FUNCTION emit_graph_projection_knowledge_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'knowledge_entry', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_knowledge_insert
AFTER INSERT ON "knowledge_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_knowledge_insert();

CREATE FUNCTION emit_graph_projection_knowledge_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'knowledge entry organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_knowledge_org_immutable
BEFORE UPDATE OF "organization_id" ON "knowledge_entries"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_knowledge_org_immutable();

CREATE FUNCTION emit_graph_projection_knowledge_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'knowledge_entry', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_knowledge_update
AFTER UPDATE ON "knowledge_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_knowledge_update();

CREATE FUNCTION emit_graph_projection_memory_domains_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'domain', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_domains_delete
AFTER DELETE ON "memory_domains"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_domains_delete();

CREATE FUNCTION emit_graph_projection_memory_domains_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'domain', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_domains_insert
AFTER INSERT ON "memory_domains"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_domains_insert();

CREATE FUNCTION emit_graph_projection_memory_domains_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'memory domain organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_memory_domains_org_immutable
BEFORE UPDATE OF "organization_id" ON "memory_domains"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_memory_domains_org_immutable();

CREATE FUNCTION emit_graph_projection_memory_domains_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'domain', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_domains_update
AFTER UPDATE ON "memory_domains"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_domains_update();

CREATE FUNCTION emit_graph_projection_memory_edges_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), f."organization_id", 'edge', OLD."id", 'delete',
		jsonb_build_object(
			'sourceFactId', OLD."source_fact_id",
			'targetFactId', OLD."target_fact_id",
			'relationType', OLD."relation_type"
		)
	FROM "memory_facts" f
	WHERE f."id" = OLD."source_fact_id";
RETURN OLD;
END;
$function$;

CREATE TRIGGER graph_projection_memory_edges_delete
BEFORE DELETE ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_edges_delete();

CREATE FUNCTION emit_graph_projection_memory_edges_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), f."organization_id", 'edge', NEW."id", 'upsert',
		jsonb_build_object(
			'sourceFactId', NEW."source_fact_id",
			'targetFactId', NEW."target_fact_id",
			'relationType', NEW."relation_type"
		)
	FROM "memory_facts" f
	WHERE f."id" = NEW."source_fact_id";
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_edges_insert
AFTER INSERT ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_edges_insert();

CREATE FUNCTION emit_graph_projection_memory_edges_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), f."organization_id", 'edge', NEW."id", 'upsert',
		jsonb_build_object(
			'sourceFactId', NEW."source_fact_id",
			'targetFactId', NEW."target_fact_id",
			'relationType', NEW."relation_type"
		)
	FROM "memory_facts" f
	WHERE f."id" = NEW."source_fact_id";
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_edges_update
AFTER UPDATE ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_edges_update();

CREATE FUNCTION emit_graph_projection_memory_edges_update_old_tuple() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT replace(gen_random_uuid()::text, '-', ''), f."organization_id", 'edge',
		OLD."id" || ':old:' || replace(gen_random_uuid()::text, '-', ''), 'delete',
		jsonb_build_object(
			'sourceFactId', OLD."source_fact_id",
			'targetFactId', OLD."target_fact_id",
			'relationType', OLD."relation_type"
		)
	FROM "memory_facts" f
	WHERE f."id" = OLD."source_fact_id";
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_memory_edges_update_old_tuple
BEFORE UPDATE OF "source_fact_id", "target_fact_id", "relation_type" ON "memory_edges"
FOR EACH ROW WHEN (NEW."source_fact_id" != OLD."source_fact_id"
  OR NEW."target_fact_id" != OLD."target_fact_id"
  OR NEW."relation_type" != OLD."relation_type")
EXECUTE FUNCTION emit_graph_projection_memory_edges_update_old_tuple();

CREATE FUNCTION emit_graph_projection_memory_entities_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'entity', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_entities_delete
AFTER DELETE ON "memory_entities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_entities_delete();

CREATE FUNCTION emit_graph_projection_memory_entities_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'entity', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_entities_insert
AFTER INSERT ON "memory_entities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_entities_insert();

CREATE FUNCTION emit_graph_projection_memory_entities_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'entity', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_entities_update
AFTER UPDATE ON "memory_entities"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_entities_update();

CREATE FUNCTION emit_graph_projection_memory_entity_resolutions_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'entity_resolution', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_entity_resolutions_insert
AFTER INSERT ON "memory_entity_resolutions"
FOR EACH ROW WHEN (NEW."resolution_kind" = 'linked')
EXECUTE FUNCTION emit_graph_projection_memory_entity_resolutions_insert();

CREATE FUNCTION emit_graph_projection_memory_entity_resolutions_revoke() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	VALUES (
		replace(gen_random_uuid()::text, '-', ''),
		NEW."organization_id",
		'entity_resolution',
		NEW."id",
		'delete',
		jsonb_build_object(
			'mentionId', NEW."mention_id",
			'factId', (
				SELECT "source_fact_id"
				FROM "memory_entity_mentions"
				WHERE "id" = NEW."mention_id"
				  AND "organization_id" = NEW."organization_id"
			),
			'entityId', NEW."entity_id",
			'decisionId', NEW."decision_id",
			'validTo', NEW."valid_to"
		)
	);
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_entity_resolutions_revoke
AFTER UPDATE OF "status", "valid_to" ON "memory_entity_resolutions"
FOR EACH ROW WHEN (OLD."status" = 'active' AND NEW."status" = 'revoked')
EXECUTE FUNCTION emit_graph_projection_memory_entity_resolutions_revoke();

CREATE FUNCTION emit_graph_projection_memory_facts_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'fact', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_facts_delete
AFTER DELETE ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_facts_delete();

CREATE FUNCTION emit_graph_projection_memory_facts_incident_edges_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation", "payload")
	SELECT
		replace(gen_random_uuid()::text, '-', ''),
		OLD."organization_id",
		'edge',
		e."id" || ':incident:' || replace(gen_random_uuid()::text, '-', ''),
		'delete',
		jsonb_build_object(
			'sourceFactId', e."source_fact_id",
			'targetFactId', e."target_fact_id",
			'relationType', e."relation_type"
		)
	FROM "memory_edges" e
	WHERE e."source_fact_id" = OLD."id"
	   OR e."target_fact_id" = OLD."id";
RETURN OLD;
END;
$function$;

CREATE TRIGGER graph_projection_memory_facts_incident_edges_delete
BEFORE DELETE ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_facts_incident_edges_delete();

CREATE FUNCTION emit_graph_projection_memory_facts_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'fact', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_facts_insert
AFTER INSERT ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_facts_insert();

CREATE FUNCTION emit_graph_projection_memory_facts_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'memory fact organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_memory_facts_org_immutable
BEFORE UPDATE OF "organization_id" ON "memory_facts"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_memory_facts_org_immutable();

CREATE FUNCTION emit_graph_projection_memory_facts_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'fact', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_memory_facts_update
AFTER UPDATE ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_memory_facts_update();

CREATE FUNCTION emit_graph_projection_outbox_marks_unready() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_readiness"
		("organization_id", "state", "reason", "updated_at")
	VALUES
		(NEW."organization_id", 'catching_up', 'outbox_backlog_pending', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
	ON CONFLICT("organization_id") DO UPDATE SET
		"state" = 'catching_up',
		"reason" = 'outbox_backlog_pending',
		"updated_at" = to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_outbox_marks_unready
AFTER INSERT ON "graph_projection_outbox"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_outbox_marks_unready();

CREATE FUNCTION emit_graph_projection_rationale_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."org_id", 'decision', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_rationale_delete
AFTER DELETE ON "tedi_rationale_records"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_rationale_delete();

CREATE FUNCTION emit_graph_projection_rationale_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."org_id", 'decision', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_rationale_insert
AFTER INSERT ON "tedi_rationale_records"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_rationale_insert();

CREATE FUNCTION emit_graph_projection_rationale_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'rationale organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_rationale_org_immutable
BEFORE UPDATE OF "org_id" ON "tedi_rationale_records"
FOR EACH ROW WHEN (NEW."org_id" != OLD."org_id")
EXECUTE FUNCTION emit_graph_projection_rationale_org_immutable();

CREATE FUNCTION emit_graph_projection_rationale_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."org_id", 'decision', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_rationale_update
AFTER UPDATE ON "tedi_rationale_records"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_rationale_update();

CREATE FUNCTION emit_graph_projection_skills_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'skill', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_skills_delete
AFTER DELETE ON "skill_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_skills_delete();

CREATE FUNCTION emit_graph_projection_skills_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'skill', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_skills_insert
AFTER INSERT ON "skill_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_skills_insert();

CREATE FUNCTION emit_graph_projection_skills_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'skill organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_skills_org_immutable
BEFORE UPDATE OF "organization_id" ON "skill_entries"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_skills_org_immutable();

CREATE FUNCTION emit_graph_projection_skills_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'skill', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_skills_update
AFTER UPDATE ON "skill_entries"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_skills_update();

CREATE FUNCTION emit_graph_projection_tedis_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), OLD."organization_id", 'tedi', OLD."id", 'delete');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_tedis_delete
AFTER DELETE ON "tedis"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_tedis_delete();

CREATE FUNCTION emit_graph_projection_tedis_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'tedi', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_tedis_insert
AFTER INSERT ON "tedis"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_tedis_insert();

CREATE FUNCTION emit_graph_projection_tedis_org_immutable() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
RAISE EXCEPTION 'tedi organization is immutable';
RETURN NEW;
END;
$function$;

CREATE TRIGGER graph_projection_tedis_org_immutable
BEFORE UPDATE OF "organization_id" ON "tedis"
FOR EACH ROW WHEN (NEW."organization_id" != OLD."organization_id")
EXECUTE FUNCTION emit_graph_projection_tedis_org_immutable();

CREATE FUNCTION emit_graph_projection_tedis_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO "graph_projection_outbox"
		("event_id", "organization_id", "entity_kind", "entity_id", "operation")
	VALUES
		(replace(gen_random_uuid()::text, '-', ''), NEW."organization_id", 'tedi', NEW."id", 'upsert');
RETURN NULL;
END;
$function$;

CREATE TRIGGER graph_projection_tedis_update
AFTER UPDATE OF "organization_id", "slug", "name", "display_name" ON "tedis"
FOR EACH ROW EXECUTE FUNCTION emit_graph_projection_tedis_update();

CREATE FUNCTION emit_memory_edge_org_counts_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
UPDATE memory_edge_org_counts SET total = total - 1
  WHERE organization_id = (SELECT source.organization_id FROM memory_facts source, memory_facts target
    WHERE source.id = OLD.source_fact_id AND target.id = OLD.target_fact_id AND target.organization_id = source.organization_id);
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_edge_org_counts_delete
AFTER DELETE ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_memory_edge_org_counts_delete();

CREATE FUNCTION emit_memory_edge_org_counts_fact_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
UPDATE memory_edge_org_counts SET total = total - ((SELECT count(*) FROM memory_edges edge, memory_facts other
    WHERE edge.source_fact_id = OLD.id AND other.id = edge.target_fact_id AND other.organization_id = OLD.organization_id)
  + (SELECT count(*) FROM memory_edges edge, memory_facts other
    WHERE edge.target_fact_id = OLD.id AND edge.source_fact_id != OLD.id
    AND other.id = edge.source_fact_id AND other.organization_id = OLD.organization_id))
  WHERE organization_id = OLD.organization_id;
RETURN OLD;
END;
$function$;

CREATE TRIGGER memory_edge_org_counts_fact_delete
BEFORE DELETE ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_memory_edge_org_counts_fact_delete();

CREATE FUNCTION emit_memory_edge_org_counts_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO memory_edge_org_counts (organization_id, total)
  SELECT source.organization_id, 1 FROM memory_facts source, memory_facts target
    WHERE source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id AND target.organization_id = source.organization_id
  ON CONFLICT(organization_id) DO UPDATE SET total = memory_edge_org_counts.total + 1;
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_edge_org_counts_insert
AFTER INSERT ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_memory_edge_org_counts_insert();

CREATE FUNCTION emit_memory_edge_org_counts_repoint() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
UPDATE memory_edge_org_counts SET total = total - 1
  WHERE organization_id = (SELECT source.organization_id FROM memory_facts source, memory_facts target
    WHERE source.id = OLD.source_fact_id AND target.id = OLD.target_fact_id AND target.organization_id = source.organization_id);
  INSERT INTO memory_edge_org_counts (organization_id, total)
  SELECT source.organization_id, 1 FROM memory_facts source, memory_facts target
    WHERE source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id AND target.organization_id = source.organization_id
  ON CONFLICT(organization_id) DO UPDATE SET total = memory_edge_org_counts.total + 1;
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_edge_org_counts_repoint
AFTER UPDATE OF source_fact_id, target_fact_id ON "memory_edges"
FOR EACH ROW WHEN (OLD.source_fact_id != NEW.source_fact_id OR OLD.target_fact_id != NEW.target_fact_id)
EXECUTE FUNCTION emit_memory_edge_org_counts_repoint();

CREATE FUNCTION emit_memory_edges_same_org_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
IF NOT EXISTS (
	SELECT 1
	FROM "memory_facts" source
	JOIN "memory_facts" target
	  ON target."id" = NEW."target_fact_id"
	WHERE source."id" = NEW."source_fact_id"
	  AND source."organization_id" = target."organization_id"
) THEN
RAISE EXCEPTION 'memory edge endpoints must belong to the same organization';
END IF;
RETURN NEW;
END;
$function$;

CREATE TRIGGER memory_edges_same_org_insert
BEFORE INSERT ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_memory_edges_same_org_insert();

CREATE FUNCTION emit_memory_edges_same_org_update() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
IF NOT EXISTS (
	SELECT 1
	FROM "memory_facts" source
	JOIN "memory_facts" target
	  ON target."id" = NEW."target_fact_id"
	WHERE source."id" = NEW."source_fact_id"
	  AND source."organization_id" = target."organization_id"
) THEN
RAISE EXCEPTION 'memory edge endpoints must belong to the same organization';
END IF;
RETURN NEW;
END;
$function$;

CREATE TRIGGER memory_edges_same_org_update
BEFORE UPDATE OF "source_fact_id", "target_fact_id" ON "memory_edges"
FOR EACH ROW EXECUTE FUNCTION emit_memory_edges_same_org_update();

CREATE FUNCTION emit_memory_fact_org_counts_delete() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
UPDATE memory_fact_org_counts SET total = total - 1 WHERE organization_id = OLD.organization_id;
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_fact_org_counts_delete
AFTER DELETE ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_memory_fact_org_counts_delete();

CREATE FUNCTION emit_memory_fact_org_counts_insert() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
INSERT INTO memory_fact_org_counts (organization_id, total) VALUES (NEW.organization_id, 1)
  ON CONFLICT(organization_id) DO UPDATE SET total = memory_fact_org_counts.total + 1;
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_fact_org_counts_insert
AFTER INSERT ON "memory_facts"
FOR EACH ROW EXECUTE FUNCTION emit_memory_fact_org_counts_insert();

CREATE FUNCTION emit_memory_fact_org_counts_move() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
UPDATE memory_fact_org_counts SET total = total - 1 WHERE organization_id = OLD.organization_id;
  INSERT INTO memory_fact_org_counts (organization_id, total) VALUES (NEW.organization_id, 1)
  ON CONFLICT(organization_id) DO UPDATE SET total = memory_fact_org_counts.total + 1;
RETURN NULL;
END;
$function$;

CREATE TRIGGER memory_fact_org_counts_move
AFTER UPDATE OF organization_id ON "memory_facts"
FOR EACH ROW WHEN (OLD.organization_id != NEW.organization_id)
EXECUTE FUNCTION emit_memory_fact_org_counts_move();

DELETE FROM memory_fact_org_counts; INSERT INTO memory_fact_org_counts (organization_id,total) SELECT organization_id,count(*) FROM memory_facts GROUP BY organization_id;

DELETE FROM memory_edge_org_counts; INSERT INTO memory_edge_org_counts (organization_id,total) SELECT s.organization_id,count(*) FROM memory_edges e JOIN memory_facts s ON s.id=e.source_fact_id JOIN memory_facts t ON t.id=e.target_fact_id AND t.organization_id=s.organization_id GROUP BY s.organization_id;

CREATE INDEX memory_edges_projection_recent ON memory_edges(created_at DESC,id DESC);

END;

$install$;
