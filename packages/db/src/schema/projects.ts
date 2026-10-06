/**
 * Projects Schema (work hierarchy v1)
 *
 * A thin org-scoped container that anchors the work hierarchy
 * project → epic → feature → story → work_item → task. Projects sit at the top
 * of the tree; the tiers below live as typed `work_items` rows
 * (`work_items.workKind`, `work_items.projectId`). This is deliberately NOT a
 * second canonical board — Work Items stay the coordination truth; a project is
 * just the grouping + rollup anchor (Jira/SAFe-style, HTN task decomposition).
 *
 * D1 is canonical. New table (fresh CREATE TABLE — real FKs are safe on a table
 * created new), unlike the additive-only ALTERs on the pre-existing `work_items`
 * table.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tediObjectives } from "./tedi-objectives";
import { tedis } from "./tedis";

export const PROJECT_STATUS_VALUES = [
	"active",
	"paused",
	"archived",
	"done",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUS_VALUES)[number];

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** Short human key, unique per org — "PLAT", "GROWTH". */
		key: text("key").notNull(),

		name: text("name").notNull(),

		description: text("description"),

		status: text("status", { enum: PROJECT_STATUS_VALUES })
			.notNull()
			.default("active"),

		/** Accountable digital worker for the project — null when unassigned. */
		leadTediId: text("lead_tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),

		/** Human owner, when a person (not a tedi) owns the project. */
		ownerUserId: text("owner_user_id"),

		/** Optional mission directive this project serves. */
		objectiveId: text("objective_id").references(() => tediObjectives.id, {
			onDelete: "set null",
		}),

		targetDate: text("target_date"),

		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		archivedAt: text("archived_at"),
	},
	(table) => [
		uniqueIndex("uniq_projects_org_id").on(table.orgId, table.id),
		uniqueIndex("uniq_projects_org_key").on(table.orgId, table.key),
		index("idx_projects_org_status").on(table.orgId, table.status),
	],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
