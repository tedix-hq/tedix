/**
 * Tedi Rationale Record Query Helpers
 * CRUD operations for the tedi_rationale_records table
 *
 * Used by the rationale records router and Tedix OS UI.
 */

import type { RationaleProofRefKind } from "@tedix/api-contract/constants/enums";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, like, ne, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { skillRunArtifacts } from "../schema/cognitive";
import {
	type OutcomeStatus,
	type TediRationaleRecord,
	tediRationaleRecords,
} from "../schema/rationale-records";
import { toJsonRecord } from "../utils/json";

// ============================================================================
// Types
// ============================================================================

/** Span-checkable proof for an outcome claim (WS1). */
export interface RationaleProofRef {
	kind: RationaleProofRefKind;
	ref: string;
}

export interface CreateRationaleRecordParams {
	id: string;
	tediId: string;
	orgId: string;
	action: string;
	rationale: string;
	category: string;
	confidence: number;
	evidence: Record<string, JsonValue>;
	approvalRequestId?: string;
	objectiveId?: string;
	/** Execution link (WS1): runtime run this decision belongs to. */
	runId?: string;
	/** Execution link (WS1): Work Item this decision serves. */
	workItemId?: string;
	/** Execution link (WS1): tool-call refs from the runtime event ledger. */
	toolCallRefs?: string[];
	createdAt: string;
}

export interface ListRationaleRecordsOptions {
	orgId?: string;
	tediId?: string;
	category?: string;
	outcomeStatus?: OutcomeStatus;
	limit?: number;
	offset?: number;
}

export interface CompleteRationaleRecordParams {
	outcome: string;
	outcomeStatus: "success" | "failure" | "partial";
	/**
	 * Span-checkable proof for a `success` claim. Required for `success` —
	 * without it the record is stored as `unverified` (proof-gated disposition,
	 * mirroring Work Items).
	 */
	proofRef?: RationaleProofRef;
	completedAt: string;
}

/** Count terminal tool events for one rationale episode's runtime run. */
export async function countRationaleRunToolEvents(
	db: DbClient,
	access: { tediId: string; orgId: string; runId: string },
): Promise<number> {
	const rows = await db.all<{ cnt: number }>(
		sql`SELECT count(*) AS cnt FROM tedi_runtime_events
			WHERE tedi_id = ${access.tediId}
				AND organization_id = ${access.orgId}
				AND run_id = ${access.runId}
				AND kind IN ('tool.completed', 'tool.failed')`,
	);
	return Number(rows[0]?.cnt ?? 0);
}

/**
 * WS1 invariant: a rationale record is an evidence-linked decision episode or
 * it is rejected. Throws unless at least one execution link is present.
 * Enforced here (below every write path) so no caller can bypass it.
 */
export function assertRationaleExecutionLinked(
	params: Pick<
		CreateRationaleRecordParams,
		"runId" | "workItemId" | "toolCallRefs"
	>,
): void {
	const linked = Boolean(
		params.runId?.trim() ||
		params.workItemId?.trim() ||
		(params.toolCallRefs && params.toolCallRefs.length > 0),
	);
	if (!linked) {
		throw new Error(
			"UNLINKED_RATIONALE: rationale records require at least one execution link (runId, workItemId, or toolCallRefs)",
		);
	}
}

/**
 * Proof-gated outcome resolution (WS1): a `success` claim without a
 * span-checkable proof ref resolves to `unverified`, never `success`.
 */
export function resolveOutcomeStatusForProof(
	outcomeStatus: "success" | "failure" | "partial",
	proofRef: RationaleProofRef | undefined,
): OutcomeStatus {
	if (outcomeStatus === "success" && !proofRef) return "unverified";
	return outcomeStatus;
}

export type SkillWorkflowTerminalStatus = "completed" | "failed" | "canceled";

