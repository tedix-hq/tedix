/**
 * oRPC Cognitive Stack Router — shared implementer instances and helpers.
 * Used by cognitive.ts and its extracted slices (knowledge, skill-runs,
 * muscle); keep this file dependency-free of the slice modules.
 */

import { implement } from "@orpc/server";
import {
	knowledgeContract,
	muscleContract,
	skillsContract,
} from "@tedix/api-contract/contracts/cognitive";
import { validateSkillSchedulePolicy } from "@tedix/api-contract/utils/skill-schedule";
import type { ForcedSkillPromotionAuthority } from "@tedix/db/queries/skill-lifecycle";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import { type BaseContext, createError, ErrorCodes, withAuth } from "../orpc";

export const knowledgeOs = implement(knowledgeContract).$context<BaseContext>();
export const skillsOs = implement(skillsContract).$context<BaseContext>();
export const muscleOs = implement(muscleContract).$context<BaseContext>();
export const authedKnowledge = knowledgeOs.use(withAuth);
export const authedSkills = skillsOs.use(withAuth);
export const authedMuscle = muscleOs.use(withAuth);

export async function sha256Digest(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return `sha256:${Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

export function appendRevisionReasoning(
	existing: SkillEntry,
	line: string,
): string {
	const previous = existing.revisionReasoning?.trim();
	return previous ? `${previous}\n${line}` : line;
}

/**
 * Execute-to-promote force override follows the capability-mutation-gate
 * allowlist doctrine: positively prove the caller is a signed-in human or an
 * operator-issued API key — the two caller types that structurally cannot be
 * an LLM's own in-turn tool selection — and reject every other authType
 * (tedi, m2m, service, service-binding, or unresolved). Fails closed.
 */
export function isLifecycleOverrideAuthority(
	context: Pick<BaseContext, "authType" | "user">,
): boolean {
	if (context.authType === "apikey") return true;
	return context.authType === "user" && Boolean(context.user?.sub);
}

/**
 * Disposer separation for `apply_skill_proposal` and `muscle.crystallize`:
 * the identity that proposes an evolution never approves it. Resolution order
 * (allowlist doctrine — every unproven identity fails closed):
 *
 * 1. A signed-in human or an operator-issued API key always passes.
 * 2. An agent caller with a resolved tedi identity (`context.tediId` — set on
 *    direct tedi JWTs AND on trusted service-binding calls forwarding
 *    `X-Tedix-Tedi-Id`, the only signal that downgrades service-binding trust)
 *    passes ONLY when it is not the proposal's authoring identity
 *    (`proposedByTediId`, falling back to the scoped `tediId` for older
 *    rows), AND the entry records an authoring identity at all — an
 *    authorless entry cannot prove disposer separation, so it fails closed.
 *    Cross-tedi apply remains scope-gated at the MCP edge
 *    (`apply_skill_proposal` → `mcp:skills`).
 * 3. Everything else (m2m, service, service-binding with no tedi identity,
 *    unresolved) is rejected — an anonymous machine credential cannot prove
 *    it is a different identity than the proposer.
 *
 * Returns the authority to forward to the db-layer backstop
 * (`assertForcedSkillPromotionAuthority`).
 */
export function skillProposalApplyAuthority(
	context: Pick<BaseContext, "authType" | "user" | "tediId">,
	proposal: Pick<SkillEntry, "tediId" | "proposedByTediId">,
	surface = "apply_skill_proposal",
): ForcedSkillPromotionAuthority {
	if (isLifecycleOverrideAuthority(context)) return { kind: "operator" };
	const callerTediId = context.tediId;
	if (!callerTediId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`${surface} requires a signed-in human, an operator API key, or an identified tedi caller; anonymous machine credentials (m2m/service) cannot approve skill promotions`,
		);
	}
	const authorIdentities = [proposal.proposedByTediId, proposal.tediId].filter(
		(id): id is string => Boolean(id),
	);
	if (authorIdentities.length === 0) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`${surface}: this entry records no proposing or owning tedi identity, so proposer≠approver separation cannot be proven — a signed-in human or operator API key must approve it (fails closed)`,
		);
	}
	if (authorIdentities.includes(callerTediId)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"the identity that proposed a skill evolution can never approve it: this proposal was authored by (or scoped to) the calling tedi — a different tedi with skills scope, a signed-in human, or an operator API key must apply it (disposer separation)",
		);
	}
	return { kind: "tedi", tediId: callerTediId };
}

/** Canonical string for a schedule policy so edits compare structurally. */
function canonicalSchedulePolicy(
	policy: {
		cron: string;
		params: Record<string, unknown>;
		enabled: boolean;
	} | null,
): string {
	if (!policy) return "null";
	const params = Object.entries(policy.params ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v) ?? "undefined"}`)
		.join(",");
	return `{cron:${JSON.stringify(policy.cron)},enabled:${policy.enabled},params:{${params}}}`;
}

/**
 * Did an edit change the effective `capabilities.schedule` policy? Compares the
 * PARSED policies (not text), so prose edits and formatting churn never trip
 * the owner gate. A doc whose schedule block fails validation parses to null
 * here; the improve path's own schedule validation still rejects it later.
 */
export function skillSchedulePolicyChanged(
	beforeDoc: string,
	afterDoc: string,
): boolean {
	const read = (doc: string) => {
		try {
			return validateSkillSchedulePolicy(doc).schedule;
		} catch {
			return null;
		}
	};
	return (
		canonicalSchedulePolicy(read(beforeDoc)) !==
		canonicalSchedulePolicy(read(afterDoc))
	);
}

/**
 * Owner-only guard for `capabilities.schedule` edits.
 *
 * A schedule block is execution authority: it decides what runs unattended, on
 * whose identity, with which params. A free-text agent turn must not be able
 * to disable scheduled skills it does not own without an attributable
 * record. Allowlist, fails closed:
 *
 * 1. A signed-in human or operator API key always passes.
 * 2. An agent caller with a resolved tedi identity passes ONLY when it IS the
 *    skill's owning tedi (for an ownerless skill being claimed attach-only in
 *    the same call, the incoming owner counts — the chicken-and-egg case).
 * 3. Everything else (a different tedi, m2m, service, unresolved) is rejected.
 */
export function assertScheduleEditAuthority(
	context: Pick<BaseContext, "authType" | "user" | "tediId">,
	entry: Pick<SkillEntry, "id"> & { owningTediId: string | null },
): void {
	if (isLifecycleOverrideAuthority(context)) return;
	if (
		context.tediId &&
		entry.owningTediId &&
		context.tediId === entry.owningTediId
	) {
		return;
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"SKILL_SCHEDULE_OWNER_ONLY: capabilities.schedule changes require the skill's owning tedi identity, a signed-in human, or an operator API key — a schedule decides what runs unattended, so no other caller may rewrite it",
		{
			code: "SKILL_SCHEDULE_OWNER_ONLY",
			skillId: entry.id,
			owningTediId: entry.owningTediId,
		},
	);
}
