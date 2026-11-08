/**
 * Core tables of one workspace's TenantStore Durable Object SQLite database.
 *
 * Domain tables (outputs, runs, memory) are added by the tenant-port stories.
 * Memory tables live in `memory-schema/`; `drizzle.tenant-store.config.ts`
 * includes both in one migration chain per store.
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

/** Memory-only objects cannot acquire a workspace identity or change owners. */
export const memoryStoreIdentity = sqliteTable(
	"memory_store_identity",
	{
		slot: integer("slot").primaryKey(),
		organizationId: text("organization_id").notNull(),
		kind: text("kind", {
			enum: ["organization", "workspace", "personal"],
		}).notNull(),
		ownerId: text("owner_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		check("memory_store_identity_single_row", sql`${table.slot} = 1`),
		check(
			"memory_store_identity_kind",
			sql`${table.kind} IN ('organization','workspace','personal')`,
		),
		check(
			"memory_store_identity_owner",
			sql`length(trim(${table.ownerId})) > 0 AND (${table.kind} != 'organization' OR ${table.ownerId} = ${table.organizationId})`,
		),
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
