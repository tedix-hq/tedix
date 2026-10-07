/**
 * Widget Test Runs Schema
 *
 * Retired: widget browser testing was removed and nothing reads or writes
 * this table. The model stays so migration history and drift checks keep
 * describing the existing D1 table until a deliberate drop migration.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const widgetTestRuns = sqliteTable(
	"widget_test_runs",
	{
		id: text("id").primaryKey(),

		/** App that was tested */
		appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),

		/** App slug (denormalized for quick queries) */
		appSlug: text("app_slug").notNull(),

		/** Organization that owns the app */
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),

		/** MCP tool name that was invoked */
		toolName: text("tool_name").notNull(),

		/** Tool arguments used (JSON) */
		toolArgs: text("tool_args", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** Test mode: "static" or "interactive" */
		mode: text("mode").notNull(),

		/** Overall pass/fail */
		passed: integer("passed", { mode: "boolean" }).notNull(),

		/** Number of steps (interactive only) */
		stepCount: integer("step_count"),

		/** Number of steps that passed (interactive only) */
		stepsPassedCount: integer("steps_passed_count"),

		/** Ordered step results (JSON array) */
		stepResults: text("step_results", { mode: "json" }).$type<
			Array<Record<string, JsonValue>>
		>(),

		/** Screenshot URLs (JSON array of {label, url, mimeType}) */
		screenshots: text("screenshots", { mode: "json" }).$type<
			Array<{ label: string; url: string; mimeType: string }>
		>(),

		/** Tool result summary (JSON) */
		toolResult: text("tool_result", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** DOM summary after test (JSON) */
		domSummary: text("dom_summary", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** Widget analysis (JSON — static mode only) */
		widgetAnalysis: text("widget_analysis", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** Screenshot comparison against the latest promoted/passed baseline run */
		visualDiff: text("visual_diff", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** Preview URL for manual inspection */
		previewUrl: text("preview_url"),

		/** Total duration in ms */
		durationMs: real("duration_ms"),

		/** Error message if the run itself failed */
		error: text("error"),

		/** When the test was run */
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_widget_test_runs_app").on(table.appId),
		index("idx_widget_test_runs_app_slug").on(table.appSlug),
		index("idx_widget_test_runs_org").on(table.organizationId),
		index("idx_widget_test_runs_created").on(table.createdAt),
		index("idx_widget_test_runs_tool").on(table.toolName),
	],
);

export type WidgetTestRun = typeof widgetTestRuns.$inferSelect;
export type NewWidgetTestRun = typeof widgetTestRuns.$inferInsert;
