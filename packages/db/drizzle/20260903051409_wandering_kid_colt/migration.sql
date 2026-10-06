ALTER TABLE `tedi_provisional_outcomes` ADD `state` text DEFAULT 'provisional' NOT NULL;--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `promotion_approval_request_id` text REFERENCES tedi_approval_requests(id);--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `promoted_at` text;--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `promoted_by` text;--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `rolled_back_at` text;--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `rolled_back_by` text;--> statement-breakpoint
ALTER TABLE `tedi_provisional_outcomes` ADD `rollback_reason` text;