import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ExternalAgentAttributionSchema,
	ExternalAgentContextualReputationSchema,
	ExternalAgentGovernedCredentialBindingTypeSchema,
	ExternalAgentKnowledgeCheckpointSchema,
	ExternalAgentKnowledgeDispositionSchema,
	ExternalAgentPrincipalSchema,
	ExternalAgentPrincipalStatusSchema,
	ExternalAgentReputationContextSchema,
	ExternalAgentReviewAssessmentSchema,
	ExternalAgentReviewContextSchema,
	ExternalAgentReviewEvidenceSchema,
	ExternalAgentSessionSchema,
} from "../schemas/external-agent-identity";

const JsonRecordSchema = z.record(z.string(), z.unknown());
const OrganizationIdSchema = z.uuid().optional();
export const EXTERNAL_AGENT_SCOPE_LIMIT = 64;
const ExternalAgentScopesSchema = z
	.array(z.string().min(1).max(160))
	.min(1)
	.max(EXTERNAL_AGENT_SCOPE_LIMIT);

export const EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER =
	"mcp-edge-external-agent-session-exchange";
export const EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER =
	"mcp-edge-external-agent-workload-exchange";

export const ExternalAgentSessionExchangeInputSchema = z
	.object({
		organizationId: z.uuid(),
		principalId: z.uuid(),
		externalSessionKey: z.string().min(1).max(300),
		harness: z.string().min(1).max(120),
		harnessVersion: z.string().min(1).max(120),
		modelProvider: z.string().min(1).max(120),
		modelId: z.string().min(1).max(200),
		modelVersion: z.string().min(1).max(200),
		metadata: JsonRecordSchema.optional(),
		scopes: ExternalAgentScopesSchema,
		mcpServerUrl: z.url(),
		clientName: z.string().min(1).max(200).optional(),
	})
	.strict();

export const ExternalAgentSessionExchangeOutputSchema = z.object({
	session: ExternalAgentSessionSchema,
	credential: z.object({
		accessToken: z.string().min(1),
		clientRecordId: z.string().min(1),
		expiresIn: z.number().int().positive(),
		mcpServerUrl: z.url(),
	}),
});

/** Trusted MCP-edge header carrying a per-call owner-host Agent-Session id. */
export const OWNER_HOST_SESSION_HEADER = "X-Tedix-Auth-Owner-Host-Session-Id";

const OwnerHostHarnessSchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "harness must be a plain token");

export const OpenOwnerHostSessionInputSchema = z
	.object({
		harness: OwnerHostHarnessSchema,
		externalSessionKey: z
			.string()
			.min(3)
			.max(300)
			.regex(
				/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9._:-]+$/,
				"externalSessionKey must be <harness>:<id>",
			)
			.optional()
			.describe(
				"Stable host session key in <harness>:<id> form. Omit to mint a fresh session; reuse it only with the identical harness/model tuple.",
			),
		harnessVersion: z.string().min(1).max(120),
		modelProvider: z.string().min(1).max(120),
		modelId: z.string().min(1).max(200),
		modelVersion: z.string().min(1).max(200),
	})
	.strict();

export const OwnerHostSessionPrincipalSchema =
	ExternalAgentPrincipalSchema.pick({ id: true, key: true, displayName: true });

export const OpenOwnerHostSessionOutputSchema = z.object({
	session: ExternalAgentSessionSchema,
	principal: OwnerHostSessionPrincipalSchema,
});

export type OpenOwnerHostSessionInput = z.infer<
	typeof OpenOwnerHostSessionInputSchema
>;
export type OpenOwnerHostSessionOutput = z.infer<
	typeof OpenOwnerHostSessionOutputSchema
>;

export type ExternalAgentSessionExchangeInput = z.infer<
	typeof ExternalAgentSessionExchangeInputSchema
>;
export type ExternalAgentSessionExchangeOutput = z.infer<
	typeof ExternalAgentSessionExchangeOutputSchema
>;

