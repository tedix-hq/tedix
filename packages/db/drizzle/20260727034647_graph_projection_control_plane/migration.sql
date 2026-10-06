CREATE TABLE `graph_projection_consumers` (
	`organization_id` text PRIMARY KEY,
	`last_projected_sequence` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`last_success_at` text,
	`last_error` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_projection_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`event_id` text NOT NULL UNIQUE,
	`organization_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`poisoned_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_projection_readiness` (
	`organization_id` text PRIMARY KEY,
	`state` text DEFAULT 'disabled' NOT NULL,
	`reason` text,
	`projection_epoch` text,
	`persisted_watermark` integer DEFAULT 0 NOT NULL,
	`gds_watermark` integer DEFAULT 0 NOT NULL,
	`gds_epoch` text,
	`node_mismatch_count` integer,
	`edge_mismatch_count` integer,
	`lifecycle_mismatch_count` integer,
	`last_certified_at` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_graph_projection_consumers_lease` ON `graph_projection_consumers` (`lease_until`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_org_sequence` ON `graph_projection_outbox` (`organization_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_entity` ON `graph_projection_outbox` (`organization_id`,`entity_kind`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_outbox_retry` ON `graph_projection_outbox` (`poisoned_at`,`next_attempt_at`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_graph_projection_readiness_state` ON `graph_projection_readiness` (`state`,`updated_at`);--> statement-breakpoint

CREATE TRIGGER `graph_projection_memory_facts_insert`
AFTER INSERT ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'fact', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_update`
AFTER UPDATE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'fact', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_facts_delete`
AFTER DELETE ON `memory_facts`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'fact', OLD.`id`, 'delete');
END;--> statement-breakpoint

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
END;--> statement-breakpoint
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
END;--> statement-breakpoint
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
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_memory_domains_insert`
AFTER INSERT ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'domain', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_update`
AFTER UPDATE ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'domain', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_memory_domains_delete`
AFTER DELETE ON `memory_domains`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'domain', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_tedis_insert`
AFTER INSERT ON `tedis`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'tedi', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_tedis_update`
AFTER UPDATE OF `organization_id`, `slug`, `name`, `display_name` ON `tedis`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'tedi', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_tedis_delete`
AFTER DELETE ON `tedis`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'tedi', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_rationale_insert`
AFTER INSERT ON `tedi_rationale_records`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`org_id`, 'decision', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_rationale_update`
AFTER UPDATE ON `tedi_rationale_records`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`org_id`, 'decision', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_rationale_delete`
AFTER DELETE ON `tedi_rationale_records`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`org_id`, 'decision', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_knowledge_insert`
AFTER INSERT ON `knowledge_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'knowledge_entry', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_knowledge_update`
AFTER UPDATE ON `knowledge_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'knowledge_entry', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_knowledge_delete`
AFTER DELETE ON `knowledge_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'knowledge_entry', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_skills_insert`
AFTER INSERT ON `skill_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'skill', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_skills_update`
AFTER UPDATE ON `skill_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'skill', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_skills_delete`
AFTER DELETE ON `skill_entries`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'skill', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_expertise_insert`
AFTER INSERT ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', NEW.`id`, 'upsert',
		json_object('tediId', NEW.`tedi_id`, 'domainId', NEW.`domain_id`)
	FROM `tedis` t
	WHERE t.`id` = NEW.`tedi_id`;
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_update`
AFTER UPDATE ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', NEW.`id`, 'upsert',
		json_object('tediId', NEW.`tedi_id`, 'domainId', NEW.`domain_id`)
	FROM `tedis` t
	WHERE t.`id` = NEW.`tedi_id`;
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_delete`
BEFORE DELETE ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', OLD.`id`, 'delete',
		json_object('tediId', OLD.`tedi_id`, 'domainId', OLD.`domain_id`)
	FROM `tedis` t
	WHERE t.`id` = OLD.`tedi_id`;
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_capability_insert`
AFTER INSERT ON `org_capabilities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'capability', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_update`
AFTER UPDATE ON `org_capabilities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'capability', NEW.`id`, 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_delete`
AFTER DELETE ON `org_capabilities`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'capability', OLD.`id`, 'delete');
END;--> statement-breakpoint

CREATE TRIGGER `graph_projection_capability_link_insert`
AFTER INSERT ON `capability_links`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'capability_link', NEW.`id`, 'upsert',
		json_object(
			'capabilityId', NEW.`capability_id`,
			'entityKind', NEW.`entity_kind`,
			'entityId', NEW.`entity_id`
		));
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_link_update`
AFTER UPDATE ON `capability_links`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), NEW.`organization_id`, 'capability_link', NEW.`id`, 'upsert',
		json_object(
			'capabilityId', NEW.`capability_id`,
			'entityKind', NEW.`entity_kind`,
			'entityId', NEW.`entity_id`
		));
END;--> statement-breakpoint
CREATE TRIGGER `graph_projection_capability_link_delete`
BEFORE DELETE ON `capability_links`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	VALUES
		(lower(hex(randomblob(16))), OLD.`organization_id`, 'capability_link', OLD.`id`, 'delete',
		json_object(
			'capabilityId', OLD.`capability_id`,
			'entityKind', OLD.`entity_kind`,
			'entityId', OLD.`entity_id`
		));
END;--> statement-breakpoint

INSERT INTO `graph_projection_readiness`
	(`organization_id`, `state`, `reason`)
SELECT `id`, 'catching_up', 'initial_snapshot_pending'
FROM `organizations`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'fact', `id`, 'upsert'
FROM `memory_facts`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
SELECT lower(hex(randomblob(16))), f.`organization_id`, 'edge', e.`id`, 'upsert',
	json_object(
		'sourceFactId', e.`source_fact_id`,
		'targetFactId', e.`target_fact_id`,
		'relationType', e.`relation_type`
	)
FROM `memory_edges` e
JOIN `memory_facts` f ON f.`id` = e.`source_fact_id`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'domain', `id`, 'upsert'
FROM `memory_domains`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'tedi', `id`, 'upsert'
FROM `tedis`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `org_id`, 'decision', `id`, 'upsert'
FROM `tedi_rationale_records`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'knowledge_entry', `id`, 'upsert'
FROM `knowledge_entries`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'skill', `id`, 'upsert'
FROM `skill_entries`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', e.`id`, 'upsert',
	json_object('tediId', e.`tedi_id`, 'domainId', e.`domain_id`)
FROM `tedi_expertise` e
JOIN `tedis` t ON t.`id` = e.`tedi_id`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'capability', `id`, 'upsert'
FROM `org_capabilities`;--> statement-breakpoint
INSERT INTO `graph_projection_outbox`
	(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
SELECT lower(hex(randomblob(16))), `organization_id`, 'capability_link', `id`, 'upsert',
	json_object(
		'capabilityId', `capability_id`,
		'entityKind', `entity_kind`,
		'entityId', `entity_id`
	)
FROM `capability_links`;
--> statement-breakpoint

CREATE TRIGGER `graph_projection_outbox_marks_unready`
AFTER INSERT ON `graph_projection_outbox`
BEGIN
	INSERT INTO `graph_projection_readiness`
		(`organization_id`, `state`, `reason`, `updated_at`)
	VALUES
		(NEW.`organization_id`, 'catching_up', 'outbox_backlog_pending', CURRENT_TIMESTAMP)
	ON CONFLICT(`organization_id`) DO UPDATE SET
		`state` = 'catching_up',
		`reason` = 'outbox_backlog_pending',
		`updated_at` = CURRENT_TIMESTAMP;
END;
