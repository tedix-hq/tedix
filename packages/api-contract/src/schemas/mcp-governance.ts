/**
 * MCP tool-approval grant resolution — I/O schemas.
 *
 * Internal, service-binding-only endpoints that `apps/mcp` calls to verify
 * authorization at the tool dispatch boundary. `apps/mcp` has no general
 * `@tedix/db` access (see root `AGENTS.md`/`CLAUDE.md` MCP Platform
 * invariants), so this is the compliant path instead of a direct D1 query
 * from the MCP edge — mirrors `tedis.listRuntimeMetaBySlugs`.
 *
 * Durable tool grants remain separate from Home's write-proposal approvals.
 * The Home receipt verifier checks an already admitted exact call; it does
 * not create a tool grant or make a new policy decision.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

/** Exact Home write receipt, checked again at the MCP dispatch boundary. */
export const ResolveHomeToolApprovalInputSchema = z.object({
	organizationId: z.string().min(1),
	userId: z.string().min(1),
	appSlug: z.string().min(1),
	toolName: z.string().min(1),
	args: z.record(z.string(), JsonValueSchema),
	approvalRequestId: z.uuid(),
});
export const ResolveHomeToolApprovalResponseSchema = z.object({
	approved: z.boolean(),
});

export const ResolveSkillManifestAuthorizationInputSchema = z.object({
	organizationId: z.string().min(1),
	runId: z.string().min(1),
	skillId: z.string().min(1),
	tediId: z.string().min(1),
	executionEpoch: z.number().int().nonnegative(),
	method: z.string().min(1),
	namespace: z.string().optional(),
	sourceAppSlug: z.string().optional(),
	targetTediId: z.string().optional(),
});
export const ResolveSkillManifestAuthorizationResponseSchema = z.object({
	approved: z.boolean(),
	skillId: z.string().optional(),
	revision: z.number().int().positive().optional(),
});

export const McpToolApprovalGrantKindSchema = z.enum(["once", "always"]);
export type McpToolApprovalGrantKind = z.infer<
	typeof McpToolApprovalGrantKindSchema
>;

export const ResolveMcpToolApprovalGrantInputSchema = z.object({
	organizationId: z.string().min(1),
	/** Normalized caller actor id — see `normalizeCallerIdentity` in apps/mcp. */
	subjectId: z.string().min(1),
	appSlug: z.string().min(1),
	toolId: z.string().min(1),
	grantKind: McpToolApprovalGrantKindSchema,
});
export type ResolveMcpToolApprovalGrantInput = z.infer<
	typeof ResolveMcpToolApprovalGrantInputSchema
>;

export const ResolveMcpToolApprovalGrantResponseSchema = z.object({
	approved: z.boolean(),
	grantId: z.string().nullable(),
});
export type ResolveMcpToolApprovalGrantResponse = z.infer<
	typeof ResolveMcpToolApprovalGrantResponseSchema
>;

export const ResolveAgentTransportPolicyInputSchema = z.object({
	organizationId: z.string().min(1),
	tediId: z.string().min(1).optional(),
});
export const ResolveAgentTransportPolicyResponseSchema = z.object({
	requireExplicitApprovalPolicy: z.boolean(),
	autonomy: z
		.object({
			version: z.literal(1),
			maxRisk: z.literal("medium"),
			askForClasses: z.array(z.string()).optional(),
			policyPack: z
				.object({ id: z.string(), version: z.number().int().positive() })
				.optional(),
		})
		.optional(),
	/**
	 * `false` when the organization opted out of the platform-default autonomy
	 * (organization-autonomy.v1.json) or the caller's tedi is unknown.
	 */
	platformAutonomy: z.literal(false).optional(),
});

/**
 * Server-attributed owner/admin user authorization attached to the exact Work
 * Item a tedi owns.
 * The API additionally enforces authorship, active claim ownership, expiry,
 * and a maximum 30-day validity window from the server-stamped comment time.
 */
