-- Project decision_edges into the graph database through the existing
-- graph_projection_outbox. Every event carries the edge endpoints, so a
-- delete (or an upsert whose row is already gone) can remove the projected
-- relationship without reading D1.
CREATE TRIGGER `graph_projection_decision_edges_insert`
AFTER INSERT ON `decision_edges`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`org_id`, 'decision_edge', NEW.`id`, 'upsert',
			json_object(
				'id', NEW.`id`, 'orgId', NEW.`org_id`, 'kind', NEW.`kind`,
				'fromKind', NEW.`from_kind`, 'fromId', NEW.`from_id`,
				'toKind', NEW.`to_kind`, 'toId', NEW.`to_id`
			));
END;
--> statement-breakpoint
-- Writers re-upsert the same edges often; only a change the graph shows
-- (confidence, note, time) appends an event.
CREATE TRIGGER `graph_projection_decision_edges_update`
AFTER UPDATE ON `decision_edges`
WHEN OLD.`confidence` IS NOT NEW.`confidence`
	OR OLD.`note` IS NOT NEW.`note`
	OR OLD.`occurred_at` IS NOT NEW.`occurred_at`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`org_id`, 'decision_edge', NEW.`id`, 'upsert',
			json_object(
				'id', NEW.`id`, 'orgId', NEW.`org_id`, 'kind', NEW.`kind`,
				'fromKind', NEW.`from_kind`, 'fromId', NEW.`from_id`,
				'toKind', NEW.`to_kind`, 'toId', NEW.`to_id`
			));
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_decision_edges_delete`
AFTER DELETE ON `decision_edges`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`org_id`, 'decision_edge', OLD.`id`, 'delete',
			json_object(
				'id', OLD.`id`, 'orgId', OLD.`org_id`, 'kind', OLD.`kind`,
				'fromKind', OLD.`from_kind`, 'fromId', OLD.`from_id`,
				'toKind', OLD.`to_kind`, 'toId', OLD.`to_id`
			));
END;
--> statement-breakpoint
-- Seed the edges written before these triggers existed.
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
SELECT lower(hex(randomblob(16))), `org_id`, 'decision_edge', `id`, 'upsert',
	json_object(
		'id', `id`, 'orgId', `org_id`, 'kind', `kind`,
		'fromKind', `from_kind`, 'fromId', `from_id`,
		'toKind', `to_kind`, 'toId', `to_id`
	)
FROM `decision_edges`;
