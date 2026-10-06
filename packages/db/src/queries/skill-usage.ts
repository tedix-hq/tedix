/**
 * Skill Usage Ledger — canonical recording for every skill execution path.
 *
 * `recordSkillUsageEvent()` is the ONE function that stamps skill usage:
 * - executable skill workflow runs call `recordSkillRunOutcome()` (which
 *   hydrates from the terminal `skill_runs` row and delegates here),
 * - muscle-memory invocations derived from a skill delegate here from the
 *   `muscle.usage` handler,
 * - direct self-reports flow through the `skills.usage` oRPC handler.
 *
 * Each call inserts one `skill_usage_events` row (idempotent on
 * (run_id, execution_epoch)) and, when the insert wins, atomically rolls the
 * `skill_entries.success_count`/`failure_count` counters, `last_used_at`, and
 * `avg_duration_ms`. Only canonical terminal `workflow_run` events may advance
 * lifecycle; direct and muscle reports remain telemetry/selection signals.
 * The event ledger — not the counters — is the source of truth; flywheel pulse
 * counts rows here.
 *
 * Canonical-slot protection: the (run_id, execution_epoch) unique index means a
 * non-workflow self-report that supplies a `skill_runs.id` as its runId would
 * PRE-CLAIM the canonical slot and silently suppress the later terminal
 * workflow stamp — including suppressing failures. Non-workflow reports whose
 * runId already exists in `skill_runs` are therefore REJECTED
 * (`reason: "run_reserved"`); the canonical `workflow_run` stamp from
 * `recordSkillRunOutcome()` is the only writer for those slots. Rejection was
 * chosen over namespacing stored run ids (`direct:${runId}`) because runtime
 * run ids must stay RAW in this ledger: the retrieved→used metric joins
 * `context.injected` runtime events against usage events within the same
 * run/conversation window, and chat/turn run ids never collide with
 * `skill_runs` ids — so legitimate direct telemetry is unaffected while
 * squatting a workflow slot becomes impossible.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type SkillEntry,
	type SkillUsageEvent,
	type SkillUsageOutcome,
	type SkillUsageSource,
	skillEntries,
	skillRuns,
	skillUsageEvents,
} from "../schema/cognitive";
import {
	loadSkillUsageSignals,
	nextSkillLifecycleState,
	paceLayerForLifecycle,
} from "./skill-lifecycle";

export type { SkillUsageEvent, SkillUsageOutcome, SkillUsageSource };

/**
 * Failed skill_runs whose error carries a workflow-admission marker never
 * executed skill code — the engine refused or lost the submission. They are
 * infrastructure outcomes, not skill-quality signals, so they are not
 * recorded as usage (and an admission-recovered run that later completes
 * still gets its clean success stamp).
 */
const SKILL_RUN_INFRA_ERROR_PREFIX = "WORKFLOW_ADMISSION_";

export interface RecordSkillUsageEventInput {
	organizationId: string;
	tediId: string | null;
	skillId: string;
	source: SkillUsageSource;
	success: boolean;
	/** skill_runs.id for workflow runs; generated when omitted. */
	runId?: string;
	executionEpoch?: number;
	error?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	durationMs?: number | null;
}

export interface RecordSkillUsageEventResult {
	recorded: boolean;
	runId: string;
	outcome: SkillUsageOutcome;
	reason?: "duplicate" | "skill_not_found" | "run_reserved";
}

