/**
 * MCP tool-approval grant resolution — I/O schemas.
 *
 * Backs a single internal, service-binding-only endpoint that `apps/mcp`
 * calls to resolve (and, for a "once" grant, atomically consume) a durable
 * pre-authorization for a destructive `tools/call`. `apps/mcp` has no general
 * `@tedix/db` access (see root `AGENTS.md`/`CLAUDE.md` MCP Platform
 * invariants), so this is the compliant path instead of a direct D1 query
 * from the MCP edge — mirrors `tedis.listRuntimeMetaBySlugs`.
 *
 * This is a NEW, ISOLATED grant layer for the raw `tools/call` trust boundary
 * — NOT the kernel write-proposal approval system
 * (`decideKernelWriteApproval` in `packages/api-contract/src/utils/
 * approval-policy.ts`). Do not converge the two.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

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
	tediId: z.string().min(1),
});
export const ResolveAgentTransportPolicyResponseSchema = z.object({
	requireExplicitApprovalPolicy: z.boolean(),
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