/** Terminal projection for the dispatch decision attached to one skill run. */
export function skillWorkflowDispatchOutcome(input: {
	runId: string;
	status: SkillWorkflowTerminalStatus;
	error?: string | null;
}): {
	outcome: string;
	outcomeStatus: "success" | "failure" | "partial";
	proofRef: RationaleProofRef | null;
} {
	if (input.status === "completed") {
		return {
			outcome: `Workflow run ${input.runId} completed.`,
			outcomeStatus: "success",
			proofRef: { kind: "run", ref: input.runId },
		};
	}
	if (input.status === "failed") {
		const error = input.error?.trim();
		return {
			outcome: error
				? `Workflow run ${input.runId} failed: ${error.slice(0, 1000)}`
				: `Workflow run ${input.runId} failed.`,
			outcomeStatus: "failure",
			proofRef: null,
		};
	}
	return {
		outcome: `Workflow run ${input.runId} was canceled.`,
		outcomeStatus: "partial",
		proofRef: null,
	};
}

interface SkillWorkflowCallArtifactLike {
	path: string;
	contentInline: string | null;
	outcome: string;
}

/** Digit-run / non-digit-run chunks of one path segment. */
const PATH_SEGMENT_CHUNKS = /\d+|\D+/g;

/**
 * Numeric-aware artifact-path comparator. Receipt paths embed unpadded
 * integers (`epochs/0/steps/x/2/attempts/1/calls/main/10.json`), so plain
 * lexicographic ordering put `10.json` before `2.json` and scrambled
 * toolCallRefs for any phase with >= 10 calls. Segments are compared
 * chunk-wise with digit runs compared as numbers.
 */
