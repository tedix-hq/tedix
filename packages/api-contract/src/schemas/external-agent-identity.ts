import * as z from "zod";
import { JsonValueSchema } from "./common";
import {
	MCP_CAPABILITY_SCOPES,
	MCP_GRANULAR_CAPABILITY_SCOPES,
} from "./mcp-capability-scopes";

const principalScopeCatalog = new Set<string>([
	...Object.keys(MCP_CAPABILITY_SCOPES),
	...Object.keys(MCP_GRANULAR_CAPABILITY_SCOPES),
	"connections.read",
	"connections.execute",
	"connections.admin",
	"platform:admin",
	"*",
]);

export const ExternalAgentPlatformSchema = z.enum([
	"claude-cloud",
	"codex-cloud",
	"devin-cloud",
	"other",
]);

export const ExternalAgentPrincipalMetadataSchema = z
	.object({
		platform: ExternalAgentPlatformSchema.optional(),
		representedUserId: z.string().trim().min(1).max(200).optional(),
		allowedScopes: z
			.array(
				z
					.string()
					.refine(
						(scope) => principalScopeCatalog.has(scope),
						"Unknown capability scope",
					),
			)
			.max(64)
			.optional(),
	})
	.catchall(JsonValueSchema)
	.superRefine((metadata, ctx) => {
		if (!metadata.platform) return;
		if (!metadata.allowedScopes)
			ctx.addIssue({
				code: "custom",
				path: ["allowedScopes"],
				message: "Cloud enrollment requires allowedScopes",
			});
		for (const scope of metadata.allowedScopes ?? []) {
			if (
				scope === "*" ||
				scope === "platform:admin" ||
				scope === "connections.admin" ||
				scope in MCP_CAPABILITY_SCOPES ||
				scope.startsWith("mcp:settings.") ||
				scope.startsWith("mcp:team.") ||
				scope.endsWith(".admin")
			)
				ctx.addIssue({
					code: "custom",
					path: ["allowedScopes"],
					message: `Cloud enrollment forbids ${scope}`,
				});
		}
	});

/** Undefined preserves legacy enrollment; malformed or missing cloud ceilings fail closed. */
export function externalAgentScopeCeiling(
	metadata: Record<string, unknown> | undefined,
): string[] | undefined {
	if (metadata?.platform === undefined && metadata?.allowedScopes === undefined)
		return undefined;
	const parsed = ExternalAgentPrincipalMetadataSchema.safeParse(metadata);
	if (!parsed.success)
		throw new Error("Invalid external-agent allowedScopes ceiling");
	return parsed.data.allowedScopes;
}

export const ExternalAgentPrincipalStatusSchema = z.enum([
	"active",
	"suspended",
	"retired",
]);
export const ExternalAgentCredentialBindingTypeSchema = z.enum([
	"api_key",
	"github_actions_oidc",
	// Owner-asserted plugin-host identity: bound to the canonical user id of the
	// human whose OAuth session the host uses. Only openOwnerHostSession creates
	// these principals, and their sessions are never credit eligible.
	"owner_user",
]);
/** Binding types an owner/admin may create directly through createPrincipal. */
export const ExternalAgentGovernedCredentialBindingTypeSchema = z.enum([
	"api_key",
	"github_actions_oidc",
]);
export const ExternalAgentIdentitySourceSchema = z.enum([
	"native",
	"explicit",
	"derived",
]);
export const ExternalAgentKnowledgeDomainSchema = z.enum([
	"engineering",
	"architecture",
	"platform",
	"security",
	"product",
	"design",
	"marketing",
	"growth",
	"content",
	"finance",
	"billing",
	"operations",
	"strategy",
	"cross_domain",
]);

export const ExternalAgentKnowledgeCheckpointSchema = z.object({
	idempotencyKey: z.string().min(1).max(200),
	workItemId: z.uuid(),
	summary: z.string().trim().min(1).max(2_000),
	evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).max(50),
	artifactRef: z.string().trim().min(1).max(2_000).nullable(),
	recordedAt: z.string(),
});

