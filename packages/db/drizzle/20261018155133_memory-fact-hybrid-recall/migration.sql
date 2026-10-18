-- Rebuildable search projection only; canonical facts and entity decisions are unchanged.
-- Trigger deletes remove index rows only, never canonical data.
-- tedix: destructive-reviewed Work-Item: dfddf3d4-8148-4958-a2d1-a4bc0c884e75
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
INSERT INTO memory_fact_fts(rowid, fact_id, organization_id, text, entity_names) SELECT rowid, fact_id, organization_id, text, entity_names FROM memory_fact_search_documents;
