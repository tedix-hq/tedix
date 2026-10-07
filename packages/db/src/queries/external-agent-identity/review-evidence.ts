import { and, eq } from "drizzle-orm";
import { areSameWorkParty } from "./canonical-party";
import type { DbClient } from "../../client";
import {
	type ExternalAgentReviewEvidence,
	externalAgentReviewEvidence,
} from "../../schema/external-agent-identity";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { ExternalAgentIdentityError } from "./principals";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

type ExternalReviewContext = {
	taskFamily: string;
	repositoryKey: string;
	repositoryVersion: string;
	riskLevel: "low" | "medium" | "high" | "critical";
	environment: string;
};

export async function recordExternalAgentReviewEvidence(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		executionAttributionId: string;
		reviewerPrincipalType: "user" | "certification_service" | "external_agent";
		reviewerPrincipalId: string;
		reviewerSessionId?: string;
		context: ExternalReviewContext;
		outcome: "success" | "partial" | "failure" | "policy_violation";
		score: number;
		policyViolationSeverity: number;
		reviewMethod: string;
		evidenceRefs: string[];
		occurredAt: string;
	},
): Promise<ExternalAgentReviewEvidence> {
	const executionRow = await db.query.externalAgentAttributions.findFirst({
		columns: {
			id: true,
			principalId: true,
			sessionId: true,
			targetType: true,
			targetId: true,
			workItemId: true,
			metadata: true,
		},
		where: {
			id: input.executionAttributionId,
			organizationId: input.organizationId,
			role: "executor",
		},
		with: {
			session: {
				columns: {
					creditEligible: true,
					harness: true,
					harnessVersion: true,
					modelProvider: true,
					modelId: true,
					modelVersion: true,
				},
			},
		},
	});
	if (!executionRow?.session) {
		throw new ExternalAgentIdentityError(
			"review_not_found",
			"Reviewed external-agent execution attribution was not found",
		);
	}
	const execution = {
		executionAttributionId: executionRow.id,
		subjectPrincipalId: executionRow.principalId,
		subjectSessionId: executionRow.sessionId,
		targetType: executionRow.targetType,
		targetId: executionRow.targetId,
		workItemId: executionRow.workItemId,
		executionMetadata: executionRow.metadata,
		...executionRow.session,
	};
	if (!execution.creditEligible) {
		throw new ExternalAgentIdentityError(
			"review_conflict",
			"Executions from derived external-agent sessions cannot earn review credit",
		);
	}
	const immutableContext = execution.executionMetadata.reputationContext;
	const certification = execution.executionMetadata.provenanceCertification;
	const certificationSource =
		certification &&
		typeof certification === "object" &&
		!Array.isArray(certification) &&
		"source" in certification
			? (certification as { source?: unknown }).source
			: undefined;
	// `git_tie` is accepted only for the immutable attribution rows the retired
	// Git-tie certifier wrote; nothing writes it anymore.
	if (
		certificationSource !== "mcp_gateway" &&
		certificationSource !== "work_item_attempt" &&
		certificationSource !== "git_tie"
	) {
		throw new ExternalAgentIdentityError(
			"review_conflict",
			"Only Tedix-certified gateway or Work Item attempt executions (or historical Git-tie records) can earn reputation",
		);
	}
	if (
		!immutableContext ||
		typeof immutableContext !== "object" ||
		Array.isArray(immutableContext) ||
		stableJson(immutableContext) !== stableJson(input.context)
	) {
		throw new ExternalAgentIdentityError(
			"review_conflict",
			"Review context must exactly match the immutable execution reputation context",
		);
	}
	if (input.reviewerPrincipalType === "external_agent") {
		if (
			input.reviewerPrincipalId === execution.subjectPrincipalId ||
			!input.reviewerSessionId
		) {
			throw new ExternalAgentIdentityError(
				"review_conflict",
				"An external-agent principal cannot review its own execution",
			);
		}
		const reviewer = await db.query.externalAgentSessions.findFirst({
			columns: { creditEligible: true },
			where: {
				organizationId: input.organizationId,
				principalId: input.reviewerPrincipalId,
				id: input.reviewerSessionId,
				status: "active",
				principal: { status: "active" },
			},
		});
		if (!reviewer?.creditEligible) {
			throw new ExternalAgentIdentityError(
				"review_conflict",
				"External-agent reviewer session is inactive, derived, or ineligible",
			);
		}
	} else if (input.reviewerSessionId) {
		throw new ExternalAgentIdentityError(
			"review_conflict",
			"Only external-agent reviewers may carry a reviewer session",
		);
	}

	if (
		await areSameWorkParty(db, {
			organizationId: input.organizationId,
			left: {
				type: input.reviewerPrincipalType,
				id: input.reviewerPrincipalId,
			},
			right: { type: "external_agent", id: execution.subjectPrincipalId },
		})
	) {
		throw new ExternalAgentIdentityError(
			"review_conflict",
			"A reviewer cannot review an execution by its own party (owner-host agents share their owner's party)",
		);
	}
	const targetType = execution.workItemId
		? ("work_item" as const)
		: execution.targetType === "commit"
			? ("commit" as const)
			: ("mcp_execution" as const);
	const targetId = execution.workItemId ?? execution.targetId;
	const contextHash = `sha256:${await sha256Hex(
		stableJson({
			...input.context,
			harness: execution.harness,
			harnessVersion: execution.harnessVersion,
			modelProvider: execution.modelProvider,
			modelId: execution.modelId,
			modelVersion: execution.modelVersion,
		}),
	)}`;
	const inserted = await db
		.insert(externalAgentReviewEvidence)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			executionAttributionId: execution.executionAttributionId,
			subjectPrincipalId: execution.subjectPrincipalId,
			subjectSessionId: execution.subjectSessionId,
			reviewerPrincipalType: input.reviewerPrincipalType,
			reviewerPrincipalId: input.reviewerPrincipalId,
			reviewerSessionId: input.reviewerSessionId ?? null,
			targetType,
			targetId,
			workItemId: execution.workItemId,
			...input.context,
			outcome: input.outcome,
			score: input.score,
			policyViolationSeverity: input.policyViolationSeverity,
			reviewMethod: input.reviewMethod,
			evidenceRefs: input.evidenceRefs,
			contextHash,
			resolutionStatus: "open",
			occurredAt: input.occurredAt,
			createdAt: input.occurredAt,
		})
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return inserted[0];
	const rows = await db
		.select()
		.from(externalAgentReviewEvidence)
		.where(
			and(
				eq(externalAgentReviewEvidence.organizationId, input.organizationId),
				eq(
					externalAgentReviewEvidence.executionAttributionId,
					input.executionAttributionId,
				),
				eq(
					externalAgentReviewEvidence.reviewerPrincipalType,
					input.reviewerPrincipalType,
				),
				eq(
					externalAgentReviewEvidence.reviewerPrincipalId,
					input.reviewerPrincipalId,
				),
			),
		)
		.limit(1);
	const existing = rows[0];
	if (
		existing &&
		existing.contextHash === contextHash &&
		existing.reviewerSessionId === (input.reviewerSessionId ?? null) &&
		existing.outcome === input.outcome &&
		existing.score === input.score &&
		existing.policyViolationSeverity === input.policyViolationSeverity &&
		existing.reviewMethod === input.reviewMethod &&
		stableJson(existing.evidenceRefs) === stableJson(input.evidenceRefs)
	) {
		return existing;
	}
	throw new ExternalAgentIdentityError(
		"review_conflict",
		"Reviewer principal already recorded different evidence for this execution",
	);
}

