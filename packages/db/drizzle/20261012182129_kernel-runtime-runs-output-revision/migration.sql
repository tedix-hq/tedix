ALTER TABLE `kernel_runtime_runs` ADD `output_revision_id` text;--> statement-breakpoint
CREATE INDEX `idx_kernel_runtime_runs_org_output_revision` ON `kernel_runtime_runs` (`organization_id`,`output_revision_id`);--> statement-breakpoint
UPDATE `kernel_runtime_runs` SET `output_revision_id` = json_extract(`metadata`, '$.kernelOutputReceipt.revisionId') WHERE `status` = 'completed' AND json_valid(`metadata`) AND json_extract(`metadata`, '$.kernelEvidence.toolName') IN ('os.create_os_output', 'os__create_os_output') AND json_type(`metadata`, '$.kernelOutputReceipt.revisionId') = 'text';
