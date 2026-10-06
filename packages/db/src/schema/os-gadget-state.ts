import {
	integer,
	sqliteTable,
	text,
	primaryKey,
	index,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { osGadgets } from "./os-workspaces";
/** Mutable application values with monotonic revisions and deletion tombstones. */
export const osGadgetState = sqliteTable(
	"os_gadget_state",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		gadgetId: text("gadget_id")
			.notNull()
			.references(() => osGadgets.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		revision: integer("revision").notNull(),
		value: text("value"),
		deleted: integer("deleted", { mode: "boolean" }).notNull(),
		accessEnvelope: text("access_envelope").notNull(),
		executionId: text("execution_id").notNull(),
		lastMutationId: text("last_mutation_id").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.gadgetId, table.key] }),
		index("os_gadget_state_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
		),
	],
);
/** Stable idempotency receipts, atomically settled alongside each attempted CAS mutation. */
export const osGadgetStateMutations = sqliteTable(
	"os_gadget_state_mutations",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		gadgetId: text("gadget_id")
			.notNull()
			.references(() => osGadgets.id, { onDelete: "cascade" }),
		idempotencyKey: text("idempotency_key").notNull(),
		digest: text("digest").notNull(),
		status: text("status", {
			enum: ["pending", "applied", "conflict"],
		}).notNull(),
		result: text("result"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.gadgetId, table.idempotencyKey],
		}),
	],
);
export type OsGadgetStateRow = typeof osGadgetState.$inferSelect;
export type OsGadgetStateMutationRow =
	typeof osGadgetStateMutations.$inferSelect;