export function compareSkillWorkflowArtifactPaths(
	a: string,
	b: string,
): number {
	const aSegments = a.split("/");
	const bSegments = b.split("/");
	const segmentCount = Math.max(aSegments.length, bSegments.length);
	for (let i = 0; i < segmentCount; i++) {
		const aSegment = aSegments[i];
		const bSegment = bSegments[i];
		if (aSegment === undefined) return -1;
		if (bSegment === undefined) return 1;
		if (aSegment === bSegment) continue;
		const aChunks = aSegment.match(PATH_SEGMENT_CHUNKS) ?? [];
		const bChunks = bSegment.match(PATH_SEGMENT_CHUNKS) ?? [];
		const chunkCount = Math.max(aChunks.length, bChunks.length);
		for (let j = 0; j < chunkCount; j++) {
			const aChunk = aChunks[j];
			const bChunk = bChunks[j];
			if (aChunk === undefined) return -1;
			if (bChunk === undefined) return 1;
			if (aChunk === bChunk) continue;
			const aNumeric = /^\d+$/.test(aChunk);
			const bNumeric = /^\d+$/.test(bChunk);
			if (aNumeric && bNumeric) {
				const delta = Number(aChunk) - Number(bChunk);
				if (delta !== 0) return delta;
				// Same value, different padding ("01" vs "1"): fall back to text.
			}
			return aChunk < bChunk ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Project successful workflow MCP receipts into WS1 refs. Receipts that share
 * one idempotency key are one logical call even when a workflow replay wrote
 * more than one attempt artifact, so only the first successful receipt counts.
 */
export function skillWorkflowToolCallRefs(
	runId: string,
	artifacts: readonly SkillWorkflowCallArtifactLike[],
): string[] {
	const parsed: Array<{
		identity: string;
		namespace: string;
		method: string;
		path: string;
	}> = [];
	for (const artifact of artifacts) {
		if (artifact.outcome !== "success" || !artifact.contentInline) continue;
		let payload: Record<string, JsonValue>;
		try {
			const value = JSON.parse(artifact.contentInline) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			payload = toJsonRecord(value);
		} catch {
			continue;
		}
		if (
			payload.kind !== "workflow_mcp_call" ||
			payload.status !== "succeeded"
		) {
			continue;
		}
		const namespace =
			typeof payload.namespace === "string" ? payload.namespace.trim() : "";
		const method =
			typeof payload.method === "string" ? payload.method.trim() : "";
		if (!namespace || !method) continue;
		const identity =
			(typeof payload.idempotencyKey === "string" && payload.idempotencyKey) ||
			(typeof payload.callId === "string" && payload.callId) ||
			artifact.path;
		parsed.push({ identity, namespace, method, path: artifact.path });
	}
	parsed.sort((a, b) => compareSkillWorkflowArtifactPaths(a.path, b.path));
	const seen = new Set<string>();
	const refs: string[] = [];
	for (const call of parsed) {
		if (seen.has(call.identity)) continue;
		seen.add(call.identity);
		refs.push(
			`${runId}:step:${refs.length}:0:${call.namespace}.${call.method}`,
		);
		if (refs.length >= 64) break;
	}
	return refs;
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List rationale records with optional filters and pagination
 */
export async function listRationaleRecords(
	db: DbClient,
	options: ListRationaleRecordsOptions,
): Promise<{ data: TediRationaleRecord[]; total: number }> {
	const { orgId, limit = 50, offset = 0 } = options;

	const conditions: ReturnType<typeof eq>[] = [];
	if (orgId) {
		conditions.push(eq(tediRationaleRecords.orgId, orgId));
	}
	if (options.tediId) {
		conditions.push(eq(tediRationaleRecords.tediId, options.tediId));
	}
	if (options.category) {
		conditions.push(eq(tediRationaleRecords.category, options.category));
	}
	if (options.outcomeStatus) {
		conditions.push(
			eq(tediRationaleRecords.outcomeStatus, options.outcomeStatus),
		);
	}

	const whereClause = and(...conditions);

	const [data, total] = await Promise.all([
		db
			.select()
			.from(tediRationaleRecords)
			.where(whereClause)
			.orderBy(desc(tediRationaleRecords.createdAt))
			.limit(limit)
			.offset(offset),
		db.$count(tediRationaleRecords, whereClause),
	]);

	return { data, total };
}

/**
 * Get a single rationale record by ID
 */
export async function getRationaleRecordById(
	db: DbClient,
	id: string,
): Promise<TediRationaleRecord | undefined> {
	const results = await db
		.select()
		.from(tediRationaleRecords)
		.where(eq(tediRationaleRecords.id, id));
	return results[0];
}

/**
 * Get the rationale chain for a tedi — recent records showing decision patterns
 */
export async function getRationaleChain(
	db: DbClient,
	tediId: string,
	limit = 20,
	orgId?: string,
): Promise<TediRationaleRecord[]> {
	return db
		.select()
		.from(tediRationaleRecords)
		.where(
			orgId
				? and(
						eq(tediRationaleRecords.tediId, tediId),
						eq(tediRationaleRecords.orgId, orgId),
					)
				: eq(tediRationaleRecords.tediId, tediId),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(limit);
}

/**
 * Get recent completed rationale records for the same tedi + category.
 * Returns records where outcomeStatus != 'pending', ordered by createdAt desc.
 * Used to provide contrastive examples (what worked, what failed) before new decisions.
 */
export async function getRecentCompletedByCategory(
	db: DbClient,
	tediId: string,
	category: string,
	limit = 5,
): Promise<TediRationaleRecord[]> {
	return db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, tediId),
				eq(tediRationaleRecords.category, category),
				ne(tediRationaleRecords.outcomeStatus, "pending"),
			),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(limit);
}

/**
 * Phase 4: Detect approval fatigue — 100% success rate over N recent decisions
 * with no failures or edits. Returns the count of consecutive successes.
 * When count >= threshold, the caller should suggest autonomous promotion.
 */
export async function detectApprovalFatigue(
	db: DbClient,
	tediId: string,
	windowSize = 20,
): Promise<{
	consecutiveSuccesses: number;
	totalInWindow: number;
	fatigueDetected: boolean;
}> {
	const recent = await db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, tediId),
				ne(tediRationaleRecords.outcomeStatus, "pending"),
			),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(windowSize);

	if (recent.length < windowSize) {
		return {
			consecutiveSuccesses: 0,
			totalInWindow: recent.length,
			fatigueDetected: false,
		};
	}

	let consecutiveSuccesses = 0;
	for (const record of recent) {
		if (record.outcomeStatus === "success") {
			consecutiveSuccesses++;
		} else {
			break;
		}
	}

	return {
		consecutiveSuccesses,
		totalInWindow: recent.length,
		fatigueDetected: consecutiveSuccesses >= windowSize,
	};
}

/**
 * Phase 6a: Get recent FAILED rationale records for the same tedi + category.
 * Surfaces failure history so the tedi sees what went wrong before making decisions.
 */
export async function getRecentFailedByCategory(
	db: DbClient,
	tediId: string,
	category: string,
	limit = 5,
): Promise<TediRationaleRecord[]> {
	return db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, tediId),
				eq(tediRationaleRecords.category, category),
				eq(tediRationaleRecords.outcomeStatus, "failure"),
			),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(limit);
}

