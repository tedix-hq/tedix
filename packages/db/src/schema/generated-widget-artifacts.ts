/**
 * Generated Widget Artifacts Schema
 *
 * Retired: the generated widget artifact draft/QA/publish lane was removed
 * with widget browser testing and nothing reads or writes this table. The
 * model stays so migration history and drift checks keep describing the
 * existing D1 table until a deliberate drop migration.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { appTools } from "./tools";
import { widgetTestRuns } from "./widget-test-runs";

export const GENERATED_WIDGET_ARTIFACT_STATUS_VALUES = [
	"draft",
	"qa_queued",
	"qa_running",
	"qa_passed",
	"qa_failed",
	"publishing",
	"published",
	"archived",
] as const;

export const GENERATED_WIDGET_ARTIFACT_KIND_VALUES = [
	"json_render_layout",
	"mcp_ui_resource",
	"browser_qa_report",
	"chat_visual",
] as const;

export const GENERATED_WIDGET_ARTIFACT_SOURCE_VALUES = [
	"tedi_generated",
	"openapi_import",
	"catalog_sync",
	"manual",
] as const;

export type GeneratedWidgetArtifactStatus =
	(typeof GENERATED_WIDGET_ARTIFACT_STATUS_VALUES)[number];
export type GeneratedWidgetArtifactKind =
	(typeof GENERATED_WIDGET_ARTIFACT_KIND_VALUES)[number];
export type GeneratedWidgetArtifactSource =
	(typeof GENERATED_WIDGET_ARTIFACT_SOURCE_VALUES)[number];

export const generatedWidgetArtifacts = sqliteTable(
	"generated_widget_artifacts",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		appSlug: text("app_slug").notNull(),

		appToolId: text("app_tool_id").references(() => appTools.id, {
			onDelete: "set null",
		}),
		toolId: text("tool_id"),
		toolName: text("tool_name"),

		kind: text("kind", {
			enum: GENERATED_WIDGET_ARTIFACT_KIND_VALUES,
		})
			.notNull()
			.default("json_render_layout"),
		source: text("source", {
			enum: GENERATED_WIDGET_ARTIFACT_SOURCE_VALUES,
		})
			.notNull()
			.default("tedi_generated"),
		status: text("status", {
			enum: GENERATED_WIDGET_ARTIFACT_STATUS_VALUES,
		})
			.notNull()
			.default("draft"),

		title: text("title").notNull(),
		description: text("description"),

		layoutSpec: text("layout_spec", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		inputSnapshot: text("input_snapshot", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		outputSnapshot: text("output_snapshot", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		resourceUri: text("resource_uri"),
		widgetUrl: text("widget_url"),
		previewUrl: text("preview_url"),
		screenshotUrl: text("screenshot_url"),

		widgetTestRunId: text("widget_test_run_id").references(
			() => widgetTestRuns.id,
			{ onDelete: "set null" },
		),
		workflowId: text("workflow_id"),
		progressMessage: text("progress_message"),
		qaSummary: text("qa_summary", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		createdBy: text("created_by"),
		publishedAt: text("published_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_generated_widget_artifacts_org").on(table.organizationId),
		index("idx_generated_widget_artifacts_app").on(table.appId),
		index("idx_generated_widget_artifacts_app_slug").on(table.appSlug),
		index("idx_generated_widget_artifacts_tool").on(table.appToolId),
		index("idx_generated_widget_artifacts_status").on(table.status),
		index("idx_generated_widget_artifacts_workflow").on(table.workflowId),
		index("idx_generated_widget_artifacts_created").on(table.createdAt),
	],
);

export type GeneratedWidgetArtifact =
	typeof generatedWidgetArtifacts.$inferSelect;
export type NewGeneratedWidgetArtifact =
	typeof generatedWidgetArtifacts.$inferInsert;
