/**
 * Decision hygiene for record-layer skill promotions (P5 Kahneman pack).
 *
 * Premortem gate — Klein 2007 ("Performing a Project Premortem", HBR):
 * prospective hindsight ("assume this promoted skill failed in 30 days —
 * why?") surfaces risks that a forward-looking review misses. Tedix enforces
 * it mechanically: any Workshop apply / skill promote that moves a skill
 * INTO the record pace layer (crystallized) or mutates an already
 * record-layer skill must carry a structured premortem note
 * (`premortem: { failureModes: string[≥2], rollback }`).
 *
 * Skip authority follows the capability-mutation-gate allowlist doctrine
 * (docs/decisions/agent-capability-mutation-gate.md): only a signed-in human
 * or an operator API key — caller types that structurally cannot be an LLM's
 * own in-turn tool selection — may waive the premortem, and only with an
 * explicit `skipPremortemReason` that is logged and appended to the durable
 * `revisionReasoning` audit trail. Agent-authenticated callers can never
 * skip. This is decision hygiene in the Kahneman–Sibony–Sunstein (2021,
 * *Noise*) sense: a fixed procedure applied before the judgment, not a
 * quality check after it.
 */

import { defaultPromotedLifecycleState } from "@tedix/db/queries/cognitive/skill-promotion";
import {
	paceLayerForLifecycle,
	type SkillLifecycleState,
} from "@tedix/db/queries/skill-lifecycle";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { createError, ErrorCodes } from "../rpc/orpc";

/** Minimum distinct failure modes a premortem must name. */
export const PREMORTEM_MIN_FAILURE_MODES = 2;

/** Minimum trimmed length for each failure mode, rollback, and skip reason. */
export const PREMORTEM_MIN_TEXT_LENGTH = 8;

export interface SkillPremortemNote {
	failureModes: string[];
	rollback: string;
}

export interface SkillPremortemGateResult {
	/** True when this promotion touches the record layer. */
	required: boolean;
	/** True when a valid premortem note was supplied. */
	provided: boolean;
	/** True when an operator skipped a required premortem with a reason. */
	skipped: boolean;
	/** Durable audit line to append to `revisionReasoning` (null when none). */
	auditLine: string | null;
}

function normalizedText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length >= PREMORTEM_MIN_TEXT_LENGTH ? trimmed : null;
}

/**
 * True when the promotion is a record-layer decision: the target lifecycle
 * lands in the record pace layer (crystallized), or the existing entry is
 * already record-layer content being mutated. The target default mirrors
 * `computeSkillPromotion` (active, preserving proven/crystallized).
 */
export function premortemRequiredForSkillPromotion(
	existing: Pick<SkillEntry, "paceLayer" | "lifecycleState">,
	targetLifecycleState: SkillLifecycleState | undefined,
): boolean {
	const target =
		targetLifecycleState ??
		defaultPromotedLifecycleState(existing.lifecycleState ?? "active");
	if (paceLayerForLifecycle(target) === "record") return true;
	return existing.paceLayer === "record";
}

function validatePremortemNote(
	skillId: string,
	note: SkillPremortemNote,
): { failureModes: string[]; rollback: string } {
	const failureModes = (
		Array.isArray(note.failureModes) ? note.failureModes : []
	)
		.map((mode) => normalizedText(mode))
		.filter((mode): mode is string => mode !== null);
	const distinct = new Set(failureModes.map((mode) => mode.toLowerCase()));
	const rollback = normalizedText(note.rollback);
	if (distinct.size < PREMORTEM_MIN_FAILURE_MODES || !rollback) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`premortem is malformed: it needs at least ${PREMORTEM_MIN_FAILURE_MODES} distinct failureModes and a rollback plan, each at least ${PREMORTEM_MIN_TEXT_LENGTH} characters`,
			{ code: "PREMORTEM_INVALID", skillId },
		);
	}
	return { failureModes, rollback };
}

function premortemAuditLine(note: {
	failureModes: string[];
	rollback: string;
}): string {
	const modes = note.failureModes
		.map((mode, index) => `${index + 1}) ${mode}`)
		.join(" ");
	return `Premortem (Klein 2007): failure modes — ${modes}. Rollback: ${note.rollback}`;
}

/**
 * The one premortem validation function for the Workshop apply / promote
 * handlers. Pure aside from a single console line on operator skip; throws
 * typed oRPC errors, so handlers only forward inputs and append
 * `auditLine` to the promotion's `revisionReasoning`.
 */
export function assertSkillPromotionPremortem(options: {
	existing: Pick<SkillEntry, "id" | "paceLayer" | "lifecycleState">;
	targetLifecycleState: SkillLifecycleState | undefined;
	premortem: SkillPremortemNote | undefined;
	skipReason: string | undefined;
	/** Signed-in human or operator API key (isLifecycleOverrideAuthority). */
	operatorAuthority: boolean;
	/** Dry runs preview the requirement without blocking. */
	dryRun?: boolean;
}): SkillPremortemGateResult {
	const { existing, premortem, operatorAuthority } = options;
	const required = premortemRequiredForSkillPromotion(
		existing,
		options.targetLifecycleState,
	);

	if (premortem) {
		// Validated even when voluntary so a malformed note never rides into
		// the audit trail looking like hygiene.
		const note = validatePremortemNote(existing.id, premortem);
		return {
			required,
			provided: true,
			skipped: false,
			auditLine: premortemAuditLine(note),
		};
	}

	if (!required) {
		return {
			required: false,
			provided: false,
			skipped: false,
			auditLine: null,
		};
	}

	const skipReason = normalizedText(options.skipReason);
	if (skipReason) {
		if (!operatorAuthority) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"skipPremortemReason is an operator-only waiver: agent-authenticated callers must supply the premortem itself ({ premortem: { failureModes: [...], rollback } })",
				{ code: "PREMORTEM_SKIP_FORBIDDEN", skillId: existing.id },
			);
		}
		console.info(
			`[DecisionHygiene] premortem skipped by operator for skill ${existing.id}: ${skipReason}`,
		);
		return {
			required: true,
			provided: false,
			skipped: true,
			auditLine: `Premortem skipped by operator: ${skipReason}`,
		};
	}

	if (options.dryRun) {
		return { required: true, provided: false, skipped: false, auditLine: null };
	}

	throw createError(
		ErrorCodes.BAD_REQUEST,
		"record-layer skill promotion requires a premortem (Klein 2007): assume this promoted skill failed in 30 days and supply { premortem: { failureModes: [at least 2], rollback } }. A signed-in human or operator API key may instead skip with skipPremortemReason (logged); agent callers cannot skip.",
		{ code: "PREMORTEM_REQUIRED", skillId: existing.id, paceLayer: "record" },
	);
}