/**
 * Phase 6a: Get the most recent attempt of the same action (by action string prefix).
 * Shows the tedi what happened last time it tried this exact action.
 */
export async function getLastAttemptByAction(
	db: DbClient,
	tediId: string,
	action: string,
): Promise<TediRationaleRecord | null> {
	const results = await db
		.select()
		.from(tediRationaleRecords)
		.where(
			and(
				eq(tediRationaleRecords.tediId, tediId),
				eq(tediRationaleRecords.action, action),
				ne(tediRationaleRecords.outcomeStatus, "pending"),
			),
		)
		.orderBy(desc(tediRationaleRecords.createdAt))
		.limit(1);
	return results[0] ?? null;
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new rationale record
 */
export async function createRationaleRecord(
	db: DbClient,
	data: CreateRationaleRecordParams,
): Promise<TediRationaleRecord> {
	assertRationaleExecutionLinked(data);
	const results = await db
		.insert(tediRationaleRecords)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			action: data.action,
			rationale: data.rationale,
			category: data.category,
			confidence: data.confidence,
			evidence: data.evidence,
			outcomeStatus: "pending",
			approvalRequestId: data.approvalRequestId ?? null,
			objectiveId: data.objectiveId ?? null,
			runId: data.runId ?? null,
			workItemId: data.workItemId ?? null,
			toolCallRefs: data.toolCallRefs ?? null,
			createdAt: data.createdAt,
		})
		.returning();
	const created = results[0];
	if (!created)
		throw new Error(`Failed to create rationale record: ${data.id}`);
	return created;
}

/**
 * Create a rationale record exactly once by caller-derived primary key. A
 * concurrent replay that loses the insert race reads the winning row instead
 * of creating a second Tedix OS decision.
 */
export async function createRationaleRecordIdempotent(
	db: DbClient,
	data: CreateRationaleRecordParams,
): Promise<{ record: TediRationaleRecord; created: boolean }> {
	assertRationaleExecutionLinked(data);
	const inserted = await db
		.insert(tediRationaleRecords)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			action: data.action,
			rationale: data.rationale,
			category: data.category,
			confidence: data.confidence,
			evidence: data.evidence,
			outcomeStatus: "pending",
			approvalRequestId: data.approvalRequestId ?? null,
			objectiveId: data.objectiveId ?? null,
			runId: data.runId ?? null,
			workItemId: data.workItemId ?? null,
			toolCallRefs: data.toolCallRefs ?? null,
			createdAt: data.createdAt,
		})
		.onConflictDoNothing({ target: tediRationaleRecords.id })
		.returning();
	if (inserted[0]) return { record: inserted[0], created: true };
	const existing = await getRationaleRecordById(db, data.id);
	if (!existing) {
		throw new Error(
			`Rationale idempotency conflict did not expose winning row: ${data.id}`,
		);
	}
	return { record: existing, created: false };
}

/**
 * Complete a rationale record with outcome
 */
/**
 * Update the evidence JSON column on a rationale record
 */
export async function updateRationaleEvidence(
	db: DbClient,
	id: string,
	evidence: Record<string, JsonValue>,
): Promise<TediRationaleRecord | undefined> {
	const results = await db
		.update(tediRationaleRecords)
		.set({ evidence })
		.where(eq(tediRationaleRecords.id, id))
		.returning();
	return results[0];
}

/**
 * Delete a rationale record by ID
 * Returns true if a row was deleted, false if not found
 */
export async function deleteRationaleRecord(
	db: DbClient,
	id: string,
): Promise<boolean> {
	const results = await db
		.delete(tediRationaleRecords)
		.where(eq(tediRationaleRecords.id, id))
		.returning({ id: tediRationaleRecords.id });
	return results.length > 0;
}