async function recordSkillUsageEventInternal(
	db: DbClient,
	input: RecordSkillUsageEventInput,
	promotionEligible: boolean,
): Promise<RecordSkillUsageEventResult> {
	const runId = input.runId ?? crypto.randomUUID();
	const executionEpoch = input.executionEpoch ?? 0;
	const outcome: SkillUsageOutcome = input.success ? "success" : "failure";
	const now = new Date().toISOString();
	const startedAt = input.startedAt ?? null;
	const finishedAt = input.finishedAt ?? now;

	let durationMs = input.durationMs ?? null;
	if (durationMs == null && startedAt) {
		const started = Date.parse(startedAt);
		const finished = Date.parse(finishedAt);
		if (!Number.isNaN(started) && !Number.isNaN(finished)) {
			durationMs = Math.max(finished - started, 0);
		}
	}

	const skillRows = await db
		.select({ id: skillEntries.id })
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, input.skillId),
				eq(skillEntries.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!skillRows[0]) {
		return { recorded: false, runId, outcome, reason: "skill_not_found" };
	}

	// Idempotency claim: only the call that wins this insert rolls counters.
	const inserted = await db
		.insert(skillUsageEvents)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			tediId: input.tediId,
			skillId: input.skillId,
			runId,
			executionEpoch,
			source: input.source,
			outcome,
			error: input.success ? null : (input.error ?? null),
			startedAt,
			finishedAt,
			durationMs,
			createdAt: now,
		})
		.onConflictDoNothing({
			target: [skillUsageEvents.runId, skillUsageEvents.executionEpoch],
		})
		.returning({ id: skillUsageEvents.id });
	if (inserted.length === 0) {
		return { recorded: false, runId, outcome, reason: "duplicate" };
	}

	// Atomic counter roll — no read-modify-write races between recorders.
	const updatedRows = await db
		.update(skillEntries)
		.set({
			successCount: sql`${skillEntries.successCount} + ${input.success ? 1 : 0}`,
			failureCount: sql`${skillEntries.failureCount} + ${input.success ? 0 : 1}`,
			lastUsedAt: now,
			updatedAt: now,
		})
		.where(eq(skillEntries.id, input.skillId))
		.returning();
	const updated = updatedRows[0];
	if (updated) {
		const patch: Partial<SkillEntry> = {};
		// Execute-to-promote: advancement/demotion is computed from the usage
		// ledger itself (this event included), not the rollup counters.
		const signals = await loadSkillUsageSignals(
			db,
			input.organizationId,
			input.skillId,
		);
		const advance = nextSkillLifecycleState({
			current: updated.lifecycleState,
			success: input.success,
			promotionEligible,
			verifiedSuccessCount: signals.verifiedSuccessCount,
			recentOutcomes: signals.recentOutcomes,
		});
		if (advance.state !== updated.lifecycleState) {
			patch.lifecycleState = advance.state;
			// WS6: lifecycle transitions re-derive the pace layer automatically.
			patch.paceLayer = paceLayerForLifecycle(advance.state);
		}
		if (advance.flagForReview && !updated.reviewFlaggedAt) {
			patch.reviewFlaggedAt = now;
			patch.reviewFlagReason = `crystallized skill recorded a failure (run ${runId})${
				input.error ? `: ${input.error.slice(0, 200)}` : ""
			}`;
		}
		if (input.success && durationMs != null && updated.successCount > 0) {
			const prevTotal =
				(updated.avgDurationMs ?? 0) * (updated.successCount - 1);
			patch.avgDurationMs = Math.round(
				(prevTotal + durationMs) / updated.successCount,
			);
		}
		if (Object.keys(patch).length > 0) {
			// Lifecycle CAS: the patch was computed from the lifecycle state read
			// above. A concurrent lifecycle write (e.g. an operator archiving the
			// skill) between that read and this write must win — an unconditioned
			// read-modify-write here could resurrect an archived skill. On miss,
			// skip silently; the next recorded usage recomputes from current state.
			await db
				.update(skillEntries)
				.set(patch)
				.where(
					and(
						eq(skillEntries.id, input.skillId),
						updated.lifecycleState == null
							? isNull(skillEntries.lifecycleState)
							: eq(skillEntries.lifecycleState, updated.lifecycleState),
					),
				);
		}
	}

	return { recorded: true, runId, outcome };
}

/**
 * Record non-authoritative usage telemetry. Workflow outcomes deliberately
 * cannot enter through this public path: `recordSkillRunOutcome()` must first
 * resolve the canonical terminal `skill_runs` row. A caller-supplied runId
 * that names an existing `skill_runs` row is rejected (`run_reserved`) so a
 * self-report can never pre-claim the canonical (runId, executionEpoch) slot
 * and suppress the terminal workflow stamp — see the module docstring.
 */
