-- tedix: destructive-reviewed Work-Item: 8942cbb7-901e-4423-a963-1f27546702c1
-- Preservation: only rebuild derived keys in this new table. Requests, response
-- bodies and source metadata are never deleted or changed. Backfill uses those
-- original rows. Rollback: restore the previous reader before removing these
-- triggers/table; rebuild the projection from the original rows if needed.
CREATE TABLE `work_interaction_decision_history` (
	`org_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`response_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`relation_key` text NOT NULL,
	`responded_at` text NOT NULL,
	CONSTRAINT `work_interaction_decision_history_pk` PRIMARY KEY(`org_id`, `interaction_id`, `response_id`, `relation_key`),
	CONSTRAINT `fk_work_interaction_decision_history_response_id_work_interaction_responses_id_fk` FOREIGN KEY (`response_id`) REFERENCES `work_interaction_responses`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_interaction_decision_history_org_id_interaction_id_work_interactions_org_id_id_fk` FOREIGN KEY (`org_id`,`interaction_id`) REFERENCES `work_interactions`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_work_interaction_decision_history_latest` ON `work_interaction_decision_history` (`org_id`,`target_type`,`target_id`,`relation_key`,`responded_at`,`response_id`,`interaction_id`);
--> statement-breakpoint
INSERT INTO work_interaction_decision_history

SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('work', i.work_item_id), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
WHERE i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND i.work_item_id IS NOT NULL
UNION
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('source', json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind'),
 json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id'), json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.tediId')), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
CROSS JOIN json_each(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources')) s
WHERE i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND json_type(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'))='array'
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind') IS NOT NULL
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id') IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER work_interaction_decision_history_request_update
AFTER UPDATE OF org_id, id, work_item_id, target_type, target_id, status, metadata ON work_interactions
BEGIN
DELETE FROM work_interaction_decision_history WHERE org_id=OLD.org_id AND interaction_id=OLD.id;

DELETE FROM work_interaction_decision_history WHERE org_id=NEW.org_id AND interaction_id=NEW.id;
INSERT INTO work_interaction_decision_history
SELECT * FROM (
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('work', i.work_item_id), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
WHERE i.org_id=NEW.org_id AND i.id=NEW.id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND i.work_item_id IS NOT NULL
UNION
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('source', json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind'),
 json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id'), json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.tediId')), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
CROSS JOIN json_each(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources')) s
WHERE i.org_id=NEW.org_id AND i.id=NEW.id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND json_type(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'))='array'
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind') IS NOT NULL
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id') IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER work_interaction_decision_history_response_insert
AFTER INSERT ON work_interaction_responses BEGIN

DELETE FROM work_interaction_decision_history WHERE org_id=NEW.org_id AND interaction_id=NEW.interaction_id;
INSERT INTO work_interaction_decision_history
SELECT * FROM (
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('work', i.work_item_id), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
WHERE i.org_id=NEW.org_id AND i.id=NEW.interaction_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND i.work_item_id IS NOT NULL
UNION
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('source', json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind'),
 json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id'), json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.tediId')), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
CROSS JOIN json_each(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources')) s
WHERE i.org_id=NEW.org_id AND i.id=NEW.interaction_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND json_type(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'))='array'
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind') IS NOT NULL
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id') IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER work_interaction_decision_history_response_update
AFTER UPDATE OF org_id, id, interaction_id, resolves_request, responded_at ON work_interaction_responses BEGIN
DELETE FROM work_interaction_decision_history WHERE response_id=OLD.id;

DELETE FROM work_interaction_decision_history WHERE org_id=NEW.org_id AND interaction_id=NEW.interaction_id;
INSERT INTO work_interaction_decision_history
SELECT * FROM (
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('work', i.work_item_id), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
WHERE i.org_id=NEW.org_id AND i.id=NEW.interaction_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND i.work_item_id IS NOT NULL
UNION
SELECT i.org_id, i.id, a.id, i.target_type, i.target_id,
 json_array('source', json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind'),
 json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id'), json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.tediId')), a.responded_at
FROM work_interactions i JOIN work_interaction_responses a
 ON a.org_id=i.org_id AND a.interaction_id=i.id AND a.resolves_request=1
CROSS JOIN json_each(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources')) s
WHERE i.org_id=NEW.org_id AND i.id=NEW.interaction_id AND i.status='resolved' AND i.target_type IS NOT NULL AND i.target_id IS NOT NULL
 AND json_type(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'))='array'
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.kind') IS NOT NULL
 AND json_extract(coalesce(nullif(i.metadata -> '$.decisionSources', 'null'), i.metadata -> '$.decisionDeck.sources'), s.fullkey || '.id') IS NOT NULL);
END;
