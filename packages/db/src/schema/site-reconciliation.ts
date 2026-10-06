import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const siteReconciliationRuns = sqliteTable(
	"site_reconciliation_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		source: text("source", { enum: ["manual", "scheduled"] }).notNull(),
		startedAt: text("started_at").notNull(),
		completedAt: text("completed_at").notNull(),
		sitesChecked: integer("sites_checked").notNull(),
		issueCount: integer("issue_count").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_site_reconciliation_runs_org_completed").on(
			table.organizationId,
			table.completedAt,
		),
	],
);

export const siteReconciliationFindings = sqliteTable(
	"site_reconciliation_findings",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => siteReconciliationRuns.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		siteId: text("site_id").notNull(),
		siteSlug: text("site_slug").notNull(),
		siteType: text("site_type", { enum: ["cms", "docs"] }).notNull(),
		code: text("code").notNull(),
		severity: text("severity", { enum: ["warning", "error"] }).notNull(),
		detail: text("detail").notNull(),
		firstDetectedAt: text("first_detected_at").notNull(),
		lastDetectedAt: text("last_detected_at").notNull(),
		resolvedAt: text("resolved_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("idx_site_reconciliation_findings_identity").on(
			table.organizationId,
			table.siteId,
			table.code,
			table.firstDetectedAt,
		),
		index("idx_site_reconciliation_findings_open").on(
			table.organizationId,
			table.resolvedAt,
			table.lastDetectedAt,
		),
		index("idx_site_reconciliation_findings_run").on(table.runId),
	],
);

export type SiteReconciliationRun = typeof siteReconciliationRuns.$inferSelect;
export type SiteReconciliationFinding =
	typeof siteReconciliationFindings.$inferSelect;