export const ExternalAgentKnowledgeDispositionSchema = z.discriminatedUnion(
	"type",
	[
		z.object({
			type: z.literal("handoff"),
			idempotencyKey: z.string().min(1).max(200),
			workItemId: z.uuid(),
			handoffId: z.string().min(1).max(700),
			reviewWorkItemId: z.uuid(),
			stewardTediId: z.uuid(),
			recordedAt: z.string(),
		}),
		z.object({
			type: z.literal("no_handoff"),
			idempotencyKey: z.string().min(1).max(200),
			workItemId: z.uuid(),
			reason: z.string().trim().min(1).max(2_000),
			recordedAt: z.string(),
		}),
		z.object({
			type: z.literal("zero_work"),
			idempotencyKey: z.string().min(1).max(200),
			reason: z.string().trim().min(1).max(2_000),
			recordedAt: z.string(),
		}),
	],
);

export const ExternalAgentPrincipalSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	key: z.string().min(1).max(120),
	displayName: z.string().min(1).max(200),
	status: ExternalAgentPrincipalStatusSchema,
	credentialBindingType: ExternalAgentCredentialBindingTypeSchema,
	credentialBindingId: z.string().min(1).max(200),
	createdByType: z.enum(["user", "api_key", "platform"]),
	createdById: z.string().min(1).max(200),
	metadata: z.record(z.string(), JsonValueSchema),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const ExternalAgentPrincipalSummarySchema =
	ExternalAgentPrincipalSchema.extend({
		platform: ExternalAgentPlatformSchema.nullable(),
		representedUserId: z.string().nullable(),
		allowedScopes: z.array(z.string()).nullable(),
		expiresAt: z.string().nullable(),
		lastSeenAt: z.string().nullable(),
	});

export const ExternalAgentSessionSchema = z
	.object({
		id: z.uuid(),
		organizationId: z.uuid(),
		principalId: z.uuid(),
		externalSessionKey: z.string().min(1).max(300),
		harness: z.string().min(1).max(120),
		harnessVersion: z.string().min(1).max(120),
		modelProvider: z.string().min(1).max(120),
		modelId: z.string().min(1).max(200),
		modelVersion: z.string().min(1).max(200),
		identitySource: ExternalAgentIdentitySourceSchema,
		status: z.enum(["active", "ended"]),
		creditEligible: z.boolean(),
		startedAt: z.string(),
		lastSeenAt: z.string(),
		endedAt: z.string().nullable(),
		metadata: z.record(z.string(), JsonValueSchema),
	})
	.superRefine((session, ctx) => {
		if (session.identitySource === "derived" && session.creditEligible) {
			ctx.addIssue({
				code: "custom",
				message: "Derived Agent-Sessions cannot be credit eligible",
				path: ["creditEligible"],
			});
		}
		if ((session.status === "ended") !== Boolean(session.endedAt)) {
			ctx.addIssue({
				code: "custom",
				message: "Only ended sessions carry endedAt",
				path: ["endedAt"],
			});
		}
	});

export const ExternalAgentAttributionSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	principalId: z.uuid(),
	sessionId: z.uuid(),
	targetType: z.enum([
		"work_item_attempt",
		"work_item_event",
		"mcp_execution",
		"review",
		"commit",
	]),
	targetId: z.string().min(1).max(500),
	role: z.enum(["executor", "reviewer", "attester"]),
	workItemId: z.uuid().nullable(),
	metadata: z.record(z.string(), JsonValueSchema),
	occurredAt: z.string(),
});

export const ExternalAgentReviewContextSchema = z.object({
	taskFamily: z.string().trim().min(1).max(200),
	repositoryKey: z.string().trim().min(1).max(500),
	repositoryVersion: z.string().trim().min(1).max(200),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	environment: z.string().trim().min(1).max(120),
});

