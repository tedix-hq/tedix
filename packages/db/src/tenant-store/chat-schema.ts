/**
 * Workspace chat, run and artifact tables as they exist inside one
 * TenantStore object.
 *
 * Same table and column names as `../schema/cognitive-runtime.ts`, so the
 * migration copy pipeline (`importRows`) writes rows unchanged. References to
 * organizations and tedis are dropped: those rows stay in the core database,
 * so a per-workspace SQLite file cannot reference them.
 */
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { SensitiveDataLatch } from "@tedix/api-contract/schemas/sensitive-data-latch";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
	KERNEL_CONVERSATION_ORIGIN_VALUES,
	KERNEL_CONVERSATION_TITLE_SOURCE_VALUES,
	TEDI_ARTIFACT_KIND_VALUES,
	TEDI_RUN_STATUS_VALUES,
	TEDI_RUNTIME_BACKEND_VALUES,
	TEDI_RUNTIME_EVENT_KIND_VALUES,
} from "../schema/cognitive-runtime";

export const tenantKernelConversations = sqliteTable(
	"kernel_conversations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		title: text("title"),
		titleSource: text("title_source", {
			enum: KERNEL_CONVERSATION_TITLE_SOURCE_VALUES,
		}),
		channel: text("channel"),
		origin: text("origin", { enum: KERNEL_CONVERSATION_ORIGIN_VALUES }),
		workspaceId: text("workspace_id"),
		workpieceKind: text("workpiece_kind", { enum: ["gadget", "output"] }),
		workpieceId: text("workpiece_id"),
		lastMessageAt: text("last_message_at").notNull(),
		messageCount: integer("message_count").notNull().default(0),
		deletedAt: text("deleted_at"),
		archivedAt: text("archived_at"),
		pinnedAt: text("pinned_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("idx_kernel_conversations_org_conversation").on(
			table.organizationId,
			table.conversationId,
		),
		index("idx_kernel_conversations_org_last_message").on(
			table.organizationId,
			table.lastMessageAt,
			table.conversationId,
		),
		index("idx_kernel_conversations_org_workspace_last_message").on(
			table.organizationId,
			table.workspaceId,
			table.lastMessageAt,
			table.conversationId,
		),
	],
);

export const tenantKernelRuntimeRuns = sqliteTable(
	"kernel_runtime_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		status: text("status", { enum: TEDI_RUN_STATUS_VALUES })
			.notNull()
			.default("queued"),
		inputMessageId: text("input_message_id"),
		outputMessageId: text("output_message_id"),
		delegatedTediId: text("delegated_tedi_id"),
		childRunId: text("child_run_id"),
		childConversationId: text("child_conversation_id"),
		progressValue: integer("progress_value"),
		progressLabel: text("progress_label"),
		progressDetail: text("progress_detail"),
		latestEventKind: text("latest_event_kind", {
			enum: TEDI_RUNTIME_EVENT_KIND_VALUES,
		}),
		latestEventAt: text("latest_event_at"),
		preview: text("preview"),
		runtimeBackend: text("runtime_backend", {
			enum: TEDI_RUNTIME_BACKEND_VALUES,
		})
			.notNull()
			.default("custom"),
		runtimeExternalId: text("runtime_external_id"),
		runtimeExternalUrl: text("runtime_external_url"),
		runtimeMetadata: text("runtime_metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		outputRevisionId: text("output_revision_id"),
		sensitiveDataLatch: text("sensitive_data_latch", {
			mode: "json",
		}).$type<SensitiveDataLatch>(),
	},
	(table) => [
		index("idx_kernel_runtime_runs_conversation_updated").on(
			table.organizationId,
			table.conversationId,
			table.updatedAt,
		),
		index("idx_kernel_runtime_runs_status_updated").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		index("idx_kernel_runtime_runs_child").on(
			table.delegatedTediId,
			table.childRunId,
		),
		index("idx_kernel_runtime_runs_org_child").on(
			table.organizationId,
			table.childRunId,
		),
		index("idx_kernel_runtime_runs_org_output_revision").on(
			table.organizationId,
			table.outputRevisionId,
		),
		index("idx_kernel_runtime_runs_org_updated").on(
			table.organizationId,
			table.updatedAt,
		),
	],
);

