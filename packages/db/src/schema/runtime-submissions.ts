/**
 * Runtime submissions ledger.
 *
 * Durable, Tedix-owned record of every accepted unit of runtime work (a Home
 * kernel turn, a tedi message, a skill/workflow dispatch)
 * and its execution attempts. This first-party, body-neutral durability spine
 * provides admission, attempt tracking, conservative recovery, and exactly-once
 * settlement in canonical D1 rather than any runtime body's local store.
 *
 * Additive by design: these are NEW tables. Submission/attempt identifiers ride
 * in the existing *_runtime_events.payload JSON and runs link back via runId, so
 * no existing runtime table is mutated and no hot-table recreation is required.
 * See docs/engineering/cognition/runtime.md.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { TEDI_RUNTIME_BACKEND_VALUES } from "./cognitive-runtime";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

/** Whether the submission belongs to the org-scoped kernel or a named tedi. */
export const RUNTIME_SUBMISSION_SUBJECT_KIND_VALUES = [
	"kernel",
	"tedi",
] as const;

/** How the work entered the runtime. */
export const RUNTIME_SUBMISSION_SOURCE_KIND_VALUES = [
	"home",
	"tedi_message",
	"skill_workflow",
	"workflow",
	"system",
] as const;

export const RUNTIME_SUBMISSION_STATUS_VALUES = [
	"admitted",
	"running",
	// Non-terminal latch: a settle has won the CAS and recorded its intended
	// outcome in metadata.reservedOutcome, but the finalize step has not yet
	// committed. Crash-safe two-step settle; the reserved sweep re-drives finalize.
	"reserved",
	"settled",
	"failed",
	"canceled",
] as const;

export const RUNTIME_SUBMISSION_ATTEMPT_STATUS_VALUES = [
	"started",
	"recovered",
	"settled",
	"failed",
	"canceled",
] as const;

/**
 * Turn-journal phase. A coarse, monotonically advancing marker of how far a
 * submission's turn progressed, derived
 * server-side from the runtime's best-effort lifecycle events (never via a new
 * RPC). Recovery keys off this to decide whether a crashed turn is safe to
 * requeue (crashed before input delivery — no side effects) or must be
 * terminalized as failed (mid-execution — tools/provider may have fired).
 *
 * Ordering is load-bearing: admitted < provider_started < tool_request_recorded
 * < committed. Advances are CAS-guarded (never regress). A NULL value on a
 * legacy/pre-migration row reads as "unknown" and the recovery path must treat
 * it exactly as the coarse pre-journal behavior (equivalent to admitted
 * semantics).
 */
export const RUNTIME_SUBMISSION_PHASE_VALUES = [
	"admitted",
	"provider_started",
	"tool_request_recorded",
	"committed",
] as const;

export type RuntimeSubmissionSubjectKind =
	(typeof RUNTIME_SUBMISSION_SUBJECT_KIND_VALUES)[number];
export type RuntimeSubmissionSourceKind =
	(typeof RUNTIME_SUBMISSION_SOURCE_KIND_VALUES)[number];
export type RuntimeSubmissionStatus =
	(typeof RUNTIME_SUBMISSION_STATUS_VALUES)[number];
export type RuntimeSubmissionAttemptStatus =
	(typeof RUNTIME_SUBMISSION_ATTEMPT_STATUS_VALUES)[number];
export type RuntimeSubmissionPhase =
	(typeof RUNTIME_SUBMISSION_PHASE_VALUES)[number];