export const ExternalAgentReviewAssessmentSchema = z
	.object({
		outcome: z.enum(["success", "partial", "failure", "policy_violation"]),
		score: z.number().min(0).max(1),
		policyViolationSeverity: z.number().int().min(0).max(10).default(0),
		reviewMethod: z.string().trim().min(1).max(200),
		evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
	})
	.superRefine((review, ctx) => {
		if (review.outcome === "success" && review.score < 0.5) {
			ctx.addIssue({
				code: "custom",
				path: ["score"],
				message: "Successful reviews require score >= 0.5",
			});
		}
		if (
			(review.outcome === "failure" || review.outcome === "policy_violation") &&
			review.score > 0.5
		) {
			ctx.addIssue({
				code: "custom",
				path: ["score"],
				message: "Negative reviews require score <= 0.5",
			});
		}
		if (
			(review.outcome === "policy_violation") !==
			review.policyViolationSeverity > 0
		) {
			ctx.addIssue({
				code: "custom",
				path: ["policyViolationSeverity"],
				message:
					"Only policy_violation outcomes carry positive violation severity",
			});
		}
	});

export const ExternalAgentReviewEvidenceSchema =
	ExternalAgentReviewContextSchema.extend({
		id: z.uuid(),
		organizationId: z.uuid(),
		executionAttributionId: z.uuid(),
		subjectPrincipalId: z.uuid(),
		subjectSessionId: z.uuid(),
		reviewerPrincipalType: z.enum([
			"user",
			"certification_service",
			"external_agent",
		]),
		reviewerPrincipalId: z.string().min(1).max(300),
		reviewerSessionId: z.uuid().nullable(),
		targetType: z.enum(["work_item", "commit", "mcp_execution"]),
		targetId: z.string().min(1).max(500),
		workItemId: z.uuid().nullable(),
		outcome: z.enum(["success", "partial", "failure", "policy_violation"]),
		score: z.number().min(0).max(1),
		policyViolationSeverity: z.number().int().min(0).max(10),
		reviewMethod: z.string().min(1).max(200),
		evidenceRefs: z.array(z.string().min(1).max(2_000)).min(1).max(50),
		contextHash: z.string().min(1),
		resolutionStatus: z.enum(["open", "remediated"]),
		resolutionEvidenceRef: z.string().nullable(),
		resolvedByType: z.enum(["user", "api_key"]).nullable(),
		resolvedById: z.string().nullable(),
		resolvedAt: z.string().nullable(),
		occurredAt: z.string(),
		createdAt: z.string(),
	});

export const ExternalAgentReputationContextSchema =
	ExternalAgentReviewContextSchema.extend({
		harness: z.string().min(1).max(120),
		harnessVersion: z.string().min(1).max(120),
		modelProvider: z.string().min(1).max(120),
		modelId: z.string().min(1).max(200),
		modelVersion: z.string().min(1).max(200),
	});

export const ExternalAgentContextualReputationSchema = z.object({
	subjectPrincipalId: z.uuid(),
	context: ExternalAgentReputationContextSchema,
	halfLifeDays: z.number().positive(),
	rawReviewCount: z.number().int().nonnegative(),
	reviewedExecutions: z.number().int().nonnegative(),
	distinctReviewerPrincipals: z.number().int().nonnegative(),
	effectiveSampleSize: z.number().nonnegative(),
	weightedMeanScore: z.number().min(0).max(1),
	reliabilityLowerBound: z.number().min(0).max(1),
	criticalNegativeCount: z.number().int().nonnegative(),
	blockedByCriticalNegative: z.boolean(),
	mostRecentEvidenceAt: z.string().nullable(),
	status: z.enum(["insufficient", "fragile", "established"]),
	descriptiveOnly: z.literal(true),
});

export type ExternalAgentPrincipal = z.infer<
	typeof ExternalAgentPrincipalSchema
>;
export type ExternalAgentSession = z.infer<typeof ExternalAgentSessionSchema>;
export type ExternalAgentAttribution = z.infer<
	typeof ExternalAgentAttributionSchema
>;
export type ExternalAgentReviewEvidence = z.infer<
	typeof ExternalAgentReviewEvidenceSchema
>;
export type ExternalAgentContextualReputation = z.infer<
	typeof ExternalAgentContextualReputationSchema
>;