/** Auto-close abandoned pending decisions so they do not pollute retrieval. */
export async function closeStalePendingRationaleRecords(
	db: DbClient,
	days = 2,
): Promise<number> {
	const results = await db
		.update(tediRationaleRecords)
		.set({
			outcomeStatus: "partial",
			outcome: sql`coalesce(${tediRationaleRecords.outcome}, 'Auto-closed by stale-rationale sweep - pending >48h with no outcome signal')`,
			completedAt: sql`coalesce(${tediRationaleRecords.completedAt}, CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(tediRationaleRecords.outcomeStatus, "pending"),
				sql`${tediRationaleRecords.createdAt} < datetime('now', ${`-${days} days`})`,
			),
		)
		.returning({ id: tediRationaleRecords.id });
	return results.length;
}

/**
 * Complete a rationale record with outcome.
 *
 * Proof-gated (WS1): a `success` claim without a span-checkable `proofRef`
 * is stored as `unverified`, never `success`. Enforced here so no write path
 * can bypass the gate.
 */
export async function completeRationaleRecord(
	db: DbClient,
	id: string,
	params: CompleteRationaleRecordParams,
): Promise<TediRationaleRecord | undefined> {
	const resolvedStatus = resolveOutcomeStatusForProof(
		params.outcomeStatus,
		params.proofRef,
	);
	const results = await db
		.update(tediRationaleRecords)
		.set({
			outcome: params.outcome,
			outcomeStatus: resolvedStatus,
			proofRef: params.proofRef ?? null,
			completedAt: params.completedAt,
		})
		.where(eq(tediRationaleRecords.id, id))
		.returning();
	return results[0];
}

/**
 * Reconcile the skill-workflow dispatch decision to the run's terminal truth.
 *
 * Dispatch only proves admission, not successful execution. Older writers
 * closed this record as success immediately, so this update intentionally
 * overwrites an existing terminal disposition when the canonical skill run
 * later fails or is canceled.
 *
 * Workflow-authored rationale receipts also share the runId. Some procedures
 * intentionally write the rationale before their final durable step and leave
 * it pending; without a second mutation they stayed pending forever even after
 * the skill run terminalized. After reconciling the dispatch row, conservatively
 * settle any remaining pending rows for the run: completed workflows become
 * partial unless the producer explicitly claimed/proved success, failures stay
 * failures, and cancellations stay partial. Exact tool-call receipts are
 * attached to both shapes without fabricating calls.
 */
export async function reconcileSkillWorkflowDispatchRationale(
	db: DbClient,
	input: {
		runId: string;
		status: SkillWorkflowTerminalStatus;
		error?: string | null;
		completedAt?: string;
	},
): Promise<number> {
	const terminal = skillWorkflowDispatchOutcome(input);
	const callArtifacts = await db
		.select({
			path: skillRunArtifacts.path,
			contentInline: skillRunArtifacts.contentInline,
			outcome: skillRunArtifacts.outcome,
		})
		.from(skillRunArtifacts)
		.where(
			and(
				eq(skillRunArtifacts.runId, input.runId),
				like(skillRunArtifacts.path, "%/calls/%"),
			),
		)
		.orderBy(skillRunArtifacts.path)
		.limit(256);
	const toolCallRefs = skillWorkflowToolCallRefs(input.runId, callArtifacts);
	const dispatchRows = await db
		.update(tediRationaleRecords)
		.set({
			outcome: terminal.outcome,
			outcomeStatus: terminal.outcomeStatus,
			proofRef: terminal.proofRef,
			...(toolCallRefs.length > 0 ? { toolCallRefs } : {}),
			completedAt: input.completedAt ?? new Date().toISOString(),
		})
		.where(
			and(
				eq(tediRationaleRecords.runId, input.runId),
				sql`json_extract(${tediRationaleRecords.evidence}, '$.kind') = 'skill_workflow_dispatch'`,
			),
		)
		.returning({ id: tediRationaleRecords.id });

	const receiptOutcome =
		input.status === "completed"
			? {
					outcome: `Workflow run ${input.runId} completed; the workflow-authored rationale did not provide an explicit terminal verdict.`,
					outcomeStatus: "partial" as const,
					proofRef: { kind: "run" as const, ref: input.runId },
				}
			: terminal;
	const receiptRows = await db
		.update(tediRationaleRecords)
		.set({
			outcome: receiptOutcome.outcome,
			outcomeStatus: receiptOutcome.outcomeStatus,
			proofRef: receiptOutcome.proofRef,
			...(toolCallRefs.length > 0 ? { toolCallRefs } : {}),
			completedAt: input.completedAt ?? new Date().toISOString(),
		})
		.where(
			and(
				eq(tediRationaleRecords.runId, input.runId),
				eq(tediRationaleRecords.outcomeStatus, "pending"),
			),
		)
		.returning({ id: tediRationaleRecords.id });
	return dispatchRows.length + receiptRows.length;
}