export const externalAgentIdentityContract = oc
	.route({ tags: ["external-agent-identity"], prefix: "/external-agents" })
	.errors(baseErrors)
	.router({
		createPrincipal: oc
			.route({
				method: "POST",
				path: "/principals",
				summary: "Create a stable credential-bound external-agent principal",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					key: z.string().min(1).max(120),
					displayName: z.string().min(1).max(200),
					credentialBindingType:
						ExternalAgentGovernedCredentialBindingTypeSchema,
					credentialBindingId: z.string().min(1).max(200),
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(ExternalAgentPrincipalSchema),

		setPrincipalStatus: oc
			.route({
				method: "PATCH",
				path: "/principals/{principalId}/status",
				summary: "Suspend, retire, or reactivate an external-agent principal",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					status: ExternalAgentPrincipalStatusSchema,
				}),
			)
			.output(ExternalAgentPrincipalSchema),

		renamePrincipal: oc
			.route({
				method: "PATCH",
				path: "/principals/{principalId}/display-name",
				summary: "Rename an external-agent principal",
				description:
					"Changes only the display name. The key stays fixed because commit provenance and stored sessions refer to it.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					displayName: z.string().trim().min(1).max(200),
				}),
			)
			.output(ExternalAgentPrincipalSchema),

		openSession: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions",
				summary: "Open an immutable external Agent-Session",
				description:
					"The authenticated API key must be the principal's binding. Provenance is assigned by the server; reusing a session key with a changed tuple fails.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					externalSessionKey: z.string().min(1).max(300),
					harness: z.string().min(1).max(120),
					harnessVersion: z.string().min(1).max(120),
					modelProvider: z.string().min(1).max(120),
					modelId: z.string().min(1).max(200),
					modelVersion: z.string().min(1).max(200),
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(ExternalAgentSessionSchema),

		openOwnerHostSession: oc
			.route({
				method: "POST",
				path: "/owner-host-sessions",
				summary:
					"Start an owner-bound Agent-Session for the calling plugin host",
				description:
					"For MCP-only hosts that authenticate as their human owner. The caller's own owner_user principal in the current organization is created on first use; the session is owner-asserted, never credit eligible, and never counts as independent review. Pass the returned session id as the Code Mode agentSessionId argument so Work admission attributes those calls to this session. No credential is issued.",
				successStatus: 201,
			})
			.input(OpenOwnerHostSessionInputSchema)
			.output(OpenOwnerHostSessionOutputSchema),

		resolveOwnerHostSession: oc
			.route({
				method: "POST",
				path: "/internal/owner-host-session",
				summary:
					"Resolve the caller's active owner-host Agent-Session for a trusted edge",
			})
			.input(z.object({ sessionId: z.uuid() }).strict())
			.output(OpenOwnerHostSessionOutputSchema),

		authorizeWorkloadSession: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/workload-sessions",
				summary:
					"Verify and consume a federated workload assertion before session issuance",
			})
			.input(
				z
					.object({
						organizationId: z.uuid(),
						principalId: z.uuid(),
						subjectToken: z.string().min(1),
						externalSessionKey: z.string().min(1).max(300),
						harness: z.string().min(1).max(120),
						harnessVersion: z.string().min(1).max(120),
						modelProvider: z.string().min(1).max(120),
						modelId: z.string().min(1).max(200),
						modelVersion: z.string().min(1).max(200),
						metadata: JsonRecordSchema.optional().describe(
							"Optional harness context persisted for audit; it grants no identity, tenant, or scope authority",
						),
						scopes: ExternalAgentScopesSchema,
					})
					.strict(),
			)
			.output(
				z.object({
					session: ExternalAgentSessionSchema,
					grantToken: z.string().min(1),
				}),
			),

		heartbeatSession: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/heartbeat",
				summary: "Heartbeat a credential-bound external Agent-Session",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
				}),
			)
			.output(ExternalAgentSessionSchema),

		recordKnowledgeCheckpoint: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/knowledge/checkpoints",
				summary: "Record a bounded knowledge checkpoint receipt",
				description:
					"The full packet remains in the Work Item or artifact store; the session keeps a compact provenance receipt.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					idempotencyKey: z.string().trim().min(1).max(200),
					workItemId: z.uuid(),
					summary: z.string().trim().min(1).max(2_000),
					evidenceRefs: z
						.array(z.string().trim().min(1).max(2_000))
						.max(50)
						.default([]),
					artifactRef: z.string().trim().min(1).max(2_000).optional(),
				}),
			)
			.output(ExternalAgentKnowledgeCheckpointSchema),

		recordKnowledgeDisposition: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/knowledge/disposition",
				summary: "Finalize a session's immutable knowledge disposition",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					type: z.literal("no_handoff"),
					idempotencyKey: z.string().trim().min(1).max(200),
					workItemId: z.uuid(),
					reason: z.string().trim().min(1).max(2_000),
				}),
			)
			.output(ExternalAgentKnowledgeDispositionSchema),

		endSession: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/end",
				summary: "End an external Agent-Session permanently",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					zeroWorkDisposition: z
						.object({
							idempotencyKey: z.string().trim().min(1).max(200),
							reason: z.string().trim().min(1).max(2_000),
						})
						.optional(),
				}),
			)
			.output(ExternalAgentSessionSchema),

		retireAbandonedSession: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/retire-abandoned",
				summary:
					"Owner-admin retirement of an abandoned external Agent-Session",
				description:
					"Tenant-scoped governance recovery for a session whose credential holder can no longer perform self-teardown. Sessions with Work history require an explicit no-handoff disposition.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					reason: z.string().trim().min(1).max(2_000),
					workDisposition: z
						.object({
							type: z.literal("no_handoff"),
							idempotencyKey: z.string().trim().min(1).max(200),
							workItemId: z.uuid(),
							reason: z.string().trim().min(1).max(2_000),
						})
						.optional()
						.describe(
							"Required when the abandoned session has Work Item history; omitted only for a verified zero-work retirement.",
						),
				}),
			)
			.output(
				z.object({
					session: ExternalAgentSessionSchema,
					revokedCredentialCount: z.number().int().nonnegative(),
				}),
			),

		resolveSessionAuth: oc
			.route({
				method: "POST",
				path: "/internal/session-auth",
				summary: "Resolve an active external-agent session for a trusted edge",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					principalId: z.uuid(),
					sessionId: z.uuid(),
					clientRecordId: z.string().min(1).max(300),
				}),
			)
			.output(
				z.object({
					principal: ExternalAgentPrincipalSchema,
					session: ExternalAgentSessionSchema,
				}),
			),

		recordVerifiedMcpExecution: oc
			.route({
				method: "POST",
				path: "/internal/mcp-execution",
				summary: "Record a gateway-verified external-agent MCP execution",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					principalId: z.uuid(),
					sessionId: z.uuid(),
					clientRecordId: z.string().min(1).max(300),
					targetId: z.string().min(1).max(500),
					occurredAt: z.iso.datetime(),
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(ExternalAgentAttributionSchema),

		issueMcpCredential: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/mcp-credential",
				summary: "Issue a short-lived MCP credential for an active session",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					scopes: ExternalAgentScopesSchema,
					mcpServerUrl: z.url(),
					clientName: z.string().min(1).max(200).optional(),
				}),
			)
			.output(
				z.object({
					accessToken: z.string().min(1),
					clientRecordId: z.string().min(1),
					expiresIn: z.number().int().positive(),
					mcpServerUrl: z.url(),
				}),
			),

		revokeMcpCredential: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/mcp-credential/revoke",
				summary: "Revoke an MCP credential issued for this session",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					clientRecordId: z.string().min(1).max(300),
				}),
			)
			.output(z.object({ success: z.literal(true) })),

		recordAttribution: oc
			.route({
				method: "POST",
				path: "/principals/{principalId}/sessions/{sessionId}/attributions",
				summary: "Attach an execution or commit",
				description:
					"A bound external-agent principal may attach only its own audit attribution. Self-attached records are never reputation eligible; only gateway or canonical checkout certified executions (plus historical Git-tie records) can enter contextual reputation. Independent review evidence uses the dedicated review ledger.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					sessionId: z.uuid(),
					targetType: z.enum([
						"work_item_attempt",
						"work_item_event",
						"mcp_execution",
						"commit",
					]),
					targetId: z.string().min(1).max(500),
					role: z.literal("executor"),
					workItemId: z.uuid().optional(),
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(ExternalAgentAttributionSchema),

		recordReview: oc
			.route({
				method: "POST",
				path: "/reviews",
				summary: "Record independent external-agent outcome evidence",
				description:
					"Reviewer identity is derived from authentication. External reviewers must supply their active immutable session and cannot review their own principal. Context is exact and never transfers across repository, risk, harness, or model versions.",
				successStatus: 201,
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdSchema,
						executionAttributionId: z.uuid(),
						reviewerSessionId: z.uuid().optional(),
					})
					.extend(ExternalAgentReviewContextSchema.shape)
					.and(ExternalAgentReviewAssessmentSchema),
			)
			.output(ExternalAgentReviewEvidenceSchema),

		remediateReview: oc
			.route({
				method: "POST",
				path: "/reviews/{reviewId}/remediate",
				summary: "Resolve negative external-agent review evidence",
				description:
					"Owner/admin governance action. Critical negatives never decay away; explicit remediation evidence is required to clear the blocker.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					reviewId: z.uuid(),
					evidenceRef: z.string().trim().min(1).max(2_000),
				}),
			)
			.output(ExternalAgentReviewEvidenceSchema),

		getContextualReputation: oc
			.route({
				method: "GET",
				path: "/principals/{subjectPrincipalId}/reputation",
				summary: "Compute exact-context external-agent reputation",
				description:
					"Read-only descriptive evidence with exponential decay, effective sample size, and a conservative reliability lower bound. This result never grants authority.",
			})
			.input(
				z
					.object({
						organizationId: OrganizationIdSchema,
						subjectPrincipalId: z.uuid(),
						halfLifeDays: z.number().positive().max(365).default(90),
					})
					.extend(ExternalAgentReputationContextSchema.shape),
			)
			.output(ExternalAgentContextualReputationSchema),

		listPrincipals: oc
			.route({
				method: "GET",
				path: "/principals",
				summary: "List external-agent principals",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					limit: z.number().int().min(1).max(500).default(100),
				}),
			)
			.output(z.array(ExternalAgentPrincipalSchema)),

		listSessions: oc
			.route({
				method: "GET",
				path: "/principals/{principalId}/sessions",
				summary: "List immutable sessions for an external-agent principal",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					principalId: z.uuid(),
					limit: z.number().int().min(1).max(500).default(100),
				}),
			)
			.output(z.array(ExternalAgentSessionSchema)),

		listStaleKnowledgeSessions: oc
			.route({
				method: "GET",
				path: "/sessions/stale-knowledge",
				summary: "List active sessions missing a final knowledge disposition",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					staleBefore: z.iso.datetime(),
					limit: z.number().int().min(1).max(500).default(100),
				}),
			)
			.output(z.array(ExternalAgentSessionSchema)),
	});

export type ExternalAgentIdentityContract =
	typeof externalAgentIdentityContract;