export const tenantKernelRuntimeEvents = sqliteTable(
	"kernel_runtime_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		kind: text("kind", { enum: TEDI_RUNTIME_EVENT_KIND_VALUES }).notNull(),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id"),
		messageId: text("message_id"),
		causeEventId: text("cause_event_id"),
		delegatedTediId: text("delegated_tedi_id"),
		childRunId: text("child_run_id"),
		sequence: integer("sequence"),
		delta: text("delta"),
		payload: text("payload", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		runtimeBackend: text("runtime_backend", {
			enum: TEDI_RUNTIME_BACKEND_VALUES,
		})
			.notNull()
			.default("custom"),
		runtimeExternalId: text("runtime_external_id"),
		runtimeExternalUrl: text("runtime_external_url"),
		runtimeMetadata: text("runtime_metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		traceId: text("trace_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_kernel_runtime_events_created").on(table.createdAt),
		index("idx_kernel_runtime_events_org_created").on(
			table.organizationId,
			table.createdAt,
		),
		index("idx_kernel_runtime_events_conversation_created").on(
			table.organizationId,
			table.conversationId,
			table.createdAt,
		),
		index("idx_kernel_runtime_events_run_created").on(
			table.organizationId,
			table.runId,
			table.createdAt,
			table.id,
		),
		index("idx_kernel_runtime_events_child_created").on(
			table.organizationId,
			table.childRunId,
			table.createdAt,
			table.id,
		),
		index("idx_kernel_runtime_events_delegated_tedi").on(table.delegatedTediId),
		index("idx_kernel_runtime_events_trace")
			.on(table.organizationId, table.traceId, table.createdAt)
			.where(sql`trace_id is not null`),
	],
);

export const tenantKernelToolResults = sqliteTable(
	"kernel_tool_results",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id"),
		sourceKind: text("source_kind", {
			enum: ["direct_read", "approved_write"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		objectKey: text("object_key").notNull(),
		sha256: text("sha256").notNull(),
		byteSize: integer("byte_size").notNull(),
		contentType: text("content_type").notNull().default("application/json"),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		evictedAt: text("evicted_at"),
		evictionReason: text("eviction_reason", {
			enum: ["expired", "count", "bytes", "conversation_deleted"],
		}),
	},
	(table) => [
		uniqueIndex("uniq_kernel_tool_results_object_key").on(table.objectKey),
		uniqueIndex("uniq_kernel_tool_results_source").on(
			table.organizationId,
			table.sourceKind,
			table.sourceId,
		),
		index("idx_kernel_tool_results_conversation_active").on(
			table.organizationId,
			table.conversationId,
			table.evictedAt,
			table.createdAt,
			table.id,
		),
		index("idx_kernel_tool_results_cleanup").on(
			table.evictedAt,
			table.expiresAt,
			table.id,
		),
		index("idx_kernel_tool_results_digest").on(
			table.organizationId,
			table.conversationId,
			table.sha256,
		),
		check(
			"chk_kernel_tool_result_byte_size",
			sql`${table.byteSize} >= 0 AND ${table.byteSize} <= 1048576`,
		),
	],
);

export const tenantTediArtifacts = sqliteTable(
	"tedi_artifacts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		tediId: text("tedi_id").notNull(),
		conversationId: text("conversation_id"),
		runId: text("run_id"),
		messageId: text("message_id"),
		kind: text("kind", { enum: TEDI_ARTIFACT_KIND_VALUES }).notNull(),
		name: text("name").notNull(),
		mimeType: text("mime_type"),
		uri: text("uri"),
		sizeBytes: integer("size_bytes"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		accessClassification: text("access_classification", {
			enum: ["explicit_shareable", "source_derived", "runtime_private"],
		}),
		contentDigest: text("content_digest"),
		producerExecutionId: text("producer_execution_id"),
		accessEnvelope: text("access_envelope"),
		publicationState: text("publication_state", {
			enum: ["pending", "ready"],
		}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_artifacts_org").on(table.organizationId),
		index("idx_tedi_artifacts_tedi_created").on(table.tediId, table.createdAt),
		index("idx_tedi_artifacts_conversation").on(
			table.tediId,
			table.conversationId,
		),
		index("idx_tedi_artifacts_run").on(table.tediId, table.runId),
		index("idx_tedi_artifacts_kind").on(table.tediId, table.kind),
	],
);
