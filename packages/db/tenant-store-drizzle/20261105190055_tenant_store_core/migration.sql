CREATE TABLE `tenant_store_identity` (
	`slot` integer PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "tenant_store_identity_single_row" CHECK("slot" = 1)
);
--> statement-breakpoint
CREATE TABLE `tenant_store_import_batches` (
	`batch_id` text PRIMARY KEY,
	`table_name` text NOT NULL,
	`row_count` integer NOT NULL,
	`imported_at` text NOT NULL
);
