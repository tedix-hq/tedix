ALTER TABLE `os_gadget_executions` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `workflow_instance_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `tedi_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `work_item_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `trace_bundle_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `billing_reservation_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `approval_request_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `runtime_environment` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `agent_session_id` text;--> statement-breakpoint
ALTER TABLE `os_gadget_executions` ADD `execution_epoch` integer DEFAULT 0 NOT NULL;