/**
 * Tedi Growth Snapshots Schema
 * Weekly snapshots of tedi cognitive metrics.
 * Powers the Growth Timeline trend chart.
 */

import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tedis } from "./tedis";
import { organizations } from "./organizations";

export const tediGrowthSnapshots = sqliteTable(
	"tedi_growth_snapshots",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		snapshotDate: text("snapshot_date").notNull(), // ISO date YYYY-MM-DD
		metrics: text("metrics", { mode: "json" })
			.$type<GrowthSnapshotMetrics>()
			.notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_growth_snapshot_tedi_date").on(
			table.tediId,
			table.snapshotDate,
		),
		index("idx_growth_snapshot_org").on(table.orgId),
	],
);

export type GrowthSnapshotMetrics = {
	facts: number;
	avgConfidence: number;
	skills: number;
	avgRevision: number;
	muscles: number;
	avgUsage: number;
	domains: number;
	autonomyRate: number;
	expertiseLevels: Record<string, string>; // domainId -> level
};

export type TediGrowthSnapshot = typeof tediGrowthSnapshots.$inferSelect;
export type NewTediGrowthSnapshot = typeof tediGrowthSnapshots.$inferInsert;
