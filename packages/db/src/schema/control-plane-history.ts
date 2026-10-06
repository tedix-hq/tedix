import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const CONTROL_PLANE_DEFINITION_KIND_VALUES = [
	"runtime_profile",
	"policy_pack",
	"workspace_template_set",
] as const;

export type ControlPlaneDefinitionKind =
	(typeof CONTROL_PLANE_DEFINITION_KIND_VALUES)[number];

/**
 * Immutable audit of explicit tedi control-plane rebindings.
 *
 * Revision ids deliberately remain plain text: one discriminated column points
 * at one of three revision tables, which SQLite cannot express as a foreign
 * key. `tedi_id` and `organization_id` keep the durable ownership boundary.
 */
export const tediControlPlaneBindingHistory = sqliteTable(
	"tedi_control_plane_binding_history",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		kind: text("kind", {
			enum: CONTROL_PLANE_DEFINITION_KIND_VALUES,
		}).notNull(),
		previousRevisionId: text("previous_revision_id"),
		revisionId: text("revision_id").notNull(),
		changedBy: text("changed_by"),
		changeReason: text("change_reason"),
		effectiveAt: text("effective_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_control_plane_binding_history_tedi_kind_time").on(
			table.tediId,
			table.kind,
			table.effectiveAt,
		),
		index("idx_tedi_control_plane_binding_history_org").on(
			table.organizationId,
		),
	],
);

export type TediControlPlaneBindingHistoryRow =
	typeof tediControlPlaneBindingHistory.$inferSelect;
export type NewTediControlPlaneBindingHistoryRow =
	typeof tediControlPlaneBindingHistory.$inferInsert;
