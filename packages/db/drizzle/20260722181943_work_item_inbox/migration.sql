CREATE TABLE `work_item_inbox_deliveries` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`event_sequence` integer NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` text NOT NULL,
	`acknowledged_at` text,
	`acknowledged_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_item_inbox_deliveries_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_inbox_deliveries_event_sequence_work_item_outbox_events_sequence_fk` FOREIGN KEY (`event_sequence`) REFERENCES `work_item_outbox_events`(`sequence`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_item_outbox_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`event_type` text NOT NULL,
	`source_session_key` text,
	`source_author_type` text,
	`source_author_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_work_item_outbox_events_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_outbox_events_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_inbox_event_recipient` ON `work_item_inbox_deliveries` (`event_sequence`,`recipient_type`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_inbox_recipient_cursor` ON `work_item_inbox_deliveries` (`org_id`,`recipient_type`,`recipient_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX `idx_work_item_inbox_unread` ON `work_item_inbox_deliveries` (`org_id`,`recipient_id`,`acknowledged_at`);--> statement-breakpoint
CREATE INDEX `idx_work_item_outbox_org_sequence` ON `work_item_outbox_events` (`org_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_work_item_outbox_item` ON `work_item_outbox_events` (`work_item_id`,`sequence`);--> statement-breakpoint
CREATE TRIGGER `work_item_comment_outbox`
AFTER INSERT ON `work_item_comments`
BEGIN
	INSERT INTO `work_item_outbox_events` (
		`id`, `org_id`, `work_item_id`, `event_type`, `source_session_key`,
		`source_author_type`, `source_author_id`, `payload`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), NEW.`org_id`, NEW.`work_item_id`, NEW.`event_type`,
		nullif(json_extract(NEW.`metadata`, '$.agentSession'), ''),
		NEW.`author_type`, NEW.`author_id`,
		json_object('commentId', NEW.`id`, 'body', NEW.`body`, 'eventType', NEW.`event_type`),
		NEW.`created_at`
	);

	INSERT OR IGNORE INTO `work_item_inbox_deliveries` (
		`id`, `org_id`, `event_sequence`, `recipient_type`, `recipient_id`, `created_at`
	)
	SELECT lower(hex(randomblob(16))), NEW.`org_id`, (SELECT max(`sequence`) FROM `work_item_outbox_events`),
		'agent_session', recipients.`recipient_id`, NEW.`created_at`
	FROM (
		SELECT coalesce(
			nullif(json_extract(canonical_checkout.`metadata`, '$.agentSession'), ''),
			canonical_checkout.`executor_session_id`
		) AS `recipient_id`
		FROM `work_item_executor_checkouts` AS canonical_checkout
		WHERE canonical_checkout.`org_id` = NEW.`org_id`
			AND canonical_checkout.`work_item_id` = NEW.`work_item_id`
			AND canonical_checkout.`status` = 'active'
		UNION
		SELECT nullif(json_extract(legacy_checkout.`metadata`, '$.agentSession'), '')
		FROM `work_item_checkouts` AS legacy_checkout
		WHERE legacy_checkout.`org_id` = NEW.`org_id`
			AND legacy_checkout.`work_item_id` = NEW.`work_item_id`
			AND legacy_checkout.`status` = 'active'
	) AS recipients
	WHERE recipients.`recipient_id` IS NOT NULL
		AND recipients.`recipient_id` != coalesce(
			nullif(json_extract(NEW.`metadata`, '$.agentSession'), ''), ''
		);
END;--> statement-breakpoint
CREATE TRIGGER `work_item_assignment_insert_outbox`
AFTER INSERT ON `work_items`
WHEN NEW.`assignee_tedi_id` IS NOT NULL OR NEW.`assignee_user_id` IS NOT NULL
BEGIN
	INSERT INTO `work_item_outbox_events` (
		`id`, `org_id`, `work_item_id`, `event_type`, `source_session_key`, `payload`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), NEW.`org_id`, NEW.`id`, 'assignment',
		nullif(json_extract(NEW.`metadata`, '$.agentSession'), ''),
		json_object('assigneeTediId', NEW.`assignee_tedi_id`, 'assigneeUserId', NEW.`assignee_user_id`),
		NEW.`created_at`
	);
	INSERT OR IGNORE INTO `work_item_inbox_deliveries`
		(`id`, `org_id`, `event_sequence`, `recipient_type`, `recipient_id`, `created_at`)
	SELECT lower(hex(randomblob(16))), NEW.`org_id`, (SELECT max(`sequence`) FROM `work_item_outbox_events`),
		'tedi', NEW.`assignee_tedi_id`, NEW.`created_at`
	WHERE NEW.`assignee_tedi_id` IS NOT NULL;
	INSERT OR IGNORE INTO `work_item_inbox_deliveries`
		(`id`, `org_id`, `event_sequence`, `recipient_type`, `recipient_id`, `created_at`)
	SELECT lower(hex(randomblob(16))), NEW.`org_id`, (SELECT max(`sequence`) FROM `work_item_outbox_events`),
		'user', NEW.`assignee_user_id`, NEW.`created_at`
	WHERE NEW.`assignee_user_id` IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `work_item_assignment_update_outbox`
AFTER UPDATE OF `assignee_tedi_id`, `assignee_user_id` ON `work_items`
WHEN NEW.`assignee_tedi_id` IS NOT OLD.`assignee_tedi_id`
	OR NEW.`assignee_user_id` IS NOT OLD.`assignee_user_id`
BEGIN
	INSERT INTO `work_item_outbox_events` (
		`id`, `org_id`, `work_item_id`, `event_type`, `source_session_key`, `payload`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), NEW.`org_id`, NEW.`id`, 'assignment',
		nullif(json_extract(NEW.`metadata`, '$.agentSession'), ''),
		json_object('assigneeTediId', NEW.`assignee_tedi_id`, 'assigneeUserId', NEW.`assignee_user_id`),
		coalesce(NEW.`updated_at`, NEW.`created_at`)
	);
	INSERT OR IGNORE INTO `work_item_inbox_deliveries`
		(`id`, `org_id`, `event_sequence`, `recipient_type`, `recipient_id`, `created_at`)
	SELECT lower(hex(randomblob(16))), NEW.`org_id`, (SELECT max(`sequence`) FROM `work_item_outbox_events`),
		'tedi', NEW.`assignee_tedi_id`, coalesce(NEW.`updated_at`, NEW.`created_at`)
	WHERE NEW.`assignee_tedi_id` IS NOT NULL;
	INSERT OR IGNORE INTO `work_item_inbox_deliveries`
		(`id`, `org_id`, `event_sequence`, `recipient_type`, `recipient_id`, `created_at`)
	SELECT lower(hex(randomblob(16))), NEW.`org_id`, (SELECT max(`sequence`) FROM `work_item_outbox_events`),
		'user', NEW.`assignee_user_id`, coalesce(NEW.`updated_at`, NEW.`created_at`)
	WHERE NEW.`assignee_user_id` IS NOT NULL;
END;
