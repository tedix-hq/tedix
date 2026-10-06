CREATE TABLE `os_release_certifications` (
	`id` text PRIMARY KEY,
	`release_id` text NOT NULL,
	`disposition` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`evidence_json` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_release_certifications_release_id_os_releases_id_fk` FOREIGN KEY (`release_id`) REFERENCES `os_releases`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `os_releases` (
	`id` text PRIMARY KEY,
	`manifest_sha256` text NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_ref` text NOT NULL,
	`monorepo_commit` text NOT NULL,
	`import_provenance_sha256` text NOT NULL,
	`artifact_set_sha256` text NOT NULL,
	`config_schema_version` text NOT NULL,
	`minimum_tedix_contract_version` text NOT NULL,
	`registered_by_type` text NOT NULL,
	`registered_by_id` text NOT NULL,
	`registered_by_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `os_instance_deployments` ADD `release_manifest_sha256` text;--> statement-breakpoint
ALTER TABLE `os_instance_deployments` ADD `release_manifest_json` text;--> statement-breakpoint
ALTER TABLE `os_instance_deployments` ADD `release_certification_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `os_release_certifications_release_disposition_unique` ON `os_release_certifications` (`release_id`,`disposition`);--> statement-breakpoint
CREATE INDEX `os_release_certifications_release_created_idx` ON `os_release_certifications` (`release_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_releases_manifest_sha256_unique` ON `os_releases` (`manifest_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_releases_manifest_ref_unique` ON `os_releases` (`manifest_ref`);--> statement-breakpoint
CREATE INDEX `os_releases_monorepo_commit_idx` ON `os_releases` (`monorepo_commit`);