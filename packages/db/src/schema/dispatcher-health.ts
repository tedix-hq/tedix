import { sql } from "drizzle-orm";
import {
	check,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import type { SupervisorDutyHealth } from "@tedix/api-contract/schemas/dispatcher-health";

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
		topReason: text("top_reason"),
		topReasonCount: integer("top_reason_count"),
		duty: text("duty", { mode: "json" }).$type<SupervisorDutyHealth>(),
		/** The readable name of the machine this runner is on. */
		machineName: text("machine_name"),
		cliVersion: text("cli_version"),
		/** The read-only machine tools this machine accepts. */
		machineTools: text("machine_tools", { mode: "json" }).$type<string[]>(),
		/**
		 * The account that sent this report, such as `user:<id>`. Only the same
		 * account may claim the machine's tool calls under this reporter id.
		 */
		reportedBy: text("reported_by"),
		/**
		 * The skill whose text this runner reads as its standing rules on every
		 * pass. The runner declares it, so the skill can show who depends on it.
		 */
		rulesSkillId: text("rules_skill_id"),
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
