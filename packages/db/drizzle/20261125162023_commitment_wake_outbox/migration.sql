CREATE TABLE `commitment_wake_outbox` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`org_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`change_key` text,
	`due_at` text NOT NULL,
	`next_send_at` text NOT NULL,
	`cursor` text,
	`completed_at` text,
	CONSTRAINT `fk_commitment_wake_outbox_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_commitment_wake_outbox_pending` ON `commitment_wake_outbox` (`next_send_at`,`id`) WHERE "commitment_wake_outbox"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_commitment_wake_outbox_completed` ON `commitment_wake_outbox` (`completed_at`) WHERE "commitment_wake_outbox"."completed_at" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_event_insert AFTER INSERT ON work_events
WHEN (NEW.event_type IN ('work.accepted','work.specification_updated','attempt.expired','lane.stale') OR (NEW.event_type = 'attempt.settled' AND (json_extract(NEW.payload, '$.outcome') = 'failed' OR (NEW.actor_type = 'external_agent' AND json_extract(NEW.payload, '$.outcome') = 'succeeded')))) AND (NEW.occurred_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_event:' || NEW.id || ':' || (NEW.occurred_at), 'commitment_wake', NEW.org_id, 'work_event', NEW.id,
  (NEW.occurred_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.occurred_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_approval_insert AFTER INSERT ON work_approval_proposals
WHEN NEW.status IN ('approved','rejected') AND (NEW.resolved_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_approval:' || NEW.id || ':' || (NEW.resolved_at), 'commitment_wake', NEW.org_id, 'work_approval', NEW.id,
  (NEW.resolved_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.resolved_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_approval_update AFTER UPDATE ON work_approval_proposals
WHEN NEW.status IN ('approved','rejected') AND (NEW.resolved_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_approval:' || NEW.id || ':' || (NEW.resolved_at), 'commitment_wake', NEW.org_id, 'work_approval', NEW.id,
  (NEW.resolved_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.resolved_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_tedi_approval_insert AFTER INSERT ON tedi_approval_requests
WHEN NEW.status IN ('approved','rejected') AND NEW.workflow_id IS NULL AND NEW.resolved_by IS NOT 'policy' AND (NEW.resolved_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('tedi_approval:' || NEW.id || ':' || (NEW.resolved_at), 'commitment_wake', NEW.org_id, 'tedi_approval', NEW.id,
  (NEW.resolved_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.resolved_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_tedi_approval_update AFTER UPDATE ON tedi_approval_requests
WHEN NEW.status IN ('approved','rejected') AND NEW.workflow_id IS NULL AND NEW.resolved_by IS NOT 'policy' AND (NEW.resolved_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('tedi_approval:' || NEW.id || ':' || (NEW.resolved_at), 'commitment_wake', NEW.org_id, 'tedi_approval', NEW.id,
  (NEW.resolved_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.resolved_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_interaction_response_insert AFTER INSERT ON work_interaction_responses
WHEN NEW.resolves_request = 1 AND (NEW.responded_at) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction_response:' || NEW.id || ':' || (NEW.responded_at), 'commitment_wake', NEW.org_id, 'interaction_response', NEW.id,
  (NEW.responded_at), strftime('%Y-%m-%dT%H:%M:%fZ', (NEW.responded_at), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_gadget_insert AFTER INSERT ON os_gadget_executions
WHEN NEW.status IN ('failed', 'completed') AND NEW.completed_at IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
 VALUES ('gadget:' || NEW.id || ':' || NEW.completed_at || ':' || ('factory:' || NEW.id || ':' || NEW.status),
 'commitment_wake', NEW.organization_id, 'gadget', NEW.id, NEW.completed_at,
 strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at, '+30 seconds'), ('factory:' || NEW.id || ':' || NEW.status));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_gadget_update AFTER UPDATE ON os_gadget_executions
WHEN NEW.status IN ('failed', 'completed') AND NEW.completed_at IS NOT NULL AND (NEW.completed_at IS NOT OLD.completed_at OR NEW.status IS NOT OLD.status)
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
 VALUES ('gadget:' || NEW.id || ':' || NEW.completed_at || ':' || ('factory:' || NEW.id || ':' || NEW.status),
 'commitment_wake', NEW.organization_id, 'gadget', NEW.id, NEW.completed_at,
 strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at, '+30 seconds'), ('factory:' || NEW.id || ':' || NEW.status));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_skill_insert AFTER INSERT ON skill_runs
WHEN NEW.status IN ('failed', 'completed') AND NEW.completed_at IS NOT NULL AND (NEW.work_item_id IS NOT NULL OR NEW.origin_tedi_run_id IS NOT NULL)
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
 VALUES ('skill:' || NEW.id || ':' || NEW.completed_at || ':' || ('skill:' || NEW.id || ':' || NEW.execution_epoch || ':' || NEW.status),
 'commitment_wake', NEW.organization_id, 'skill', NEW.id, NEW.completed_at,
 strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at, '+30 seconds'), ('skill:' || NEW.id || ':' || NEW.execution_epoch || ':' || NEW.status));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_skill_update AFTER UPDATE ON skill_runs
WHEN NEW.status IN ('failed', 'completed') AND NEW.completed_at IS NOT NULL AND (NEW.work_item_id IS NOT NULL OR NEW.origin_tedi_run_id IS NOT NULL) AND (NEW.completed_at IS NOT OLD.completed_at OR NEW.status IS NOT OLD.status OR NEW.execution_epoch IS NOT OLD.execution_epoch)
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at, change_key)
 VALUES ('skill:' || NEW.id || ':' || NEW.completed_at || ':' || ('skill:' || NEW.id || ':' || NEW.execution_epoch || ':' || NEW.status),
 'commitment_wake', NEW.organization_id, 'skill', NEW.id, NEW.completed_at,
 strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at, '+30 seconds'), ('skill:' || NEW.id || ':' || NEW.execution_epoch || ':' || NEW.status));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_item_insert AFTER INSERT ON work_items
WHEN NEW.disposition NOT IN ('completed','cancelled') AND (coalesce(NEW.deadline, NEW.due_date)) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_item:' || NEW.id || ':' || (coalesce(NEW.deadline, NEW.due_date)), 'commitment_wake', NEW.org_id, 'work_item', NEW.id,
  (coalesce(NEW.deadline, NEW.due_date)), strftime('%Y-%m-%dT%H:%M:%fZ', (coalesce(NEW.deadline, NEW.due_date)), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_item_update AFTER UPDATE ON work_items
WHEN NEW.disposition NOT IN ('completed','cancelled') AND (coalesce(NEW.deadline, NEW.due_date)) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_item:' || NEW.id || ':' || (coalesce(NEW.deadline, NEW.due_date)), 'commitment_wake', NEW.org_id, 'work_item', NEW.id,
  (coalesce(NEW.deadline, NEW.due_date)), strftime('%Y-%m-%dT%H:%M:%fZ', (coalesce(NEW.deadline, NEW.due_date)), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_idle_insert AFTER INSERT ON work_items
WHEN NEW.disposition = 'accepted' AND NEW.accountable_owner_type = 'user' AND (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_item:' || NEW.id || ':' || (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), 'commitment_wake', NEW.org_id, 'work_item', NEW.id,
  (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), strftime('%Y-%m-%dT%H:%M:%fZ', (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_work_idle_update AFTER UPDATE ON work_items
WHEN NEW.disposition = 'accepted' AND NEW.accountable_owner_type = 'user' AND (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('work_item:' || NEW.id || ':' || (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), 'commitment_wake', NEW.org_id, 'work_item', NEW.id,
  (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), strftime('%Y-%m-%dT%H:%M:%fZ', (strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(NEW.updated_at, NEW.accepted_at, NEW.created_at), '+2 days')), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_interaction_insert AFTER INSERT ON work_interactions
WHEN NEW.status = 'open' AND (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction:' || NEW.id || ':' || (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), 'commitment_wake', NEW.org_id, 'interaction', NEW.id,
  (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), strftime('%Y-%m-%dT%H:%M:%fZ', (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_interaction_update AFTER UPDATE ON work_interactions
WHEN NEW.status = 'open' AND (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('interaction:' || NEW.id || ':' || (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), 'commitment_wake', NEW.org_id, 'interaction', NEW.id,
  (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), strftime('%Y-%m-%dT%H:%M:%fZ', (coalesce(NEW.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+2 days'))), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_memory_insert AFTER INSERT ON memory_facts
WHEN NEW.fact_type = 'commitment' AND NEW.archived_at IS NULL AND NEW.valid_to IS NULL AND NEW.review_status NOT IN ('rejected','superseded','disputed') AND (json_extract(NEW.metadata, '$.dueAt')) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('memory:' || NEW.id || ':' || (json_extract(NEW.metadata, '$.dueAt')), 'commitment_wake', NEW.organization_id, 'memory', NEW.id,
  (json_extract(NEW.metadata, '$.dueAt')), strftime('%Y-%m-%dT%H:%M:%fZ', (json_extract(NEW.metadata, '$.dueAt')), '+30 seconds'));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_wake_outbox_memory_update AFTER UPDATE ON memory_facts
WHEN NEW.fact_type = 'commitment' AND NEW.archived_at IS NULL AND NEW.valid_to IS NULL AND NEW.review_status NOT IN ('rejected','superseded','disputed') AND (json_extract(NEW.metadata, '$.dueAt')) IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO commitment_wake_outbox(id, kind, org_id, source_kind, source_id, due_at, next_send_at)
 VALUES ('memory:' || NEW.id || ':' || (json_extract(NEW.metadata, '$.dueAt')), 'commitment_wake', NEW.organization_id, 'memory', NEW.id,
  (json_extract(NEW.metadata, '$.dueAt')), strftime('%Y-%m-%dT%H:%M:%fZ', (json_extract(NEW.metadata, '$.dueAt')), '+30 seconds'));
END;