export async function recordSkillUsageEvent(
	db: DbClient,
	input: RecordSkillUsageEventInput,
): Promise<RecordSkillUsageEventResult> {
	if (input.source === "workflow_run") {
		throw new Error(
			"workflow_run usage must be recorded via recordSkillRunOutcome() so terminal execution evidence is resolved canonically",
		);
	}
	if (input.runId) {
		const reserved = await db
			.select({ id: skillRuns.id })
			.from(skillRuns)
			.where(eq(skillRuns.id, input.runId))
			.limit(1);
		if (reserved[0]) {
			return {
				recorded: false,
				runId: input.runId,
				outcome: input.success ? "success" : "failure",
				reason: "run_reserved",
			};
		}
	}
	return recordSkillUsageEventInternal(db, input, false);
}

export interface RecordSkillRunOutcomeResult extends RecordSkillUsageEventResult {
	status: "completed" | "failed";
}

export interface RecordSkillRunOutcomeOptions {
	/**
	 * Terminal (status, executionEpoch) captured ATOMICALLY by the caller's
	 * terminal CAS (`UPDATE ... RETURNING`). When provided, the stamp is pinned
	 * to that identity: an operator restart racing between the CAS and this
	 * stamp bumps the row's execution_epoch, and an unpinned re-read would
	 * attribute the OLD outcome to the NEW epoch — suppressing the restarted
	 * execution's own terminal stamp later (the (runId, epoch) insert is
	 * first-writer-wins).
	 */
	expected?: { status: "completed" | "failed"; executionEpoch: number };
}

/**
 * Stamp the usage outcome for a terminal executable-skill workflow run.
 * Call after any reconcile that moves a `skill_runs` row to completed/failed;
 * idempotent per (run, execution epoch), no-op for non-terminal, canceled,
 * or admission-marker (never-executed) runs.
 *
 * Two modes:
 * - pinned (`options.expected` set): stamps the CAS-captured status under the
 *   CAS-captured epoch even if the row has since been restarted. Row fields
 *   (error/timestamps) are used only while the row still shows the pinned
 *   status; after a racing restart re-dispatch clears them, nulls are stamped
 *   rather than mixing epochs.
 * - observed (no options): re-reads the row and stamps terminal-but-unstamped
 *   state — the reconciler's crash-heal backstop. Skipped while
 *   `restart_requested_at` is pending, because the row's terminal fields then
 *   describe the PREVIOUS epoch while execution_epoch already points at the
 *   next one.
 */
export async function recordSkillRunOutcome(
	db: DbClient,
	runId: string,
	options?: RecordSkillRunOutcomeOptions,
): Promise<RecordSkillRunOutcomeResult | null> {
	const rows = await db
		.select()
		.from(skillRuns)
		.where(eq(skillRuns.id, runId))
		.limit(1);
	const run = rows[0];
	if (!run) return null;
	const expected = options?.expected;
	if (!expected) {
		if (run.restartRequestedAt != null) return null;
		if (run.status !== "completed" && run.status !== "failed") return null;
	}
	const status = expected?.status ?? (run.status as "completed" | "failed");
	const executionEpoch = expected
		? expected.executionEpoch
		: run.executionEpoch;
	// Row fields still describe the pinned outcome only while the row's status
	// matches it (an epoch reservation alone leaves them untouched).
	const rowMatchesOutcome = run.status === status;
	const error = rowMatchesOutcome ? run.error : null;
	if (status === "failed" && error?.startsWith(SKILL_RUN_INFRA_ERROR_PREFIX)) {
		return null;
	}
	const success = status === "completed";
	const result = await recordSkillUsageEventInternal(
		db,
		{
			organizationId: run.organizationId,
			tediId: run.tediId,
			skillId: run.skillId,
			source: "workflow_run",
			success,
			runId: run.id,
			executionEpoch,
			error: success ? null : error,
			startedAt: rowMatchesOutcome ? run.startedAt : null,
			finishedAt: rowMatchesOutcome ? run.completedAt : null,
		},
		true,
	);
	return { ...result, status };
}
