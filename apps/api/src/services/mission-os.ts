import type { RationaleOutcomeStatus } from "@tedix/api-contract/constants/enums";
import {
	DEFAULT_GATE_MIN_COMPLEXITY,
	type GateConfig,
	parseGateConfig,
} from "@tedix/api-contract/contracts/tedi-objectives";
import type { DbClient } from "@tedix/db/client";
import { countRationaleRunToolEvents } from "@tedix/db/queries/rationale-records";
import {
	getObjectiveById,
	listTasks,
	updateObjective,
	updateTask,
} from "@tedix/db/queries/tedi-objectives";
import type { ObjectiveStatus } from "@tedix/db/schema/tedi-objectives";

/**
 * Cascade-complete child tasks when a parent objective is completed or failed.
 * - Objective completed → pending/in_progress tasks become "completed"
 * - Objective failed → pending/in_progress tasks become "abandoned"
 */
export async function cascadeCompleteChildTasks(
	db: DbClient,
	objectiveId: string,
	objectiveStatus: Extract<ObjectiveStatus, "completed" | "failed">,
): Promise<number> {
	const now = new Date().toISOString();
	const targetTaskStatus =
		objectiveStatus === "completed" ? "completed" : "abandoned";
	const resultMessage =
		objectiveStatus === "completed"
			? "Auto-completed: parent objective completed"
			: "Auto-abandoned: parent objective failed";

	let closed = 0;
	let offset = 0;
	const PAGE = 200;

	for (;;) {
		const { data: tasks } = await listTasks(db, {
			objectiveId,
			limit: PAGE,
			offset,
		});

		const toClose = tasks.filter(
			(t) => t.status === "pending" || t.status === "in_progress",
		);

		for (const task of toClose) {
			await updateTask(db, task.id, {
				status: targetTaskStatus,
				result: resultMessage,
				updatedAt: now,
				completedAt: now,
			});
		}

		closed += toClose.length;

		if (tasks.length < PAGE) break;
		offset += PAGE;
	}

	return closed;
}

// =============================================================================
// Gate Graduation — Autonomy promotion logic
// =============================================================================

export interface GateGraduationResult {
	/** Whether the gate config was updated */
	updated: boolean;
	/** Whether a graduation (level promotion) occurred */
	graduated: boolean;
	/** The previous autonomy level */
	previousLevel: GateConfig["autonomyLevel"];
	/** The new autonomy level */
	newLevel: GateConfig["autonomyLevel"];
	/** The updated streak count */
	currentStreak: number;
}

/**
 * Compute the next gate config after a rationale outcome.
 *
 * Rules:
 * - "always" gate type never auto-promotes
 * - On success: increment streak. If streak >= threshold, promote level.
 * - On failure: reset streak to 0
 * - Promotion path: manual → supervised → autonomous (no further)
 * - Returns the new GateConfig (caller persists it)
 */
/**
 * @param complexityScore - Mechanical episode complexity (P5 scorecard
 *   discipline — Goodhart guard, DataRobot precedent). When provided, a
 *   success below `graduationCriteria.minComplexity` (default
 *   `DEFAULT_GATE_MIN_COMPLEXITY`) is graduation-inert: it neither advances
 *   nor resets the streak, so a tedi cannot farm trivial tasks into
 *   autonomy. Failures always reset regardless of complexity. When absent
 *   (no episode signal derivable), falls back to streak-only behavior.
 */
export function computeGateGraduation(
	gateConfig: GateConfig,
	// Any non-success (including `unverified` — a proof-less success claim)
	// resets the streak and never advances a gate.
	outcomeStatus: RationaleOutcomeStatus,
	complexityScore?: number,
): { newConfig: GateConfig; graduated: boolean } {
	// "always" gate never auto-promotes
	if (gateConfig.gateType === "always") {
		return { newConfig: gateConfig, graduated: false };
	}

	// Complexity floor: a below-floor success freezes the streak (no advance,
	// no reset, no graduation). Checked before every success-counting branch
	// so trivial successes are inert at every autonomy level.
	if (outcomeStatus === "success" && complexityScore !== undefined) {
		const minComplexity =
			gateConfig.graduationCriteria.minComplexity ??
			DEFAULT_GATE_MIN_COMPLEXITY;
		if (complexityScore < minComplexity) {
			return { newConfig: gateConfig, graduated: false };
		}
	}

	// Already at max autonomy — nothing to do
	if (gateConfig.autonomyLevel === "autonomous") {
		// Still track streaks for observability but no promotion
		const newStreak =
			outcomeStatus === "success" ? gateConfig.currentStreak + 1 : 0;
		return {
			newConfig: { ...gateConfig, currentStreak: newStreak },
			graduated: false,
		};
	}

	// Failure or partial: reset streak
	if (outcomeStatus !== "success") {
		return {
			newConfig: { ...gateConfig, currentStreak: 0 },
			graduated: false,
		};
	}

	// Success: increment streak and check graduation
	const newStreak = gateConfig.currentStreak + 1;
	const threshold = gateConfig.graduationCriteria.consecutiveSuccesses;

	if (newStreak >= threshold) {
		const nextLevel =
			gateConfig.autonomyLevel === "manual" ? "supervised" : "autonomous";
		return {
			newConfig: {
				...gateConfig,
				autonomyLevel: nextLevel,
				currentStreak: 0, // Reset streak after graduation
				lastGraduatedAt: new Date().toISOString(),
			},
			graduated: true,
		};
	}

	return {
		newConfig: { ...gateConfig, currentStreak: newStreak },
		graduated: false,
	};
}