export const OwnedChannelAuthorizationReceiptSchema = z
	.object({
		version: z.literal(1),
		campaignKey: z.string().trim().min(1).max(128),
		channel: z.literal("tedix.dev/blog"),
		allowedAction: z.literal("content_publish"),
		contentRisk: z.literal("low"),
		collection: z.literal("posts"),
		/** Exact draft ids approved for this bounded campaign window. */
		contentIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
		validUntil: z.iso.datetime({ offset: true }),
	})
	.strict();
export type OwnedChannelAuthorizationReceipt = z.infer<
	typeof OwnedChannelAuthorizationReceiptSchema
>;

export const ResolveWorkItemAuthorizationInputSchema = z.object({
	organizationId: z.string().min(1),
	/** Normalized caller actor id — see `normalizeCallerIdentity` in apps/mcp. */
	subjectId: z.string().min(1),
	appSlug: z.string().min(1),
	toolId: z.string().min(1),
	args: z.record(z.string(), JsonValueSchema),
});
export type ResolveWorkItemAuthorizationInput = z.infer<
	typeof ResolveWorkItemAuthorizationInputSchema
>;

export const ResolveWorkItemAuthorizationResponseSchema = z.object({
	approved: z.boolean(),
	reason: z.string(),
	workItemId: z.string().nullable(),
	authorizationScopeWorkItemId: z.string().nullable(),
	authorizationCommentId: z.string().nullable(),
	attemptId: z.string().nullable(),
	campaignKey: z.string().nullable(),
	validUntil: z.string().nullable(),
});
export type ResolveWorkItemAuthorizationResponse = z.infer<
	typeof ResolveWorkItemAuthorizationResponseSchema
>;

export const AgentLifecycleEndpointSchema = z.enum([
	"workItems/addComment",
	"workItems/heartbeatAttempt",
	"workItems/settleAttempt",
	"externalAgentIdentity/recordKnowledgeCheckpoint",
	"osWorkspaces/outputs/create",
	"osWorkspaces/outputs/revise",
]);

export const ResolveAgentLifecycleAuthorizationInputSchema = z.object({
	organizationId: z.string().min(1),
	principalId: z.string().min(1),
	sessionId: z.string().min(1),
	endpoint: AgentLifecycleEndpointSchema,
	args: z.record(z.string(), JsonValueSchema),
});
export const ResolveAgentLifecycleAuthorizationResponseSchema = z.object({
	approved: z.boolean(),
});

/** Gateway-attested caller and resolved target; never a public tool input. */
export const RequestOwnerToolApprovalInputSchema = z.object({
	organizationId: z.string().min(1),
	userId: z.string().min(1),
	appSlug: z.string().min(1),
	toolId: z.string().min(1),
	target: z.record(z.string(), JsonValueSchema),
	args: z.record(z.string(), JsonValueSchema),
	approvalRequestId: z.uuid().optional(),
});
export const RequestOwnerToolApprovalResponseSchema = z.object({
	approved: z.boolean(),
	approvalRequestId: z.uuid(),
	status: z.string(),
	url: z.string().url(),
});

/**
 * A gateway call the platform-default autonomy approved, recorded as an
 * approved approval row (resolvedBy "policy") so Activity lists it with every
 * other automatic approval.
 */
export const RecordPolicyToolApprovalInputSchema = z.object({
	organizationId: z.string().min(1),
	appSlug: z.string().min(1),
	toolId: z.string().min(1),
	reason: z.string().min(1).max(300),
	operationId: z.string().min(1).max(80),
	userId: z.string().min(1).optional(),
	tediId: z.string().min(1).optional(),
	externalAgentPrincipalId: z.string().min(1).optional(),
});
export const RecordPolicyToolApprovalResponseSchema = z.object({
	approvalRequestId: z.uuid().nullable(),
});

/** Gateway-attested owner start of an existing skill; never a public tool input. */
export const ResolveOwnerSkillStartInputSchema = z
	.object({
		organizationId: z.string().min(1),
		userId: z.string().min(1),
		skillId: z.string().min(1).optional(),
		slug: z.string().min(1).optional(),
	})
	.refine((input) => Boolean(input.skillId || input.slug), {
		message: "skillId or slug is required",
	});
export const ResolveOwnerSkillStartResponseSchema = z.object({
	approved: z.boolean(),
	skillId: z.string().optional(),
	revision: z.number().int().positive().optional(),
});
