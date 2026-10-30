import { sql } from "drizzle-orm";
import {
	check,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** One replaceable current health report for each local dispatcher lane. */
export const dispatcherHealthReports = sqliteTable(
	"dispatcher_health_reports",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		reporterId: text("reporter_id").notNull(),
		executor: text("executor").notNull(),
		lane: text("lane").notNull(),
		running: integer("running", { mode: "boolean" }).notNull(),
		observedAt: text("observed_at").notNull(),
		reportedAt: text("reported_at").notNull(),
		lastAdmissionAt: text("last_admission_at"),
		slotsInUse: integer("slots_in_use").notNull(),
		slotsTotal: integer("slots_total").notNull(),
		topReason: text("top_reason"),
		topReasonCount: integer("top_reason_count"),
	},
	(table) => [
		primaryKey({
			columns: [table.orgId, table.reporterId, table.executor, table.lane],
		}),
		check(
			"chk_dispatcher_health_strings",
			sql`length(${table.reporterId}) BETWEEN 1 AND 128
				AND length(${table.executor}) BETWEEN 1 AND 64
				AND length(${table.lane}) BETWEEN 1 AND 128
				AND (${table.topReason} IS NULL OR length(${table.topReason}) BETWEEN 1 AND 500)`,
		),
		check(
			"chk_dispatcher_health_slots",
			sql`${table.slotsInUse} BETWEEN 0 AND 10000
				AND ${table.slotsTotal} BETWEEN 0 AND 10000
				AND ${table.slotsInUse} <= ${table.slotsTotal}`,
		),
		check(
			"chk_dispatcher_health_reason",
			sql`(${table.topReason} IS NULL AND ${table.topReasonCount} IS NULL)
				OR (${table.topReason} IS NOT NULL AND ${table.topReasonCount} BETWEEN 1 AND 1000000)`,
		),
	],
);

export type DispatcherHealthReportRow =
	typeof dispatcherHealthReports.$inferSelect;
export type NewDispatcherHealthReportRow =
	typeof dispatcherHealthReports.$inferInsert;
