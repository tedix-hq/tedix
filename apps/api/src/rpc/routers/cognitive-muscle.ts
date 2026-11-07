/**
 * oRPC Cognitive Stack Router — muscle memory slice.
 * Handlers are composed into the exported router in cognitive.ts.
 */

import {
	getMuscleMemoryById,
	listMuscleMemory,
	type MuscleMemoryKind,
	recordMuscleUsage,
	upsertMuscleMemory,
} from "@tedix/db/queries/cognitive/muscle-memory";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { crystallizeMuscleFromSkill } from "@tedix/db/queries/cognitive/skill-crystallization";
import {
	hasUnrecoveredFailure,
	loadSkillUsageSignals,
	SKILL_PROVEN_MIN_SUCCESSES,
	SKILL_PROVEN_RECENT_WINDOW,
	SkillLifecycleTransitionError,
} from "@tedix/db/queries/skill-lifecycle";
import { recordSkillUsageEvent } from "@tedix/db/queries/skill-usage";
import { assertSkillPromotionPremortem } from "../../services/decision-hygiene";
import { AUTHZ, createError, ErrorCodes } from "../orpc";
import {
	appendRevisionReasoning,
	authedMuscle,
	isLifecycleOverrideAuthority,
	skillProposalApplyAuthority,
} from "./cognitive-shared";
import { requireOrgId } from "../org-scope";

// =============================================================================
// MUSCLE MEMORY
// =============================================================================

export const muscleList = authedMuscle.list
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required (provide in input or authenticate as a tedi)",
			);
		}
		const entries = await listMuscleMemory(context.db, orgId, tediId, {
			includeUnproven: input.includeUnproven,
			kind: input.kind as MuscleMemoryKind,
			limit: input.limit,
		});
		return { entries };
	});

export const muscleRegister = authedMuscle.register
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required (provide in input or authenticate as a tedi)",
			);
		}
		if (input.codeModule && !input.allowedNamespaces?.length) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"allowedNamespaces is required when registering executable codeModule — declare the namespace allowlist the code may call",
			);
		}
		const entry = await upsertMuscleMemory(context.db, {
			id: crypto.randomUUID(),
			tediId,
			organizationId: orgId,
			kind: input.kind,
			name: input.name,
			description: input.description ?? null,
			r2Path: input.r2Path ?? null,
			origin: input.origin,
			codeModule: input.codeModule ?? null,
			allowedNamespaces: input.allowedNamespaces ?? null,
		});
		return { entry };
	});

export const muscleCrystallize = authedMuscle.crystallize
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const tediId = input.tediId ?? context.tediId;
		if (!tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required (provide in input or authenticate as a tedi)",
			);
		}
		if (input.codeModule && !input.allowedNamespaces?.length) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"allowedNamespaces is required when crystallizing executable codeModule — declare the namespace allowlist the code may call",
			);
		}

		// Crystallization is a record-layer promotion of the SOURCE SKILL, not
		// just a muscle-memory insert — it is gated like one:
		// 1. Org scope: the skill must belong to the caller's org.
		const skill = await getSkillEntry(context.db, input.skillId, orgId);
		if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");

		// 2. The proven muscle bar, verified against the canonical usage
		//    ledger — never rollup counters or caller claims. No caller class
		//    is exempt: crystallization compresses PROVEN behavior.
		const signals = await loadSkillUsageSignals(
			context.db,
			orgId,
			input.skillId,
		);
		if (signals.verifiedSuccessCount < SKILL_PROVEN_MIN_SUCCESSES) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`crystallization requires the proven muscle bar: ≥${SKILL_PROVEN_MIN_SUCCESSES} verified terminal workflow successes in skill_usage_events (found ${signals.verifiedSuccessCount})`,
				{
					code: "CRYSTALLIZE_REQUIRES_PROVEN_EVIDENCE",
					skillId: input.skillId,
				},
			);
		}
		if (hasUnrecoveredFailure(signals.recentOutcomes)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`crystallization blocked: an unrecovered failure exists in the last ${SKILL_PROVEN_RECENT_WINDOW} usage events`,
				{ code: "CRYSTALLIZE_REQUIRES_RECOVERY", skillId: input.skillId },
			);
		}

		// 3. Klein-2007 premortem — entering the record pace layer. Same
		//    semantics as promote/apply: agent callers must supply it; only
		//    operators may skip, with a logged reason.
		const premortemGate = assertSkillPromotionPremortem({
			existing: skill,
			targetLifecycleState: "crystallized",
			premortem: input.premortem,
			skipReason: input.skipPremortemReason,
			operatorAuthority: isLifecycleOverrideAuthority(context),
		});

		// 4. Disposer separation: operator, or a tedi that is NOT the
		//    skill's authoring identity. Re-asserted inside
		//    crystallizeMuscleFromSkill (two-layer gate).
		const authority = skillProposalApplyAuthority(
			context,
			skill,
			"muscle.crystallize",
		);

		try {
			const entry = await crystallizeMuscleFromSkill(context.db, {
				tediId,
				organizationId: orgId,
				skillId: input.skillId,
				kind: input.kind,
				name: input.name,
				description: input.description,
				r2Path: input.r2Path,
				codeModule: input.codeModule,
				allowedNamespaces: input.allowedNamespaces,
				authority,
				...(premortemGate.auditLine
					? {
							revisionReasoning: appendRevisionReasoning(
								skill,
								premortemGate.auditLine,
							),
						}
					: {}),
			});
			return { entry };
		} catch (error) {
			if (error instanceof SkillLifecycleTransitionError) {
				throw createError(ErrorCodes.BAD_REQUEST, error.message, {
					code: error.code,
					...error.details,
				});
			}
			throw error;
		}
	});

export const muscleUsage = authedMuscle.usage
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		// Org-scoped load first: a foreign-org muscle id is a 404, never a
		// counter write. recordMuscleUsage re-scopes its WHERE as the backstop.
		const orgId = requireOrgId(context);
		const muscle = await getMuscleMemoryById(context.db, input.id, orgId);
		if (!muscle) {
			throw createError(ErrorCodes.NOT_FOUND, "Muscle memory entry not found");
		}
		const updated = await recordMuscleUsage(
			context.db,
			input.id,
			input.success,
			orgId,
		);
		// A muscle invocation derived from a skill is a skill execution — stamp
		// the canonical skill usage ledger so crystallized skills keep real
		// selection signals after they compress into muscle memory.
		if (updated?.sourceSkillId) {
			await recordSkillUsageEvent(context.db, {
				organizationId: updated.organizationId,
				tediId: updated.tediId,
				skillId: updated.sourceSkillId,
				source: "muscle_memory",
				success: input.success,
			});
		}
		return { success: true };
	});