export async function remediateExternalAgentReviewEvidence(
	db: DbClient,
	input: {
		organizationId: string;
		reviewId: string;
		evidenceRef: string;
		resolvedByType: "user" | "api_key";
		resolvedById: string;
		resolvedAt: string;
	},
): Promise<ExternalAgentReviewEvidence> {
	const rows = await db
		.update(externalAgentReviewEvidence)
		.set({
			resolutionStatus: "remediated",
			resolutionEvidenceRef: input.evidenceRef,
			resolvedByType: input.resolvedByType,
			resolvedById: input.resolvedById,
			resolvedAt: input.resolvedAt,
		})
		.where(
			and(
				eq(externalAgentReviewEvidence.organizationId, input.organizationId),
				eq(externalAgentReviewEvidence.id, input.reviewId),
				eq(externalAgentReviewEvidence.resolutionStatus, "open"),
			),
		)
		.returning();
	if (rows[0]) return rows[0];
	const existing = await db
		.select()
		.from(externalAgentReviewEvidence)
		.where(
			and(
				eq(externalAgentReviewEvidence.organizationId, input.organizationId),
				eq(externalAgentReviewEvidence.id, input.reviewId),
			),
		)
		.limit(1);
	if (
		existing[0]?.resolutionStatus === "remediated" &&
		existing[0].resolutionEvidenceRef === input.evidenceRef &&
		existing[0].resolvedByType === input.resolvedByType &&
		existing[0].resolvedById === input.resolvedById
	) {
		return existing[0];
	}
	throw new ExternalAgentIdentityError(
		existing[0] ? "review_conflict" : "review_not_found",
		existing[0]
			? "Review evidence was already resolved differently"
			: "External-agent review evidence was not found",
	);
}
