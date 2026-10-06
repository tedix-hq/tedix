CREATE TABLE `tedi_approval_dependency_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`dependent_approval_request_id` text NOT NULL,
	`prerequisite_approval_request_id` text NOT NULL,
	`simulation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`dependency_kind` text NOT NULL,
	`invalidates_event_id` text,
	`reason` text,
	`record_hash` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_tedi_approval_dependency_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_dependency_events_dependent_approval_request_id_tedi_approval_requests_id_fk` FOREIGN KEY (`dependent_approval_request_id`) REFERENCES `tedi_approval_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_dependency_events_prerequisite_approval_request_id_tedi_approval_requests_id_fk` FOREIGN KEY (`prerequisite_approval_request_id`) REFERENCES `tedi_approval_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_dependency_events_simulation_id_tedi_approval_simulations_id_fk` FOREIGN KEY (`simulation_id`) REFERENCES `tedi_approval_simulations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_dependency_events_invalidates_event_id_tedi_approval_dependency_events_id_fk` FOREIGN KEY (`invalidates_event_id`) REFERENCES `tedi_approval_dependency_events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tedi_approval_execution_receipts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`simulation_id` text,
	`idempotency_key` text NOT NULL,
	`canonical_input_hash` text NOT NULL,
	`record_hash` text NOT NULL,
	`baseline_fence_outcome` text NOT NULL,
	`outcome` text NOT NULL,
	`observed_result` text,
	`observed_error` text,
	`provider_receipt_refs` text NOT NULL,
	`executed_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_tedi_approval_execution_receipts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_execution_receipts_approval_request_id_tedi_approval_requests_id_fk` FOREIGN KEY (`approval_request_id`) REFERENCES `tedi_approval_requests`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_execution_receipts_simulation_id_tedi_approval_simulations_id_fk` FOREIGN KEY (`simulation_id`) REFERENCES `tedi_approval_simulations`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tedi_approval_simulations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`simulator_id` text NOT NULL,
	`simulator_version` text NOT NULL,
	`canonical_input_hash` text NOT NULL,
	`record_hash` text NOT NULL,
	`baseline_evidence_refs` text NOT NULL,
	`predicted_result` text NOT NULL,
	`assumptions` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence_kind` text DEFAULT 'simulation' NOT NULL,
	`not_proof` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_tedi_approval_simulations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_approval_simulations_approval_request_id_tedi_approval_requests_id_fk` FOREIGN KEY (`approval_request_id`) REFERENCES `tedi_approval_requests`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_approval_dependency_dependent_created` ON `tedi_approval_dependency_events` (`organization_id`,`dependent_approval_request_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_dependency_prerequisite` ON `tedi_approval_dependency_events` (`organization_id`,`prerequisite_approval_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_approval_dependency_invalidation` ON `tedi_approval_dependency_events` (`invalidates_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_approval_execution_receipt_idempotency` ON `tedi_approval_execution_receipts` (`organization_id`,`approval_request_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_approval_execution_receipts_request_executed` ON `tedi_approval_execution_receipts` (`organization_id`,`approval_request_id`,`executed_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_simulations_request_created` ON `tedi_approval_simulations` (`organization_id`,`approval_request_id`,`created_at`);