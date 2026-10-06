/**
 * Cognitive runtime schema.
 *
 * Durable Tedix-owned runtime records. Runtime backends can be replaced; these
 * rows remain the audit/replay surface for Tedix OS and MCP.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { tediApprovalRequests } from "./approvals";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const TEDI_RUNTIME_BACKEND_VALUES = [
	"cloudflare-agents",
	"openai-agents",
	"claude",
	"codex",
	"google-adk",
	"langgraph",
	"custom",
] as const;

export const TEDI_RUNTIME_EVENT_KIND_VALUES = [
	"conversation.created",
	"conversation.updated",
	"message.received",
	"message.delta",
	"message.completed",
	"run.started",
	"run.completed",
	"run.failed",
	"run.canceled",
	"tool.started",
	"tool.completed",
	"tool.failed",
	"step.completed",
	"subagent.started",
	"subagent.completed",
	"subagent.failed",
	"approval.requested",
	"approval.resolved",
	"artifact.created",
	"context.injected",
	"context.compacted",
	"memory.observed",
	"memory.bridged",
	"memory.retrieved",
	"decision.recorded",
	"decision.completed",
	"delegation.authority.evaluated",
	"skill.used",
	"skill.failed",
	"skill.crystallized",
	"task.detected",
	"task.synced",
	"runtime.health_changed",
	"submission.admitted",
	"submission.attempt.started",
	"submission.attempt.recovered",
	"submission.settled",
	"message.progress",
	"message.phase",
	"message.reasoning",
	"step.retry",
	"runtime.mirror_skipped",
	"repo_commit.drained",
	"workstation.exec.completed",
	"workstation.exec.failed",
	"workstation.egress.allow",
	"workstation.egress.deny",
	"browser.egress.deny",
] as const;

export const TEDI_RUN_STATUS_VALUES = [
	"queued",
	"running",
	"completed",
	"failed",
	"canceled",
	"requires_approval",
] as const;

export const KERNEL_CONVERSATION_GRANT_ACCESS_VALUES = [
	"read",
	"edit",
	"owner",
] as const;

export const TEDI_ARTIFACT_KIND_VALUES = [
	"file",
	"image",
	"document",
	"spreadsheet",
	"presentation",
	"widget",
	"log",
	"link",
	"other",
] as const;

export type TediRuntimeBackend = (typeof TEDI_RUNTIME_BACKEND_VALUES)[number];
export type TediRuntimeEventKind =
	(typeof TEDI_RUNTIME_EVENT_KIND_VALUES)[number];
export type TediRunStatus = (typeof TEDI_RUN_STATUS_VALUES)[number];
export type KernelConversationGrantAccess =
	(typeof KERNEL_CONVERSATION_GRANT_ACCESS_VALUES)[number];
export type TediArtifactKind = (typeof TEDI_ARTIFACT_KIND_VALUES)[number];

export const tediRuntimeEvents = sqliteTable(
	"tedi_runtime_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: TEDI_RUNTIME_EVENT_KIND_VALUES }).notNull(),
		conversationId: text("conversation_id"),
		runId: text("run_id"),
		messageId: text("message_id"),
		toolCallId: text("tool_call_id"),
		approvalRequestId: text("approval_request_id"),
		artifactId: text("artifact_id"),
		sequence: integer("sequence"),
		delta: text("delta"),
		payload: text("payload", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		runtimeBackend: text("runtime_backend", {
			enum: TEDI_RUNTIME_BACKEND_VALUES,
		}).notNull(),
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
		index("idx_tedi_runtime_events_org").on(table.organizationId),
		// Standalone created_at index for global retention sweeps
		// (`WHERE created_at < cutoff` — no tedi/org prefix). Every existing index
		// leads with tedi_id/organization_id, so created_at is non-leading and a
		// retention scan could not seek on it. Mirrors the analytics tables'
		// idx_*_created retention indexes.
		index("idx_tedi_runtime_events_created").on(table.createdAt),
		index("idx_tedi_runtime_events_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_tedi_runtime_events_conversation_created").on(
			table.tediId,
			table.conversationId,
			table.createdAt,
		),
		// Covering index for the hottest D1 query on the platform:
		// `WHERE tedi_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?`.
		// Without created_at in the key, SQLite preferred
		// idx_tedi_runtime_events_tedi_created (it satisfies the ORDER BY) and
		// scanned run_id — a full-table read per call that dominated D1 reads and
		// caused "D1 DB is overloaded" bursts.
		index("idx_tedi_runtime_events_run_created").on(
			table.tediId,
			table.runId,
			table.createdAt,
		),
		// Correlated run-state checks (orphan recovery, terminal detection, and
		// durable-success recovery) constrain both run_id and kind. Without kind
		// after the run key, SQLite can choose the tedi/kind index and rescan a
		// tedi's complete event history once per orphan candidate.
		index("idx_tedi_runtime_events_run_kind_created").on(
			table.tediId,
			table.runId,
			table.kind,
			table.createdAt,
		),
		index("idx_tedi_runtime_events_kind_created").on(
			table.tediId,
			table.kind,
			table.createdAt,
		),
		index("idx_tedi_runtime_events_artifact").on(table.artifactId),
		index("idx_tedi_runtime_events_trace")
			.on(table.traceId, table.createdAt)
			.where(sql`trace_id is not null`),
	],
);

export const kernelRuntimeEvents = sqliteTable(
	"kernel_runtime_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: TEDI_RUNTIME_EVENT_KIND_VALUES }).notNull(),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id"),
		messageId: text("message_id"),
		causeEventId: text("cause_event_id"),
		delegatedTediId: text("delegated_tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
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
		// Standalone created_at index for global retention sweeps (see the
		// tedi_runtime_events counterpart). The org_created index below leads with
		// organization_id, so it cannot serve a global `WHERE created_at < cutoff`.
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
		// Cover the active Home SSE cursor read:
		// WHERE organization_id=? AND run_id=? ORDER BY created_at,id LIMIT/OFFSET.
		index("idx_kernel_runtime_events_run_created").on(
			table.organizationId,
			table.runId,
			table.createdAt,
			table.id,
		),
		// Delegated child resume uses child_run_id instead of the parent run id.
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

export const kernelToolResults = sqliteTable(
	"kernel_tool_results",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
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
		// The service rejects larger payloads before R2 I/O; keep the invariant
		// at the durable boundary as well.
		check(
			"chk_kernel_tool_result_byte_size",
			sql`${table.byteSize} >= 0 AND ${table.byteSize} <= 1048576`,
		),
	],
);

export const kernelRuntimeRuns = sqliteTable(
	"kernel_runtime_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		status: text("status", { enum: TEDI_RUN_STATUS_VALUES })
			.notNull()
			.default("queued"),
		inputMessageId: text("input_message_id"),
		outputMessageId: text("output_message_id"),
		delegatedTediId: text("delegated_tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
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
	],
);

export const KERNEL_HOME_APPROVAL_MIRROR_STATUS_VALUES = [
	"pending",
	"escalated",
] as const;

/**
 * Rebuildable Home rendering projection for delegated-child approval blocks.
 *
 * `tedi_approval_requests` remains the canonical approval state machine. This
 * table only persists the parent-conversation placement and escalation urgency
 * that previously lived solely in KernelDO storage. Readers must join the
 * canonical request and require `status = pending`, so a dropped projection
 * clear can never leave a resolved approval visible in Home.
 */
