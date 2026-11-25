-- tedix: destructive-reviewed Work-Item: 86f03a69-9a5f-4eff-a64e-9086388e1c71
-- Only derived work_due timers are deleted by triggers. Source objects are preserved;
-- the backfill statements below reconstruct all eligible timers from those objects.
CREATE TABLE `work_due` (
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_id` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_until` text DEFAULT '' NOT NULL,
	CONSTRAINT `work_due_pk` PRIMARY KEY(`org_id`, `kind`, `object_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_work_due_status_due` ON `work_due` (`status`,`due_at`);
--> statement-breakpoint
CREATE TRIGGER work_due_approval_expiry_insert AFTER INSERT ON tedi_approval_requests BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='approval-expiry' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'approval-expiry',id,expires_at,'pending','' FROM tedi_approval_requests
		WHERE (status='pending') AND (id=NEW.id) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_approval_expiry_update AFTER UPDATE ON tedi_approval_requests BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='approval-expiry' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'approval-expiry',id,expires_at,'pending','' FROM tedi_approval_requests
		WHERE (status='pending') AND (id=NEW.id) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_approval_expiry_delete AFTER DELETE ON tedi_approval_requests BEGIN
			DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='approval-expiry' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_approval_redrive_insert AFTER INSERT ON work_approval_proposals BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-approval-redrive' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-approval-redrive',id,created_at,'pending','' FROM work_approval_proposals
		WHERE (status='pending' AND approver_type='tedi' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (id=NEW.id) AND (created_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_approval_redrive_update AFTER UPDATE ON work_approval_proposals BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-approval-redrive' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-approval-redrive',id,created_at,'pending','' FROM work_approval_proposals
		WHERE (status='pending' AND approver_type='tedi' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (id=NEW.id) AND (created_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_approval_redrive_delete AFTER DELETE ON work_approval_proposals BEGIN
			DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='work-approval-redrive' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_interaction_review_dispatch_insert AFTER INSERT ON work_interactions BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='interaction-review-dispatch' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes'))),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(json_extract(metadata,'$.followThrough.reviewWakeVersion'),0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
				AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
				AND r.id IS NOT json_extract(work_interactions.metadata,'$.followThrough.receipt.responseId')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.id) AND (iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes')))) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_interaction_review_dispatch_update AFTER UPDATE ON work_interactions BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='interaction-review-dispatch' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes'))),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(json_extract(metadata,'$.followThrough.reviewWakeVersion'),0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
				AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
				AND r.id IS NOT json_extract(work_interactions.metadata,'$.followThrough.receipt.responseId')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.id) AND (iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes')))) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_interaction_review_dispatch_delete AFTER DELETE ON work_interactions BEGIN
			DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='interaction-review-dispatch' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_delegated_run_deadline_sweep_insert AFTER INSERT ON kernel_runtime_runs BEGIN
			DELETE FROM work_due WHERE org_id=NEW.organization_id AND kind='delegated-run-deadline-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'delegated-run-deadline-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds'),'pending','' FROM kernel_runtime_runs
		WHERE (status IN ('queued','running') AND delegated_tedi_id IS NOT NULL AND child_run_id IS NOT NULL) AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_delegated_run_deadline_sweep_update AFTER UPDATE ON kernel_runtime_runs BEGIN
			DELETE FROM work_due WHERE org_id=NEW.organization_id AND kind='delegated-run-deadline-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'delegated-run-deadline-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds'),'pending','' FROM kernel_runtime_runs
		WHERE (status IN ('queued','running') AND delegated_tedi_id IS NOT NULL AND child_run_id IS NOT NULL) AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_delegated_run_deadline_sweep_delete AFTER DELETE ON kernel_runtime_runs BEGIN
			DELETE FROM work_due WHERE org_id=OLD.organization_id AND kind='delegated-run-deadline-sweep' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_agent_run_supervision_insert AFTER INSERT ON work_items BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='agent-run-supervision' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'agent-run-supervision',id,strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes'),'pending','' FROM work_items
		WHERE (disposition='accepted' AND executor_type='external_agent' AND steward_type='tedi' AND source_session_key IS NOT NULL AND metadata_source='tedi.start_agent_run') AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_agent_run_supervision_update AFTER UPDATE ON work_items BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='agent-run-supervision' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'agent-run-supervision',id,strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes'),'pending','' FROM work_items
		WHERE (disposition='accepted' AND executor_type='external_agent' AND steward_type='tedi' AND source_session_key IS NOT NULL AND metadata_source='tedi.start_agent_run') AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_agent_run_supervision_delete AFTER DELETE ON work_items BEGIN
			DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='agent-run-supervision' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_orphan_run_sweep_insert AFTER INSERT ON tedi_runtime_events BEGIN
			DELETE FROM work_due WHERE org_id=NEW.organization_id AND kind='orphan-run-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'orphan-run-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes'),'pending','' FROM tedi_runtime_events
		WHERE (kind='run.started' AND terminal_seen=0 AND run_id IS NOT NULL) AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_orphan_run_sweep_update AFTER UPDATE ON tedi_runtime_events BEGIN
			DELETE FROM work_due WHERE org_id=NEW.organization_id AND kind='orphan-run-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'orphan-run-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes'),'pending','' FROM tedi_runtime_events
		WHERE (kind='run.started' AND terminal_seen=0 AND run_id IS NOT NULL) AND (id=NEW.id) AND (strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_orphan_run_sweep_delete AFTER DELETE ON tedi_runtime_events BEGIN
			DELETE FROM work_due WHERE org_id=OLD.organization_id AND kind='orphan-run-sweep' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_attempt_lease_sweep_insert AFTER INSERT ON work_attempts BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-attempt-lease-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-attempt-lease-sweep',id,expires_at,'pending','' FROM work_attempts
		WHERE (runtime_state IN ('queued','running','waiting','retrying') AND expires_at IS NOT NULL) AND (id=NEW.id) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_attempt_lease_sweep_update AFTER UPDATE ON work_attempts BEGIN
			DELETE FROM work_due WHERE org_id=NEW.org_id AND kind='work-attempt-lease-sweep' AND object_id=NEW.id;
			INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-attempt-lease-sweep',id,expires_at,'pending','' FROM work_attempts
		WHERE (runtime_state IN ('queued','running','waiting','retrying') AND expires_at IS NOT NULL) AND (id=NEW.id) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_work_attempt_lease_sweep_delete AFTER DELETE ON work_attempts BEGIN
			DELETE FROM work_due WHERE org_id=OLD.org_id AND kind='work-attempt-lease-sweep' AND object_id=OLD.id;
		END;
--> statement-breakpoint
CREATE TRIGGER work_due_review_response_insert AFTER INSERT ON work_interaction_responses BEGIN
		INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes'))),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(json_extract(metadata,'$.followThrough.reviewWakeVersion'),0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
				AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
				AND r.id IS NOT json_extract(work_interactions.metadata,'$.followThrough.receipt.responseId')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.interaction_id AND org_id=NEW.org_id) AND (iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes')))) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
	END;
--> statement-breakpoint
CREATE TRIGGER work_due_review_response_update AFTER UPDATE ON work_interaction_responses BEGIN
		INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes'))),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(json_extract(metadata,'$.followThrough.reviewWakeVersion'),0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
				AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
				AND r.id IS NOT json_extract(work_interactions.metadata,'$.followThrough.receipt.responseId')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (id=NEW.interaction_id AND org_id=NEW.org_id) AND (iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes')))) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
	END;
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'approval-expiry',id,expires_at,'pending','' FROM tedi_approval_requests
		WHERE (status='pending') AND (1) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-approval-redrive',id,created_at,'pending','' FROM work_approval_proposals
		WHERE (status='pending' AND approver_type='tedi' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (1) AND (created_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'interaction-review-dispatch',id,iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes'))),'pending','' FROM work_interactions
		WHERE (target_type='user' AND kind<>'coordination' AND (
			(status='open' AND coalesce(json_extract(metadata,'$.followThrough.reviewWakeVersion'),0)<>version)
			OR (status='resolved' AND EXISTS (SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id=work_interactions.org_id AND r.interaction_id=work_interactions.id
				AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
				AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
				AND r.id IS NOT json_extract(work_interactions.metadata,'$.followThrough.receipt.responseId')
				AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))) AND (1) AND (iif(status='open', coalesce(json_extract(metadata,'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+3 days')),
			coalesce(json_extract(metadata,'$.followThrough.continuationRetryAt'),strftime('%Y-%m-%dT%H:%M:%fZ',resolved_at,'+5 minutes')))) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'delegated-run-deadline-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds'),'pending','' FROM kernel_runtime_runs
		WHERE (status IN ('queued','running') AND delegated_tedi_id IS NOT NULL AND child_run_id IS NOT NULL) AND (1) AND (strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(coalesce(started_at,created_at)),julianday(updated_at)),'+90 seconds')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'agent-run-supervision',id,strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes'),'pending','' FROM work_items
		WHERE (disposition='accepted' AND executor_type='external_agent' AND steward_type='tedi' AND source_session_key IS NOT NULL AND metadata_source='tedi.start_agent_run') AND (created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(json_extract(metadata,'$.agentRunSupervision.lastRoundAt'),created_at),'+5 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT organization_id,'orphan-run-sweep',id,strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes'),'pending','' FROM tedi_runtime_events
		WHERE (kind='run.started' AND terminal_seen=0 AND run_id IS NOT NULL) AND (created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AND (strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+12 minutes')) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
--> statement-breakpoint
INSERT INTO work_due (org_id,kind,object_id,due_at,status,lease_until)
		SELECT org_id,'work-attempt-lease-sweep',id,expires_at,'pending','' FROM work_attempts
		WHERE (runtime_state IN ('queued','running','waiting','retrying') AND expires_at IS NOT NULL) AND (1) AND (expires_at) IS NOT NULL
		ON CONFLICT(org_id,kind,object_id) DO UPDATE SET due_at=excluded.due_at,status='pending',lease_until='';
