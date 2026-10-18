-- A recall-only projection avoids ranking archived/policy-blocked/history rows.
-- The full index remains available for explicit graph-anchor searches.
-- Trigger deletes affect only this rebuildable projection, never canonical facts.
-- Recovery: rebuild from memory_fact_recall_documents; the full index is unchanged.
-- tedix: destructive-reviewed Work-Item: dfddf3d4-8148-4958-a2d1-a4bc0c884e75
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
INSERT OR REPLACE INTO memory_fact_fts_recall(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_recall_documents;