/**
 * Process gate graduation for an objective after a rationale record completes.
 *
 * Called from the rationale `complete` procedure. Loads the objective,
 * computes graduation, persists the updated gateConfig, and returns the result.
 *
 * No-ops gracefully when:
 * - objectiveId is null (ad-hoc rationale, not linked to an objective)
 * - Objective not found
 * - Gate config is empty/invalid (treated as "manual", still tracked)
 */
export async function processGateGraduation(
	db: DbClient,
	objectiveId: string | null | undefined,
	outcomeStatus: RationaleOutcomeStatus,
	complexityScore?: number,
): Promise<GateGraduationResult | null> {
	if (!objectiveId) return null;

	const objective = await getObjectiveById(db, objectiveId);
	if (!objective) return null;

	const currentConfig = parseGateConfig(objective.gateConfig);
	const previousLevel = currentConfig.autonomyLevel;

	const { newConfig, graduated } = computeGateGraduation(
		currentConfig,
		outcomeStatus,
		complexityScore,
	);

	// Only write if something changed
	const configChanged =
		newConfig.currentStreak !== currentConfig.currentStreak ||
		newConfig.autonomyLevel !== currentConfig.autonomyLevel ||
		newConfig.lastGraduatedAt !== currentConfig.lastGraduatedAt;

	if (configChanged) {
		await updateObjective(db, objectiveId, {
			gateConfig: newConfig,
			updatedAt: new Date().toISOString(),
		});
	}

	return {
		updated: configChanged,
		graduated,
		previousLevel,
		newLevel: newConfig.autonomyLevel,
		currentStreak: newConfig.currentStreak,
	};
}

// =============================================================================
// Episode complexity — Goodhart guard input for gate graduation
// (P5 scorecard discipline: complexity-weighted graduation)
// =============================================================================

export interface EpisodeComplexitySignals {
	/** Tool calls executed in the episode (write-time toolCallRefs, or the
	 * runtime-event ledger count for the episode's run). */
	toolCallCount: number;
	/** Episode wall-clock duration (createdAt → completedAt), null if unknown. */
	durationMs: number | null;
	/** Whether the episode is linked to a Work Item (case notion). */
	workItemLinked: boolean;
}

/**
 * Mechanical episode complexity. Formula:
 *
 *   complexity = toolCallCount
 *              + (workItemLinked ? 1 : 0)
 *              + durationPoints            // 0 (<1min), 1 (≥1min), 2 (≥5min)
 *
 * toolCallCount is the primary signal: it is the same "steps" measure the
 * learning curves use, is stamped at write time by the execution-link
 * invariant, and cannot be lowered without also losing the outcome proof.
 * Work-item linkage and duration are secondary corroborators.
 */
export function computeEpisodeComplexity(
	signals: EpisodeComplexitySignals,
): number {
	const durationPoints =
		signals.durationMs === null
			? 0
			: signals.durationMs >= 300_000
				? 2
				: signals.durationMs >= 60_000
					? 1
					: 0;
	return (
		Math.max(0, signals.toolCallCount) +
		(signals.workItemLinked ? 1 : 0) +
		durationPoints
	);
}

/**
 * Derive a completed rationale episode's complexity from the data actually
 * present on the record. Prefers write-time `toolCallRefs`; falls back to
 * counting `tool.completed`/`tool.failed` runtime events for the episode's
 * run (the same fallback `getTaskTypeLearningCurves` uses).
 */
export async function resolveEpisodeComplexity(
	db: DbClient,
	access: { tediId: string; orgId: string },
	record: {
		runId: string | null;
		workItemId: string | null;
		toolCallRefs: string[] | null;
		createdAt: string;
		completedAt: string | null;
	},
): Promise<number> {
	let toolCallCount = record.toolCallRefs?.length ?? 0;
	if (toolCallCount === 0 && record.runId) {
		toolCallCount = await countRationaleRunToolEvents(db, {
			tediId: access.tediId,
			orgId: access.orgId,
			runId: record.runId,
		});
	}
	const completedAtMs = record.completedAt
		? Date.parse(record.completedAt)
		: Number.NaN;
	const createdAtMs = Date.parse(record.createdAt);
	const durationMs =
		Number.isFinite(completedAtMs) && Number.isFinite(createdAtMs)
			? Math.max(0, completedAtMs - createdAtMs)
			: null;
	return computeEpisodeComplexity({
		toolCallCount,
		durationMs,
		workItemLinked: Boolean(record.workItemId),
	});
}