export const kernelHomeApprovalMirrors = sqliteTable(
	"kernel_home_approval_mirrors",
	{
		/** Deterministic `${parentConversationId}:${childRunId}:${approvalRequestId}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		parentConversationId: text("parent_conversation_id").notNull(),
		childRunId: text("child_run_id").notNull(),
		approvalRequestId: text("approval_request_id")
			.notNull()
			.references(() => tediApprovalRequests.id, { onDelete: "cascade" }),
		delegatedTediId: text("delegated_tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		status: text("status", {
			enum: KERNEL_HOME_APPROVAL_MIRROR_STATUS_VALUES,
		})
			.notNull()
			.default("pending"),
		blockedAt: text("blocked_at").notNull(),
		escalateAt: integer("escalate_at").notNull(),
		escalatedAt: text("escalated_at"),
		clearedAt: text("cleared_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_kernel_home_approval_mirrors_active")
			.on(
				table.organizationId,
				table.parentConversationId,
				table.status,
				table.updatedAt,
			)
			.where(sql`cleared_at is null`),
		index("idx_kernel_home_approval_mirrors_child").on(
			table.organizationId,
			table.parentConversationId,
			table.childRunId,
		),
	],
);

export const KERNEL_CONVERSATION_TITLE_SOURCE_VALUES = [
	"rename",
	"autoTitle",
	"provisional",
] as const;

/**
 * Who originated a Home conversation: a human operator at an interactive
 * surface (`human`) or machine traffic — an MCP probe, a smoke test, a
 * scheduled job, a tedi, an external coding agent (`agent`).
 *
 * NULL is NOT a third state: it means "unstamped", which every row written
 * before this column existed is, and it MUST read as `human`. Defaulting the
 * unknown case to `agent` would empty the operator's sidebar the moment a
 * consumer filters on origin. Read it through
 * `kernelConversationOriginOrHuman()` rather than testing the column directly.
 */
export const KERNEL_CONVERSATION_ORIGIN_VALUES = ["human", "agent"] as const;

export type KernelConversationOrigin =
	(typeof KERNEL_CONVERSATION_ORIGIN_VALUES)[number];

/** Absent (legacy/unstamped) origin reads as `human`. Never invert this. */
export function kernelConversationOriginOrHuman(
	origin: string | null | undefined,
): KernelConversationOrigin {
	return origin === "agent" ? "agent" : "human";
}

/**
 * Home conversation index — a durable projection over `kernel_runtime_events`.
 *
 * `kernelRuntime.listConversations` historically derived the org's Home
 * conversation list from the newest `limit * 10` event rows, so busy orgs aged
 * topical chats out of the sidebar entirely and pagination cursors were
 * event-window artifacts. This table is the indexed read model: one row per
 * (org, conversation), maintained write-through from the kernel event choke
 * point (`insertKernelRuntimeEvent`) and lazily backfilled from the event
 * ledger on first read. `kernel_runtime_events` stays the source of truth —
 * this projection is rebuildable from it at any time.
 *
 * `title_source` mirrors the rename/auto-title overlay semantics: an operator
 * rename (`rename`) always beats an auto-generated title (`autoTitle`), which
 * in turn beats the instant first-message placeholder (`provisional`),
 * regardless of event order. `provisional` rows are projection-only (no
 * `conversation.updated` event) — a rebuild from the ledger drops them, and
 * the post-settle auto-title replaces them seconds later.
 */
export const kernelConversations = sqliteTable(
	"kernel_conversations",
	{
		/** Deterministic `${organizationId}:${conversationId}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		title: text("title"),
		titleSource: text("title_source", {
			enum: KERNEL_CONVERSATION_TITLE_SOURCE_VALUES,
		}),
		/** Newest event payload channel; null renders as "home". */
		channel: text("channel"),
		/**
		 * Conversation-origin stamp — see
		 * {@link KERNEL_CONVERSATION_ORIGIN_VALUES}. Written through from the
		 * kernel event choke point on the FIRST user turn of a conversation
		 * (`message.received` with `payload.origin`), derived from the request's
		 * authenticated principal class, never from title text.
		 *
		 * Nullable and NEVER backfilled: every pre-existing row stays NULL and
		 * reads as `human`. Sticky in the agent direction only — once a human
		 * message lands the row is `human` forever, and an agent message into a
		 * conversation that already has unstamped history leaves it NULL rather
		 * than reclassifying an operator's chat as machine traffic.
		 */
		origin: text("origin", { enum: KERNEL_CONVERSATION_ORIGIN_VALUES }),
		/** Canonical Workspace association; null keeps organization Home threads global. */
		workspaceId: text("workspace_id"),
		/** Last selected Workspace workpiece. These are context references, not authority. */
		workpieceKind: text("workpiece_kind", { enum: ["gadget", "output"] }),
		workpieceId: text("workpiece_id"),
		lastMessageAt: text("last_message_at").notNull(),
		messageCount: integer("message_count").notNull().default(0),
		/**
		 * Permanent-delete tombstone. `kernelRuntime.deleteConversation` purges
		 * conversation-owned runtime state, then retains this marker so late child
		 * frames cannot make the conversation visible again. Never cleared.
		 */
		deletedAt: text("deleted_at"),
		/** Clearable archive marker; unlike deletion, restore sets this back to null. */
		archivedAt: text("archived_at"),
		/**
		 * Pin marker (nullable ISO timestamp, like `deletedAt`). Set/cleared by
		 * `kernelRuntime.pinConversation` via the SAME `conversation.updated` event
		 * kind (a `pinned` boolean payload sibling to `title`/`deletedAt`), so pins
		 * are org-durable and shared across every surface (Tedix OS + CLI) — not a
		 * per-user overlay. Unlike `deletedAt`, this is CLEARABLE (unpin sets null).
		 * Non-null = pinned; each surface sorts pinned-first in its own read.
		 */
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
		// Covers the sidebar/⌘K list read:
		// WHERE organization_id=? ORDER BY last_message_at DESC, conversation_id DESC
		// (SQLite scans the composite index backwards; conversation_id is the
		// stable pagination tiebreak).
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

/**
 * Human co-drive access grants for Home conversations.
 *
 * Default policy is intentionally additive/backward-compatible: when a
 * conversation has ZERO grant rows, the Kernel preserves today's org-wide
 * visibility for org members. Adding the first row opts that conversation into
 * this ladder; only listed humans can read/edit/own it. Runtime bodies remain
 * bound executors and are not granted through this table.
 */
export const kernelConversationGrants = sqliteTable(
	"kernel_conversation_grants",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		granteeDescopeUserId: text("grantee_descope_user_id").notNull(),
		access: text("access", {
			enum: KERNEL_CONVERSATION_GRANT_ACCESS_VALUES,
		}).notNull(),
		createdByDescopeUserId: text("created_by_descope_user_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_kernel_conversation_grants_user").on(
			table.organizationId,
			table.granteeDescopeUserId,
		),
		uniqueIndex("idx_kernel_conversation_grants_unique_user").on(
			table.organizationId,
			table.conversationId,
			table.granteeDescopeUserId,
		),
	],
);

export const tediArtifacts = sqliteTable(
	"tedi_artifacts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
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
		/** Null only for artifacts recorded before provenance classification existed. */
		accessClassification: text("access_classification", {
			enum: ["explicit_shareable", "source_derived", "runtime_private"],
		}),
		/** SHA-256 of exact immutable bytes or the canonical bundle manifest. */
		contentDigest: text("content_digest"),
		/** Exact governed Gadget execution that supplied source authority. */
		producerExecutionId: text("producer_execution_id"),
		/** Versioned OsDerivedAccessEnvelope JSON captured from that execution. */
		accessEnvelope: text("access_envelope"),
		/** Classified bodies remain unreadable until exact storage verification succeeds. */
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

export const tediArtifactContributionReceipts = sqliteTable(
	"tedi_artifact_contribution_receipts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => tediArtifacts.id, { onDelete: "cascade" }),
		producerRuntimeEventId: text("producer_runtime_event_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id").notNull(),
		contentDigest: text("content_digest").notNull(),
		observationDigest: text("observation_digest").notNull(),
		observations: text("observations", { mode: "json" })
			.$type<JsonValue[]>()
			.notNull(),
		completeness: text("completeness", {
			enum: ["observed_prefix", "unavailable"],
		}).notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_tedi_artifact_contribution_receipts_artifact").on(
			table.artifactId,
		),
		index("idx_tedi_artifact_contribution_receipts_tedi_created").on(
			table.organizationId,
			table.tediId,
			table.createdAt,
		),
	],
);

export type TediRuntimeEvent = typeof tediRuntimeEvents.$inferSelect;
export type NewTediRuntimeEvent = typeof tediRuntimeEvents.$inferInsert;
export type KernelRuntimeEvent = typeof kernelRuntimeEvents.$inferSelect;
export type KernelToolResult = typeof kernelToolResults.$inferSelect;
export type NewKernelToolResult = typeof kernelToolResults.$inferInsert;
export type NewKernelRuntimeEvent = typeof kernelRuntimeEvents.$inferInsert;
export type KernelRuntimeRun = typeof kernelRuntimeRuns.$inferSelect;
export type NewKernelRuntimeRun = typeof kernelRuntimeRuns.$inferInsert;
export type KernelHomeApprovalMirror =
	typeof kernelHomeApprovalMirrors.$inferSelect;
export type NewKernelHomeApprovalMirror =
	typeof kernelHomeApprovalMirrors.$inferInsert;
export type KernelConversation = typeof kernelConversations.$inferSelect;
export type NewKernelConversation = typeof kernelConversations.$inferInsert;
export type KernelConversationGrant =
	typeof kernelConversationGrants.$inferSelect;
export type NewKernelConversationGrant =
	typeof kernelConversationGrants.$inferInsert;
export type TediArtifact = typeof tediArtifacts.$inferSelect;
export type NewTediArtifact = typeof tediArtifacts.$inferInsert;
export type TediArtifactContributionReceipt =
	typeof tediArtifactContributionReceipts.$inferSelect;
export type NewTediArtifactContributionReceipt =
	typeof tediArtifactContributionReceipts.$inferInsert;

/**
 * Idempotency-key to backend runId mapping for async chat dispatch.
 *
 * Written by the tedi `/chat/enqueue` bridge when a Tedix OS-minted
 * idempotencyKey is forwarded to the runtime backend's fire-and-forget enqueue
 * path.
 * Patched (run_id filled) by `cognitive-event-ingest` when the first
 * runtime event arrives for the conversation post-enqueue, so the Tedix OS can
 * later join its optimistic-turn key (idempotencyKey) to the canonical
 * ledger runId.
 *
 * No FK on tediId — keeps the writer hot path single-statement and
 * survives FK pruning races during onboarding/repair.
 */
export const chatDispatchIdempotency = sqliteTable(
	"chat_dispatch_idempotency",
	{
		idempotencyKey: text("idempotency_key").primaryKey(),
		tediId: text("tedi_id").notNull(),
		organizationId: text("organization_id"),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id"),
		status: text("status").notNull().default("queued"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		mappedAt: text("mapped_at"),
	},
	(table) => [
		index("idx_chat_dispatch_idem_tedi_convo").on(
			table.tediId,
			table.conversationId,
			table.createdAt,
		),
		index("idx_chat_dispatch_idem_run").on(table.tediId, table.runId),
		index("idx_chat_dispatch_idem_created").on(table.createdAt),
	],
);

export type ChatDispatchIdempotency =
	typeof chatDispatchIdempotency.$inferSelect;
export type NewChatDispatchIdempotency =
	typeof chatDispatchIdempotency.$inferInsert;

/**
 * Inbox-wake queue.
 *
 * Written by `notifyKernelChildComplete` (cognitive-runtime.ts) when a child
 * tedi run reaches a terminal state. The owning KernelDO reads and acks these
 * rows inside its alarm handler, then injects a synthetic
 * "[System: N delegated task(s) completed]" parent turn.
 *
 * Safety invariants (enforced in code, not just here):
 *   - organization_id on the row MUST match the child run's org before write.
 *   - The KernelDO alarm handler verifies parent_conversation_id belongs to its
 *     own org before injecting the wake turn.
 */
export const kernelWakeQueue = sqliteTable(
	"kernel_wake_queue",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		parentConversationId: text("parent_conversation_id").notNull(),
		childRunId: text("child_run_id").notNull(),
		/** Terminal status of the child run that triggered this wake entry. */
		childStatus: text("child_status").notNull(),
		/** ISO-8601 timestamp when this row was written. */
		queuedAt: text("queued_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		/** ISO-8601 timestamp when the KernelDO alarm acked this row. Null = pending. */
		ackedAt: text("acked_at"),
		/** Discriminates between "child_completed" and future wake kinds. */
		wakeKind: text("wake_kind").notNull().default("child_completed"),
	},
	(table) => [
		index("idx_kernel_wake_queue_org_acked").on(
			table.organizationId,
			table.ackedAt,
			table.queuedAt,
		),
		index("idx_kernel_wake_queue_conversation").on(
			table.organizationId,
			table.parentConversationId,
			table.ackedAt,
		),
	],
);

export type KernelWakeQueue = typeof kernelWakeQueue.$inferSelect;
export type NewKernelWakeQueue = typeof kernelWakeQueue.$inferInsert;
