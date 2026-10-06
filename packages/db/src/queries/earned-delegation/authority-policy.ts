import type {
	EntrustmentLevel,
	EntrustmentScope,
	EvidencePolicy,
	TediCareerStage,
} from "@tedix/api-contract/schemas/earned-delegation";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	earnedDelegationEvidenceRevisions,
	type entrustableActivities,
	type tediEntrustmentGrants,
} from "../../schema/earned-delegation";
import { tedis } from "../../schema/tedis";
import { sha256Hex } from "@tedix/worker-kit/crypto";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type DelegationActorType =
	| "user"
	| "tedi"
	| "service"
	| "api_key"
	| "external_agent";
export type DecisionKind =
	| "promote"
	| "demote"
	| "grant"
	| "raise"
	| "restrict"
	| "revoke"
	| "recertify"
	| "reinstate"
	| "role_change";
export type EntrustmentStatus = "active" | "restricted" | "expired" | "revoked";

export class EarnedDelegationError extends Error {
	constructor(
		readonly reason:
			| "not_found"
			| "out_of_scope"
			| "conflict"
			| "ineligible"
			| "invalid_transition"
			| "untrusted_authority"
			| "expired",
		message: string,
	) {
		super(message);
		this.name = "EarnedDelegationError";
	}
}

export const CAREER_POLICY: EvidencePolicy = {
	minimumVerifiedObservations: 5,
	minimumDistinctVerifierPrincipals: 2,
	maximumFailureRate: 0.2,
	maximumPolicyViolationSeverity: 0,
	maximumEvidenceAgeDays: 90,
	requireNonTrivialWork: true,
	minimumReliabilityLowerBound: 0.5,
	minimumMeanComplexity: 0.25,
	minimumTaskFamilies: 2,
	minimumCalibrationScore: 0.7,
	minimumEscalationQuality: 0.7,
	requireLearningTransfer: false,
};

export const CAREER_STAGES: readonly TediCareerStage[] = [
	"shadow",
	"apprentice",
	"operator",
	"specialist",
	"lead",
	"executive",
];
export const ENTRUSTMENT_LEVEL_ORDER: readonly EntrustmentLevel[] = [
	"observe",
	"recommend",
	"execute_preapproved",
	"execute_reviewed",
	"autonomous",
	"delegate",
];

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}

export async function hashSnapshot(value: unknown): Promise<string> {
	return `sha256:${await sha256Hex(stableJson(value))}`;
}

export function effectiveGrantStatus(
	grant: typeof tediEntrustmentGrants.$inferSelect,
	now: string,
): EntrustmentStatus {
	return grant.status === "active" && grant.expiresAt && grant.expiresAt <= now
		? "expired"
		: grant.status;
}

export function assertScopeWithinActivity(
	scope: EntrustmentScope,
	activity: typeof entrustableActivities.$inferSelect,
): void {
	const fit = scopeFitsActivityDefinition(scope, {
		actionPatterns: activity.actionPatterns,
		toolIds: activity.toolIds,
	});
	if (!fit.actions) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Requested actions exceed the evaluated activity scope",
		);
	}
	if (!fit.tools) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Requested tools exceed the evaluated activity scope",
		);
	}
}

export function scopeFitsActivityDefinition(
	scope: EntrustmentScope,
	activity: { actionPatterns: string[]; toolIds: string[] },
): { actions: boolean; tools: boolean } {
	const allowedActions = new Set(activity.actionPatterns);
	const allowedTools = new Set(activity.toolIds);
	return {
		actions: scope.actions.every((action) => allowedActions.has(action)),
		tools: scope.toolIds.every((toolId) => allowedTools.has(toolId)),
	};
}

export async function requireScopedTedi(
	db: DbClient,
	organizationId: string,
	tediId: string,
): Promise<void> {
	const rows = await db
		.select({ id: tedis.id })
		.from(tedis)
		.where(and(eq(tedis.id, tediId), eq(tedis.organizationId, organizationId)))
		.limit(1);
	if (!rows[0]) {
		throw new EarnedDelegationError(
			"out_of_scope",
			"Tedi is not in the requested organization",
		);
	}
}

export function advanceEvidenceRevision(
	db: DbClient,
	input: { organizationId: string; tediId: string; now: string },
) {
	return db
		.insert(earnedDelegationEvidenceRevisions)
		.values({
			organizationId: input.organizationId,
			tediId: input.tediId,
			revision: 1,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: [
				earnedDelegationEvidenceRevisions.organizationId,
				earnedDelegationEvidenceRevisions.tediId,
			],
			set: {
				revision: sql`${earnedDelegationEvidenceRevisions.revision} + 1`,
				updatedAt: input.now,
			},
		});
}

export async function readEvidenceRevision(
	db: DbClient,
	input: { organizationId: string; tediId: string },
): Promise<number> {
	const rows = await db
		.select({ revision: earnedDelegationEvidenceRevisions.revision })
		.from(earnedDelegationEvidenceRevisions)
		.where(
			and(
				eq(
					earnedDelegationEvidenceRevisions.organizationId,
					input.organizationId,
				),
				eq(earnedDelegationEvidenceRevisions.tediId, input.tediId),
			),
		)
		.limit(1);
	return rows[0]?.revision ?? 0;
}
