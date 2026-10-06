DROP INDEX IF EXISTS `os_instance_deployments_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_deployments_instance_unsettled_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_deployments_instance_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_deployments_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_gatekeepers_instance_vendor_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_gatekeepers_descope_application_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instance_gatekeepers_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instances_slug_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instances_org_slug_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_instances_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_mutation_receipts_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_mutation_receipts_instance_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_mutation_receipts_work_item_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_output_mutation_receipts_skill_run_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_workflow_interactions_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_workflow_interactions_instance_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_workflow_interactions_work_item_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_workflow_interactions_skill_run_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_release_certifications_release_disposition_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_release_certifications_release_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_releases_manifest_sha256_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_releases_manifest_ref_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `os_releases_monorepo_commit_idx`;--> statement-breakpoint
DROP TABLE `os_instance_deployments`;--> statement-breakpoint
DROP TABLE `os_instance_gatekeepers`;--> statement-breakpoint
DROP TABLE `os_instances`;--> statement-breakpoint
DROP TABLE `os_output_mutation_receipts`;--> statement-breakpoint
DROP TABLE `os_workflow_interactions`;--> statement-breakpoint
DROP TABLE `os_release_certifications`;--> statement-breakpoint
DROP TABLE `os_releases`;