export const runtimeSubmissions = sqliteTable(
	"runtime_submissions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		subjectKind: text("subject_kind", {
			enum: RUNTIME_SUBMISSION_SUBJECT_KIND_VALUES,
		}).notNull(),
		// `kernel:{orgId}` for the kernel subject, or the tediId for a tedi.
		subjectId: text("subject_id").notNull(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		conversationId: text("conversation_id"),
		// Canonical run this submission produced (kernel_runtime_runs.id / tedi run id).
		runId: text("run_id"),
		idempotencyKey: text("idempotency_key"),
		sourceKind: text("source_kind", {
			enum: RUNTIME_SUBMISSION_SOURCE_KIND_VALUES,
		}).notNull(),
		sourceProvider: text("source_provider"),
		sourceDeliveryId: text("source_delivery_id"),
		status: text("status", { enum: RUNTIME_SUBMISSION_STATUS_VALUES })
			.notNull()
			.default("admitted"),
		currentAttemptId: text("current_attempt_id"),
		attemptCount: integer("attempt_count").notNull().default(0),
		runtimeBackend: text("runtime_backend", {
			enum: TEDI_RUNTIME_BACKEND_VALUES,
		}),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		settledAt: text("settled_at"),
		// Observer-readable ceiling: when this admitted unit of work is expected to
		// have finished. Stamped at admit for tedi subjects; nullable for everything
		// else. Additive column — apply the D1 ALTER below before deploying:
		//   ALTER TABLE runtime_submissions ADD COLUMN timeout_at TEXT;
		timeoutAt: text("timeout_at"),
		// Turn-journal phase. Nullable: existing rows read NULL = "unknown/legacy"
		// and the recovery path treats that as the coarse pre-journal behavior.
		// Advanced monotonically server-side from the
		// runtime's lifecycle events (advanceSubmissionPhase). Additive column —
		// apply the D1 ALTER below before deploying (timeout_at is the precedent):
		//   ALTER TABLE runtime_submissions ADD COLUMN phase TEXT;
		phase: text("phase", { enum: RUNTIME_SUBMISSION_PHASE_VALUES }),
		// Stamped exactly once when the runtime first
		// accepts the input (first run.started). The earliest "input accepted"
		// marker and the load-bearing requeue gate: requeue is only safe while this
		// is NULL (no provider/tool side effects yet). Additive — apply before deploy:
		//   ALTER TABLE runtime_submissions ADD COLUMN input_applied_at TEXT;
		inputAppliedAt: text("input_applied_at"),
		// Durable operator abort intent. Stamped by the cancel entry
		// points (kernel cancelRun, tedi stopRun, skill workflow cancel); honored at
		// recovery/requeue choke points with strict precedence completed-work-wins →
		// abort → budget → timeout. NULL on legacy rows = exactly today's behavior.
		// Additive — apply before deploy:
		//   ALTER TABLE runtime_submissions ADD COLUMN abort_requested_at TEXT;
		abortRequestedAt: text("abort_requested_at"),
		// Durable cross-restart requeue budget. The
		// recovery loop bounds whole-turn re-executions by attemptCount <= maxRetry;
		// a DO restart cannot reset it (it lives in D1). Constant default keeps the
		// ADD COLUMN non-rewriting and backfills existing rows to 10. Apply before deploy:
		//   ALTER TABLE runtime_submissions ADD COLUMN max_retry INTEGER NOT NULL DEFAULT 10;
		maxRetry: integer("max_retry").notNull().default(10),
	},
	(table) => [
		index("idx_runtime_submissions_org_created").on(
			table.organizationId,
			table.createdAt,
		),
		index("idx_runtime_submissions_subject").on(
			table.organizationId,
			table.subjectKind,
			table.subjectId,
			table.createdAt,
		),
		index("idx_runtime_submissions_run").on(table.organizationId, table.runId),
		index("idx_runtime_submissions_status_updated").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		index("idx_runtime_submissions_idempotency").on(
			table.organizationId,
			table.idempotencyKey,
		),
		// Provider-delivery dedupe. SQLite treats NULLs as distinct, so this only
		// constrains rows that actually carry a provider + delivery id.
		uniqueIndex("uniq_runtime_submissions_delivery").on(
			table.organizationId,
			table.sourceProvider,
			table.sourceDeliveryId,
		),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_runtime_submissions_created").on(table.createdAt),
	],
);

export const runtimeSubmissionAttempts = sqliteTable(
	"runtime_submission_attempts",
	{
		id: text("id").primaryKey(),
		submissionId: text("submission_id")
			.notNull()
			.references(() => runtimeSubmissions.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		attemptNo: integer("attempt_no").notNull(),
		status: text("status", {
			enum: RUNTIME_SUBMISSION_ATTEMPT_STATUS_VALUES,
		})
			.notNull()
			.default("started"),
		runtimeBackend: text("runtime_backend", {
			enum: TEDI_RUNTIME_BACKEND_VALUES,
		}),
		runtimeExternalId: text("runtime_external_id"),
		error: text("error"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		startedAt: text("started_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		heartbeatAt: text("heartbeat_at"),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("idx_runtime_submission_attempts_submission").on(
			table.submissionId,
			table.attemptNo,
		),
		uniqueIndex("uniq_runtime_submission_attempts_no").on(
			table.submissionId,
			table.attemptNo,
		),
	],
);

export type RuntimeSubmission = typeof runtimeSubmissions.$inferSelect;
export type NewRuntimeSubmission = typeof runtimeSubmissions.$inferInsert;
export type RuntimeSubmissionAttempt =
	typeof runtimeSubmissionAttempts.$inferSelect;
export type NewRuntimeSubmissionAttempt =
	typeof runtimeSubmissionAttempts.$inferInsert;
