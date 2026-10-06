/**
 * Auto-Crystallization — pure pattern detection.
 *
 * Scans procedural observations for recurring patterns. When 3+ procedural
 * observations share a pattern key the runtime may crystallize the pattern
 * into muscle memory / a draft skill. The HTTP calls that record the skill
 * live in the runtime or brain-bridge; this module only
 * does in-memory clustering, threshold checks, and quality gates.
 */

import { STOP_WORDS } from "./text-utils.js";
import type { Observation } from "./types.js";

/** Minimum procedural observations with the same pattern to trigger crystallization. */
export const CRYSTALLIZATION_THRESHOLD = 3;

/** Status-noise filter — when matched, the candidate is rejected. */
export const STATUS_OBSERVATION_RE =
	/\b(heartbeat|poll|reminder|cron|scheduled|cycle|returned|completed|could not execute|was run|was triggered|instructed the agent|no projected tools|no running|no recent session)\b/i;

/** Action-verb filter — when not matched, the candidate is rejected. */
export const ACTION_VERB_RE =
	/\b(create|update|repair|audit|review|validate|deploy|sync|import|export|classify|triage|reconcile|generate|publish|investigate|summarize|optimize|migrate|onboard|offboard|route|backfill)\b/i;

/** Pattern fingerprint for grouping similar procedural observations. */
export interface ProceduralPattern {
	/** Normalized key for this pattern. */
	key: string;
	/** Representative observation content. */
	representative: string;
	/** All matching observations. */
	observations: Observation[];
	/** Has this pattern already been crystallized? */
	crystallized: boolean;
	/** Muscle memory ID if crystallized. */
	muscleId?: string;
}

/**
 * Track which patterns have been crystallized to avoid duplicates.
 * Persistence (JSON file, KV, D1) is the runtime's concern; this is the shape.
 */
export interface CrystallizationState {
	/** pattern key → { muscleId, version, crystallizedAt, observationCount } */
	patterns: Record<
		string,
		{
			muscleId: string;
			version: number;
			crystallizedAt: string;
			observationCount: number;
		}
	>;
}

/**
 * Compute a normalized key for grouping similar procedural observations.
 * Uses significant words from content, preserving word order.
 */
export function computePatternKey(obs: Observation): string {
	const words = obs.content
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 3 && !STOP_WORDS.has(w))
		.slice(0, 5)
		.join("|");
	return words || obs.content.slice(0, 30).toLowerCase();
}

/**
 * Scan observations for crystallization candidates.
 * Returns patterns that meet the threshold but haven't been crystallized yet,
 * plus patterns that have grown by another full threshold (re-version).
 */
export function detectCandidates(
	observations: Observation[],
	state: CrystallizationState,
): ProceduralPattern[] {
	const procedural = observations.filter((o) => o.type === "procedural");
	if (procedural.length < CRYSTALLIZATION_THRESHOLD) return [];

	const groups = new Map<string, ProceduralPattern>();

	for (const obs of procedural) {
		const key = computePatternKey(obs);
		const existing = groups.get(key);
		if (existing) {
			existing.observations.push(obs);
		} else {
			groups.set(key, {
				key,
				representative: obs.content,
				observations: [obs],
				crystallized: key in state.patterns,
				muscleId: state.patterns[key]?.muscleId,
			});
		}
	}

	const candidates: ProceduralPattern[] = [];

	for (const pattern of groups.values()) {
		const count = pattern.observations.length;
		const prior = state.patterns[pattern.key];

		if (!prior && count >= CRYSTALLIZATION_THRESHOLD) {
			candidates.push(pattern);
		} else if (
			prior &&
			count >= prior.observationCount + CRYSTALLIZATION_THRESHOLD
		) {
			// Pattern has grown — mark as upgrade.
			pattern.crystallized = true;
			candidates.push(pattern);
		}
	}

	return candidates;
}

export type QualityGateRejection =
	| "description_too_short"
	| "all_identical"
	| "representative_too_short"
	| "status_observation"
	| "no_action_verb";

export interface QualityGateResult {
	ok: boolean;
	reason?: QualityGateRejection;
	steps: string[];
	description: string;
	name: string;
}

/**
 * Apply the crystallizer's quality gates to a candidate pattern. Returns
 * the deduped steps, joined description, and a generated name when the
 * candidate passes — or `{ ok: false, reason }` when rejected.
 */
export function evaluateQuality(pattern: ProceduralPattern): QualityGateResult {
	const steps = pattern.observations
		.map((o) => o.content)
		.filter((c, i, arr) => arr.indexOf(c) === i)
		.slice(0, 5);

	const description = steps.map((s) => `- ${s}`).join("\n");

	const firstStep = steps[0] ?? pattern.representative;
	const nameCandidate =
		firstStep.length > 80
			? `${firstStep.slice(0, firstStep.lastIndexOf(" ", 80) || 80)}...`
			: firstStep;
	const name = nameCandidate;

	if (description.length < 50) {
		return {
			ok: false,
			reason: "description_too_short",
			steps,
			description,
			name,
		};
	}
	if (new Set(steps).size === 1 && steps.length > 1) {
		return { ok: false, reason: "all_identical", steps, description, name };
	}
	if (pattern.representative.length < 20) {
		return {
			ok: false,
			reason: "representative_too_short",
			steps,
			description,
			name,
		};
	}
	const combined = `${pattern.representative}\n${description}`;
	if (STATUS_OBSERVATION_RE.test(combined)) {
		return {
			ok: false,
			reason: "status_observation",
			steps,
			description,
			name,
		};
	}
	if (!ACTION_VERB_RE.test(combined)) {
		return { ok: false, reason: "no_action_verb", steps, description, name };
	}

	return { ok: true, steps, description, name };
}

/**
 * Return the next version number for a pattern given existing state.
 * 1 for a brand-new pattern, prior.version + 1 for a re-crystallization.
 */
export function nextPatternVersion(
	key: string,
	state: CrystallizationState,
): number {
	const prior = state.patterns[key];
	return prior ? prior.version + 1 : 1;
}
