/**
 * Role Templates Schema (reusable role primitive)
 *
 * A config-driven role template provisions the four things a tedi's "role"
 * (CMO / CTO / …) is otherwise hand-assembled from — as one unit:
 *
 *   { persona (SOUL) + standing objectives + app-assignment tags + capability
 *     profile }
 *
 * The template is DATA, not runtime logic: platform-wide templates (`orgId`
 * null) are shared blueprints; org-scoped templates override/extend them per
 * tenant. `applyRoleTemplate()` provisions a template onto an EXISTING tedi by
 * reusing the canonical writers (updateTedi for persona/tags/profile,
 * createObjective for standing objectives). It never provisions a runtime by
 * itself — setting `tedis.tags` is the trigger managed app-assignment reconcile
 * keys off, and that reconcile runs separately.
 *
 * D1 is canonical. Fresh CREATE TABLE (real FK on org_id is safe on a table
 * created new) — additive-only, no change to any existing table.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { MCP_CAPABILITY_PROFILE_VALUES } from "./tedis";

/**
 * One standing objective a role template seeds onto a tedi. A role author
 * supplies intent; `applyRoleTemplate` fills the gate and priority defaults
 * at provision time.
 */
export interface RoleTemplateStandingObjective {
	title: string;
	approach?: string;
	successCriteria?: string;
	riskLevel?: "low" | "medium" | "high" | "critical";
	/** Explicit autonomy policy for this role objective; default remains first_n. */
	gateConfig?: Record<string, JsonValue>;
}

export const roleTemplates = sqliteTable(
	"role_templates",
	{
		id: text("id").primaryKey(),

		/**
		 * Owning org, or null for a platform-wide template shared across tenants.
		 * FK cascade cleans org-scoped templates with their org; platform
		 * templates (null) are unaffected.
		 */
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),

		/** Short stable key — unique per (orgId, key). e.g. "cmo", "cto". */
		key: text("key").notNull(),

		name: text("name").notNull(),

		description: text("description"),

		/** The SOUL — persona text set onto `tedis.personality`. Author-supplied. */
		persona: text("persona").notNull(),

		/** Standing objectives seeded onto the tedi (mission-os standing kind). */
		standingObjectives: text("standing_objectives", { mode: "json" })
			.$type<RoleTemplateStandingObjective[]>()
			.notNull()
			.default([]),

		/** Tag-based app-assignment labels unioned onto `tedis.tags`. */
		tags: text("tags", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),

		/** Capability profile written to `tedis.mcpCapabilityProfile`. */
		capabilityProfile: text("capability_profile", {
			enum: [...MCP_CAPABILITY_PROFILE_VALUES],
		})
			.notNull()
			.default("standard"),

		/** Optional cognitive cron names the role expects to exist. */
		cronTemplateNames: text("cron_template_names", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),

		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		archivedAt: text("archived_at"),
	},
	(table) => [
		uniqueIndex("uniq_role_templates_org_key").on(table.orgId, table.key),
	],
);

export type RoleTemplate = typeof roleTemplates.$inferSelect;
export type NewRoleTemplate = typeof roleTemplates.$inferInsert;
