-- Canonical memory FTS5, citation, governance and mutation-outbox triggers.
-- Cross-workspace rows are rejected against the bound object identity.
CREATE TRIGGER `graph_projection_memory_facts_insert`
AFTER INSERT ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'fact', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_update`
AFTER UPDATE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'fact', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_delete`
AFTER DELETE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'fact', OLD.`id`, 'delete');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_edges_insert`
AFTER INSERT ON `memory_edges`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge', NEW.`id`, 'upsert',
		json_object(
			'sourceFactId', NEW.`source_fact_id`,
			'targetFactId', NEW.`target_fact_id`,
			'relationType', NEW.`relation_type`
		)
	FROM `memory_facts` f
	WHERE f.`id` = NEW.`source_fact_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_edges_update`
AFTER UPDATE ON `memory_edges`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge', NEW.`id`, 'upsert',
		json_object(
			'sourceFactId', NEW.`source_fact_id`,
			'targetFactId', NEW.`target_fact_id`,
			'relationType', NEW.`relation_type`
		)
	FROM `memory_facts` f
	WHERE f.`id` = NEW.`source_fact_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_edges_delete`
BEFORE DELETE ON `memory_edges`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge', OLD.`id`, 'delete',
		json_object(
			'sourceFactId', OLD.`source_fact_id`,
			'targetFactId', OLD.`target_fact_id`,
			'relationType', OLD.`relation_type`
		)
	FROM `memory_facts` f
	WHERE f.`id` = OLD.`source_fact_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_insert`
AFTER INSERT ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'domain', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_update`
AFTER UPDATE ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'domain', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_delete`
AFTER DELETE ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'domain', OLD.`id`, 'delete');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_facts`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory fact organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_domains`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory domain organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_edges_same_org_insert`
BEFORE INSERT ON `memory_edges`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_facts` source
	JOIN `memory_facts` target
	  ON target.`id` = NEW.`target_fact_id`
	WHERE source.`id` = NEW.`source_fact_id`
	  AND source.`organization_id` = target.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'memory edge endpoints must belong to the same organization');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_edges_same_org_update`
BEFORE UPDATE OF `source_fact_id`, `target_fact_id` ON `memory_edges`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_facts` source
	JOIN `memory_facts` target
	  ON target.`id` = NEW.`target_fact_id`
	WHERE source.`id` = NEW.`source_fact_id`
	  AND source.`organization_id` = target.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'memory edge endpoints must belong to the same organization');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_edges_update_old_tuple`
BEFORE UPDATE OF `source_fact_id`, `target_fact_id`, `relation_type` ON `memory_edges`
WHEN NEW.`source_fact_id` != OLD.`source_fact_id`
  OR NEW.`target_fact_id` != OLD.`target_fact_id`
  OR NEW.`relation_type` != OLD.`relation_type`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge',
		OLD.`id` || ':old:' || lower(hex(randomblob(8))), 'delete',
		json_object(
			'sourceFactId', OLD.`source_fact_id`,
			'targetFactId', OLD.`target_fact_id`,
			'relationType', OLD.`relation_type`
		)
	FROM `memory_facts` f
	WHERE f.`id` = OLD.`source_fact_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_incident_edges_delete`
BEFORE DELETE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT
		lower(hex(randomblob(16))),
		OLD.`organization_id`,
		'edge',
		e.`id` || ':incident:' || lower(hex(randomblob(8))),
		'delete',
		json_object(
			'sourceFactId', e.`source_fact_id`,
			'targetFactId', e.`target_fact_id`,
			'relationType', e.`relation_type`
		)
	FROM `memory_edges` e
	WHERE e.`source_fact_id` = OLD.`id`
	   OR e.`target_fact_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entities_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entities`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory entity organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_aliases_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_aliases`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'memory entity alias organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_mentions_no_update`
BEFORE UPDATE ON `memory_entity_mentions`
BEGIN
	SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_mentions_no_delete`
BEFORE DELETE ON `memory_entity_mentions`
BEGIN
	SELECT RAISE(ABORT, 'memory_entity_mentions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_terminal_no_update`
