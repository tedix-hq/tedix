import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MuscleMemoryKind,
	skillEntries,
	type TediMuscleMemoryItem,
} from "../../schema/cognitive";
import {
	assertForcedSkillPromotionAuthority,
	type ForcedSkillPromotionAuthority,
	hasUnrecoveredFailure,
	loadSkillUsageSignals,
	SKILL_PROVEN_MIN_SUCCESSES,
	SKILL_PROVEN_RECENT_WINDOW,
	SkillLifecycleTransitionError,
} from "../skill-lifecycle";
import { createMuscleMemory } from "./muscle-memory";
import { updateSkillEntry } from "./skill-crud";

/**
 * The one sanctioned writer of `lifecycleState="crystallized"`. Gated at this
 * layer (backstopping the handler) by:
 *
 * 1. Org scope — the source skill must live in `organizationId`; the final
 *    lifecycle UPDATE is org-scoped too (defense in depth).
 * 2. The proven muscle bar — ≥SKILL_PROVEN_MIN_SUCCESSES verified terminal
 *    workflow successes in skill_usage_events with no unrecovered failure in
 *    the recent window. Crystallization compresses PROVEN behavior; there is
 *    no operator bypass here (operators force lifecycle via skills.improve/
 *    promote instead, which never mints a muscle entry).
 * 3. disposer separation — `authority` must be an operator or a tedi that
 *    is not the skill's authoring identity (assertForcedSkillPromotionAuthority
 *    with `via: "crystallize"`, the one carve-out from the tedi force ceiling
 *    because the evidence bar was just verified).
 */
export async function crystallizeMuscleFromSkill(
	db: DbClient,
	params: {
		tediId: string;
		organizationId: string;
		skillId: string;
		kind: MuscleMemoryKind;
		name: string;
		description?: string;
		r2Path?: string;
		codeModule?: string;
		allowedNamespaces?: string[];
		/** Who is exercising the crystallization (two-layer gate). */
		authority: ForcedSkillPromotionAuthority;
		/** Full replacement audit trail (premortem line appended by handler). */
		revisionReasoning?: string;
	},
): Promise<TediMuscleMemoryItem> {
	const rows = await db
		.select({
			id: skillEntries.id,
			organizationId: skillEntries.organizationId,
			lifecycleState: skillEntries.lifecycleState,
			tediId: skillEntries.tediId,
			proposedByTediId: skillEntries.proposedByTediId,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, params.skillId),
				eq(skillEntries.organizationId, params.organizationId),
			),
		)
		.limit(1);
	const skill = rows[0];
	if (!skill) {
		throw new SkillLifecycleTransitionError(
			"crystallization source skill not found in this organization",
			{
				skillId: params.skillId,
				from: "draft",
				to: "crystallized",
				rule: "crystallize_out_of_scope",
			},
		);
	}

	// The proven muscle bar IS the crystallization gate — verified against the
	// canonical ledger, never rollup counters or caller claims.
	const signals = await loadSkillUsageSignals(
		db,
		params.organizationId,
		params.skillId,
	);
	if (signals.verifiedSuccessCount < SKILL_PROVEN_MIN_SUCCESSES) {
		throw new SkillLifecycleTransitionError(
			`crystallization requires the proven muscle bar: ≥${SKILL_PROVEN_MIN_SUCCESSES} verified terminal workflow successes in skill_usage_events (found ${signals.verifiedSuccessCount})`,
			{
				skillId: params.skillId,
				from: skill.lifecycleState ?? "draft",
				to: "crystallized",
				rule: "crystallize_requires_proven_evidence",
			},
		);
	}
	if (hasUnrecoveredFailure(signals.recentOutcomes)) {
		throw new SkillLifecycleTransitionError(
			`crystallization blocked: an unrecovered failure exists in the last ${SKILL_PROVEN_RECENT_WINDOW} usage events`,
			{
				skillId: params.skillId,
				from: skill.lifecycleState ?? "draft",
				to: "crystallized",
				rule: "crystallize_requires_recovery",
			},
		);
	}

	// Two-layer gate: the handler resolved the authority; assert it again
	// here so no caller of this function can skip disposer separation.
	assertForcedSkillPromotionAuthority(skill, "crystallized", params.authority, {
		via: "crystallize",
	});

	const entry = await createMuscleMemory(db, {
		id: crypto.randomUUID(),
		tediId: params.tediId,
		organizationId: params.organizationId,
		kind: params.kind,
		name: params.name,
		description: params.description ?? null,
		r2Path: params.r2Path ?? null,
		codeModule: params.codeModule ?? null,
		allowedNamespaces: params.allowedNamespaces ?? null,
		origin: "from_skill",
		sourceSkillId: params.skillId,
	});
	// `via` marks this as the one sanctioned writer of `crystallized`;
	// `organizationId` org-scopes the UPDATE itself (defense in depth).
	await updateSkillEntry(
		db,
		params.skillId,
		{
			lifecycleState: "crystallized",
			...(params.revisionReasoning !== undefined
				? { revisionReasoning: params.revisionReasoning }
				: {}),
		},
		{ via: "crystallize", organizationId: params.organizationId },
	);
	return entry;
}

/**
 * Platform-admin lineage read: every skill entry (ANY org) derived from the
 * given canonical skill, with its recorded source revision — the target list
 * for a blueprint-style fleet upgrade pass. Deliberately NOT org-scoped:
 * callers must hold platform-admin authority (enforced at the router layer).
 */
export async function listDerivedSkillEntries(
	db: DbClient,
	sourceSkillId: string,
): Promise<
	Array<{
		id: string;
		organizationId: string;
		tediId: string | null;
		title: string;
		slug: string | null;
		revision: number;
		sourceRevision: number | null;
		updatedAt: string | null;
	}>
> {
	return db
		.select({
			id: skillEntries.id,
			organizationId: skillEntries.organizationId,
			tediId: skillEntries.tediId,
			title: skillEntries.title,
			slug: skillEntries.slug,
			revision: skillEntries.revision,
			sourceRevision: skillEntries.sourceRevision,
			updatedAt: skillEntries.updatedAt,
		})
		.from(skillEntries)
		.where(eq(skillEntries.sourceSkillId, sourceSkillId))
		.orderBy(skillEntries.organizationId, skillEntries.updatedAt);
}
