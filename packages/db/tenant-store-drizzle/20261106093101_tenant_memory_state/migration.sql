CREATE TABLE `tedi_curiosity_queue` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`topic` text NOT NULL,
	`domain` text NOT NULL,
	`reason` text NOT NULL,
	`priority` real DEFAULT 0.5 NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`facts_learned` integer DEFAULT 0 NOT NULL,
	`gaps_found` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `tedi_expertise` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`fact_count` integer DEFAULT 0 NOT NULL,
	`avg_confidence` real DEFAULT 0 NOT NULL,
	`expertise_level` text DEFAULT 'novice' NOT NULL,
	`last_activity_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_tedi_expertise_domain_id_memory_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `memory_domains`(`id`),
	CONSTRAINT `uniq_tedi_domain` UNIQUE(`tedi_id`,`domain_id`)
);
--> statement-breakpoint
CREATE TABLE `tedi_optimization_signals` (
	`id` text PRIMARY KEY,
	`tedi_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`domain` text NOT NULL,
	`evidence` text NOT NULL,
	`suggested_action` text NOT NULL,
	`estimated_impact` real DEFAULT 0.5 NOT NULL,
	`estimated_effort` real DEFAULT 0.5 NOT NULL,
	`roi` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_tedi` ON `tedi_curiosity_queue` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_org` ON `tedi_curiosity_queue` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_status` ON `tedi_curiosity_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_curiosity_queue_priority` ON `tedi_curiosity_queue` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_tedi_expertise_tedi` ON `tedi_expertise` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_expertise_domain` ON `tedi_expertise` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_tedi` ON `tedi_optimization_signals` (`tedi_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_org` ON `tedi_optimization_signals` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_status` ON `tedi_optimization_signals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_optimization_signals_roi` ON `tedi_optimization_signals` (`roi`);
--> statement-breakpoint
-- Resolve expertise outbox organization through the local domain, not control-plane tedis.
CREATE TRIGGER `graph_projection_expertise_insert`
AFTER INSERT ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', NEW.`id`, 'upsert',
		json_object('tediId', NEW.`tedi_id`, 'domainId', NEW.`domain_id`)
	FROM `memory_domains` t
	WHERE t.`id` = NEW.`domain_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_update`
AFTER UPDATE ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', NEW.`id`, 'upsert',
		json_object('tediId', NEW.`tedi_id`, 'domainId', NEW.`domain_id`)
	FROM `memory_domains` t
	WHERE t.`id` = NEW.`domain_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_delete`
BEFORE DELETE ON `tedi_expertise`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise', OLD.`id`, 'delete',
		json_object('tediId', OLD.`tedi_id`, 'domainId', OLD.`domain_id`)
	FROM `memory_domains` t
	WHERE t.`id` = OLD.`domain_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_tedi_expertise_domain_insert_scope`
BEFORE INSERT ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_domains` d
	JOIN `tenant_store_identity` identity
	  ON identity.`organization_id` = d.`organization_id` AND identity.`slot` = 1
	WHERE d.`id` = NEW.`domain_id`
)
BEGIN
	SELECT RAISE(ABORT, 'expertise domain is outside this workspace');
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_tedi_expertise_domain_update_scope`
BEFORE UPDATE OF `tedi_id`, `domain_id` ON `tedi_expertise`
WHEN NOT EXISTS (
	SELECT 1
	FROM `memory_domains` d
	JOIN `tenant_store_identity` identity
	  ON identity.`organization_id` = d.`organization_id` AND identity.`slot` = 1
	WHERE d.`id` = NEW.`domain_id`
)
BEGIN
	SELECT RAISE(ABORT, 'expertise domain is outside this workspace');
END;
--> statement-breakpoint
CREATE TRIGGER `graph_projection_expertise_update_old_tuple`
BEFORE UPDATE OF `tedi_id`, `domain_id` ON `tedi_expertise`
WHEN NEW.`tedi_id` != OLD.`tedi_id`
  OR NEW.`domain_id` != OLD.`domain_id`
BEGIN
	INSERT INTO `graph_projection_outbox`
		(`event_id`, `organization_id`, `entity_kind`, `entity_id`, `operation`, `payload`)
	SELECT lower(hex(randomblob(16))), t.`organization_id`, 'tedi_expertise',
		OLD.`id` || ':old:' || lower(hex(randomblob(8))), 'delete',
		json_object('tediId', OLD.`tedi_id`, 'domainId', OLD.`domain_id`)
	FROM `memory_domains` t
	WHERE t.`id` = OLD.`domain_id`;
END;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_curiosity_queue_insert_scope BEFORE INSERT ON tedi_curiosity_queue
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_curiosity_queue_update_scope BEFORE UPDATE ON tedi_curiosity_queue
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_optimization_signals_insert_scope BEFORE INSERT ON tedi_optimization_signals
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
--> statement-breakpoint
CREATE TRIGGER tenant_tedi_optimization_signals_update_scope BEFORE UPDATE ON tedi_optimization_signals
WHEN NOT EXISTS (SELECT 1 FROM tenant_store_identity WHERE slot = 1 AND organization_id = NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'Memory row is outside this workspace'); END;
