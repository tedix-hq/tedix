ALTER TABLE `work_items` ADD `reviewer_lease_expires_at` text;--> statement-breakpoint
CREATE TRIGGER `work_evidence_review_request_outbox`
AFTER INSERT ON `work_evidence`
WHEN NEW.`disposition` = 'pending' AND EXISTS (SELECT 1 FROM `work_items` WHERE `id`=NEW.`work_item_id` AND `org_id`=NEW.`org_id` AND `reviewer_type` IN ('tedi','user') AND `reviewer_id` IS NOT NULL)
BEGIN
	INSERT INTO `work_item_outbox_events` (`id`,`org_id`,`work_item_id`,`event_type`,`source_author_type`,`source_author_id`,`payload`,`created_at`)
	VALUES (lower(hex(randomblob(16))),NEW.`org_id`,NEW.`work_item_id`,'evidence_review_requested',NEW.`submitted_by_type`,NEW.`submitted_by_id`,json_object('evidenceId',NEW.`id`,'claimKey',NEW.`claim_key`,'kind',NEW.`kind`),NEW.`submitted_at`);
	INSERT OR IGNORE INTO `work_item_inbox_deliveries` (`id`,`org_id`,`event_sequence`,`recipient_type`,`recipient_id`,`created_at`)
	SELECT lower(hex(randomblob(16))),NEW.`org_id`,(SELECT max(`sequence`) FROM `work_item_outbox_events`),item.`reviewer_type`,item.`reviewer_id`,NEW.`submitted_at` FROM `work_items` AS item
	WHERE item.`id`=NEW.`work_item_id` AND item.`org_id`=NEW.`org_id` AND item.`reviewer_type` IN ('tedi','user') AND item.`reviewer_id` IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `work_item_reviewer_assignment_outbox`
AFTER UPDATE OF `reviewer_type`,`reviewer_id`,`reviewer_lease_expires_at` ON `work_items`
WHEN (NEW.`reviewer_type` IS NOT OLD.`reviewer_type` OR NEW.`reviewer_id` IS NOT OLD.`reviewer_id` OR NEW.`reviewer_lease_expires_at` IS NOT OLD.`reviewer_lease_expires_at`) AND NEW.`reviewer_type` IN ('tedi','user') AND NEW.`reviewer_id` IS NOT NULL
BEGIN
	INSERT INTO `work_item_outbox_events` (`id`,`org_id`,`work_item_id`,`event_type`,`payload`,`created_at`)
	VALUES (lower(hex(randomblob(16))),NEW.`org_id`,NEW.`id`,'reviewer_assignment',json_object('reviewerType',NEW.`reviewer_type`,'reviewerId',NEW.`reviewer_id`,'leaseExpiresAt',NEW.`reviewer_lease_expires_at`,'workItemVersion',NEW.`version`),coalesce(NEW.`updated_at`,NEW.`created_at`));
	INSERT OR IGNORE INTO `work_item_inbox_deliveries` (`id`,`org_id`,`event_sequence`,`recipient_type`,`recipient_id`,`created_at`)
	VALUES (lower(hex(randomblob(16))),NEW.`org_id`,(SELECT max(`sequence`) FROM `work_item_outbox_events`),NEW.`reviewer_type`,NEW.`reviewer_id`,coalesce(NEW.`updated_at`,NEW.`created_at`));
END;
