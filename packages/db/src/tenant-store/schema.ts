/**
 * Core tables of one workspace's TenantStore Durable Object SQLite database.
 *
 * Domain tables (outputs, runs, memory) are added by the tenant-port stories.
 * They live in this file too so `drizzle.tenant-store.config.ts` generates one
 * migration chain per store.
 */
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** The one scope this object serves; written on first use and never changed. */
export const tenantStoreIdentity = sqliteTable(
	"tenant_store_identity",
	{
		slot: integer("slot").primaryKey(),
		organizationId: text("organization_id").notNull(),
		workspaceId: text("workspace_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		check("tenant_store_identity_single_row", sql`${table.slot} = 1`),
	],
);

/** Receipts that make bulk-import batches idempotent for the migration pipeline. */
export const tenantStoreImportBatches = sqliteTable(
	"tenant_store_import_batches",
	{
		batchId: text("batch_id").primaryKey(),
		tableName: text("table_name").notNull(),
		rowCount: integer("row_count").notNull(),
		importedAt: text("imported_at").notNull(),
	},
);