BEFORE UPDATE ON `memory_entity_resolution_decisions`
WHEN OLD.`status` IN ('accepted', 'rejected')
BEGIN
	SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_terminal_no_delete`
BEFORE DELETE ON `memory_entity_resolution_decisions`
WHEN OLD.`status` IN ('accepted', 'rejected')
BEGIN
	SELECT RAISE(ABORT, 'terminal entity resolution decisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_decisions_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_resolution_decisions`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'entity resolution decision organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_heads_org_immutable`
BEFORE UPDATE OF `organization_id` ON `memory_entity_resolution_heads`
WHEN NEW.`organization_id` != OLD.`organization_id`
BEGIN
	SELECT RAISE(ABORT, 'entity resolution head organization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolution_acceptance_guard`
BEFORE INSERT ON `memory_entity_resolutions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_entity_resolution_decisions` d
	JOIN `memory_entity_resolution_heads` h
	  ON h.`organization_id` = d.`organization_id`
	 AND h.`mention_id` = d.`mention_id`
	WHERE d.`id` = NEW.`decision_id`
	  AND d.`organization_id` = NEW.`organization_id`
	  AND d.`mention_id` = NEW.`mention_id`
	  AND d.`status` = 'accepted'
	  AND h.`current_resolution_id` = NEW.`id`
	  AND h.`current_entity_id` IS NEW.`entity_id`
	  AND h.`last_decision_id` = d.`id`
	  AND (
			(NEW.`entity_id` IS NULL
			 AND d.`operation` = 'rollback'
			 AND d.`target_entity_id` IS NULL)
			OR EXISTS (
				SELECT 1
				FROM `memory_entities` e
				WHERE e.`id` = NEW.`entity_id`
				  AND e.`organization_id` = NEW.`organization_id`
				  AND e.`id` = d.`target_entity_id`
				  AND e.`status` = 'active'
				  AND e.`version` = d.`expected_entity_version`
			)
	  )
)
BEGIN
	SELECT RAISE(ABORT, 'entity resolution acceptance fence failed');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolutions_update_guard`
BEFORE UPDATE ON `memory_entity_resolutions`
WHEN NEW.`organization_id` != OLD.`organization_id`
  OR NEW.`mention_id` != OLD.`mention_id`
  OR NEW.`entity_id` IS NOT OLD.`entity_id`
  OR NEW.`decision_id` != OLD.`decision_id`
  OR NEW.`resolution_kind` != OLD.`resolution_kind`
  OR NEW.`confidence` != OLD.`confidence`
  OR NEW.`valid_from` != OLD.`valid_from`
  OR NEW.`created_at` != OLD.`created_at`
  OR OLD.`status` != 'active'
  OR NEW.`status` != 'revoked'
  OR NEW.`valid_to` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'entity resolutions only permit active-to-revoked closure');
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entity_resolutions_no_delete`
BEFORE DELETE ON `memory_entity_resolutions`
BEGIN
	SELECT RAISE(ABORT, 'entity resolutions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_insert`
AFTER INSERT ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_update`
AFTER UPDATE ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entities_delete`
AFTER DELETE ON `memory_entities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'entity', OLD.`id`, 'delete');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entity_resolutions_insert`
AFTER INSERT ON `memory_entity_resolutions`
WHEN NEW.`resolution_kind` = 'linked'
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'entity_resolution', NEW.`id`, 'upsert');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_entity_resolutions_revoke`
AFTER UPDATE OF `status`, `valid_to` ON `memory_entity_resolutions`
WHEN OLD.`status` = 'active' AND NEW.`status` = 'revoked'
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES (
		lower(hex(randomblob(16))),
		NEW.`organization_id`,
		'entity_resolution',
		NEW.`id`,
		'delete',
		json_object(
			'mentionId', NEW.`mention_id`,
			'factId', (
				SELECT `source_fact_id`
				FROM `memory_entity_mentions`
				WHERE `id` = NEW.`mention_id`
				  AND `organization_id` = NEW.`organization_id`
			),
			'entityId', NEW.`entity_id`,
			'decisionId', NEW.`decision_id`,
			'validTo', NEW.`valid_to`
		)
	);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE memory_fact_fts USING fts5(
    fact_id UNINDEXED, organization_id UNINDEXED, text, entity_names,
    tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIEW memory_fact_search_documents AS
SELECT f.rowid AS rowid, f.id AS fact_id, f.organization_id AS organization_id,
    coalesce(f.summary, '') || char(10) || f.content AS text,
    coalesce((SELECT group_concat(ent.display_name, ' ')
        FROM memory_entity_mentions m
        JOIN memory_entity_resolutions r ON r.mention_id = m.id
            AND r.organization_id = f.organization_id AND r.status = 'active' AND r.valid_to IS NULL
        JOIN memory_entities ent ON ent.id = r.entity_id
            AND ent.organization_id = f.organization_id AND ent.status = 'active'
        WHERE m.source_fact_id = f.id AND m.organization_id = f.organization_id), '') AS entity_names
FROM memory_facts f;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_insert AFTER INSERT ON memory_facts BEGIN
    INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents WHERE fact_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_update AFTER UPDATE OF content, summary, organization_id ON memory_facts BEGIN
    INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents WHERE fact_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_delete AFTER DELETE ON memory_facts BEGIN
    DELETE FROM memory_fact_fts WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_resolution_insert AFTER INSERT ON memory_entity_resolutions BEGIN
    INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT source_fact_id FROM memory_entity_mentions WHERE id = NEW.mention_id AND organization_id = NEW.organization_id);
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_resolution_update AFTER UPDATE OF status, valid_to ON memory_entity_resolutions BEGIN
    INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT source_fact_id FROM memory_entity_mentions WHERE id = NEW.mention_id AND organization_id = NEW.organization_id);
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_entity_update AFTER UPDATE OF display_name, status ON memory_entities BEGIN
    INSERT OR REPLACE INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT m.source_fact_id FROM memory_entity_mentions m JOIN memory_entity_resolutions r ON r.mention_id = m.id AND r.organization_id = NEW.organization_id WHERE r.entity_id = NEW.id AND m.organization_id = NEW.organization_id);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE memory_fact_fts_recall USING fts5(
    fact_id UNINDEXED, organization_id UNINDEXED, text, entity_names,
    tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIEW memory_fact_recall_documents AS
SELECT d.rowid, d.fact_id, d.organization_id, d.text, d.entity_names
FROM memory_fact_search_documents d JOIN memory_facts f ON f.rowid = d.rowid
WHERE f.archived_at IS NULL
AND coalesce(f.memory_scope, '') != 'graph'
AND coalesce(f.use_policy, '') != 'do_not_inject_automatically'
AND coalesce(f.review_status, '') NOT IN ('restricted','rejected','superseded','stale','disputed')
AND coalesce(json_extract(f.metadata, '$.learningFeed.evidence.state'), '') != 'held'
AND (f.valid_to IS NULL OR datetime(f.valid_to) > datetime('now'))
AND (json_extract(f.metadata, '$.expiresAt') IS NULL OR datetime(json_extract(f.metadata, '$.expiresAt')) > datetime('now'));
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_insert AFTER INSERT ON memory_facts BEGIN INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents WHERE rowid = NEW.rowid; END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_update AFTER UPDATE OF content, summary, organization_id, archived_at, memory_scope, use_policy, review_status, metadata, valid_to ON memory_facts BEGIN DELETE FROM memory_fact_fts_recall WHERE rowid = OLD.rowid; INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents WHERE rowid = NEW.rowid; END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_delete AFTER DELETE ON memory_facts BEGIN DELETE FROM memory_fact_fts_recall WHERE rowid = OLD.rowid; END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_resolution_insert AFTER INSERT ON memory_entity_resolutions BEGIN INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT source_fact_id FROM memory_entity_mentions WHERE id = NEW.mention_id AND organization_id = NEW.organization_id); END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_resolution_update AFTER UPDATE OF status, valid_to ON memory_entity_resolutions BEGIN INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT source_fact_id FROM memory_entity_mentions WHERE id = NEW.mention_id AND organization_id = NEW.organization_id); END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_fts_recall_entity_update AFTER UPDATE OF display_name, status ON memory_entities BEGIN INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents WHERE organization_id = NEW.organization_id AND fact_id IN (SELECT m.source_fact_id FROM memory_entity_mentions m JOIN memory_entity_resolutions r ON r.mention_id = m.id AND r.organization_id = NEW.organization_id WHERE r.entity_id = NEW.id AND m.organization_id = NEW.organization_id); END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_citations_insert AFTER INSERT ON memory_facts
WHEN json_type(NEW.metadata, '$.consolidation.evidence.sources') = 'array'
BEGIN
 INSERT OR IGNORE INTO memory_fact_citations(organization_id, cited_fact_id, consolidated_fact_id)
 SELECT NEW.organization_id, json_extract(citation.value, '$.id'), NEW.id
 FROM json_each(NEW.metadata, '$.consolidation.evidence.sources') citation
 WHERE citation.type = 'object' AND json_type(citation.value, '$.id') = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_citations_update AFTER UPDATE OF metadata, organization_id, id ON memory_facts
BEGIN
 DELETE FROM memory_fact_citations WHERE consolidated_fact_id = OLD.id;
 INSERT OR IGNORE INTO memory_fact_citations(organization_id, cited_fact_id, consolidated_fact_id)
 SELECT NEW.organization_id, json_extract(citation.value, '$.id'), NEW.id
 FROM json_each(NEW.metadata, '$.consolidation.evidence.sources') citation
 WHERE json_type(NEW.metadata, '$.consolidation.evidence.sources') = 'array'
  AND citation.type = 'object' AND json_type(citation.value, '$.id') = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER memory_fact_citations_delete AFTER DELETE ON memory_facts
BEGIN
 DELETE FROM memory_fact_citations WHERE consolidated_fact_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_domains_insert_scope BEFORE INSERT ON memory_domains
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_domains_update_scope BEFORE UPDATE ON memory_domains
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_facts_insert_scope BEFORE INSERT ON memory_facts
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_facts_update_scope BEFORE UPDATE ON memory_facts
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entities_insert_scope BEFORE INSERT ON memory_entities
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entities_update_scope BEFORE UPDATE ON memory_entities
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_mentions_insert_scope BEFORE INSERT ON memory_entity_mentions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_mentions_update_scope BEFORE UPDATE ON memory_entity_mentions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_aliases_insert_scope BEFORE INSERT ON memory_entity_aliases
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_aliases_update_scope BEFORE UPDATE ON memory_entity_aliases
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_heads_insert_scope BEFORE INSERT ON memory_entity_resolution_heads
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_heads_update_scope BEFORE UPDATE ON memory_entity_resolution_heads
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_decisions_insert_scope BEFORE INSERT ON memory_entity_resolution_decisions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolution_decisions_update_scope BEFORE UPDATE ON memory_entity_resolution_decisions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolutions_insert_scope BEFORE INSERT ON memory_entity_resolutions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_entity_resolutions_update_scope BEFORE UPDATE ON memory_entity_resolutions
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citations_insert_scope BEFORE INSERT ON memory_fact_citations
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citations_update_scope BEFORE UPDATE ON memory_fact_citations
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citation_backfills_insert_scope BEFORE INSERT ON memory_fact_citation_backfills
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_memory_fact_citation_backfills_update_scope BEFORE UPDATE ON memory_fact_citation_backfills
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_graph_projection_outbox_insert_scope BEFORE INSERT ON graph_projection_outbox
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_graph_projection_outbox_update_scope BEFORE UPDATE ON graph_projection_outbox
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
