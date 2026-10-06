import "@orpc/openapi/extensions/route";
/**
 * Cognitive Runtime Contract
 * Lightweight route shapes for the runtime-neutral Tedix conversation protocol.
 */

import {
	RankDiscoveryInputSchema,
	RankDiscoveryOutputSchema,
	RankSkillsInputSchema,
	RankSkillsOutputSchema,
} from "../schemas/jev";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	AutomationEmitInputSchema,
	AutomationEmitOutputSchema,
} from "../schemas/automation-events";
import {
	ApproveInputSchema,
	CreateArtifactShareLinkInputSchema,
	CreateArtifactShareLinkOutputSchema,
	ApproveArtifactReleaseInputSchema,
	ArtifactReleaseReviewSchema,
	ArtifactReleaseDecisionOutputSchema,
	ArtifactReleaseSourcePreviewSchema,
	CreateRedactedArtifactRevisionInputSchema,
	GetArtifactReleaseReviewInputSchema,
	RevokeArtifactReleaseInputSchema,
	EnqueueMessageInputSchema,
	EnqueueMessageOutputSchema,
	GetArtifactInputSchema,
	GetRuntimeStabilityInputSchema,
	GetRuntimeStatusInputSchema,
	ListApprovalsInputSchema,
	ListArtifactsInputSchema,
	ListConversationsInputSchema,
	ListRuntimeEventsInputSchema,
	PatchDispatchIdempotencyInputSchema,
	ReadMessagesInputSchema,
	ReadMessagesOutputSchema,
	RecordArtifactInputSchema,
	RecordRuntimeEventInputSchema,
	StopRunInputSchema,
	TediApprovalRequestSchema,
	TediArtifactSchema,
	TediConversationSchema,
	TediRuntimeEventSchema,
	TediRuntimeStabilitySchema,
	TediRuntimeStatusSchema,
	WriteDispatchIdempotencyInputSchema,
} from "../schemas/cognitive-runtime";

const cognitiveRuntimeOc = oc
	.route({ tags: ["cognitive-runtime"] })
	.errors(baseErrors);

/**
 * Tedi-scoped routes live under `/tedis/{tediId}/runtime`. `emitAutomationEvent`
 * addresses its tedi inside the event body (the message IS the config), so it
 * gets a non-tedi REST path — a `{tediId}` path param without a matching
 * required input field is unrepresentable in OpenAPI. RPC procedure paths
 * (`cognitiveRuntime/...`) are unchanged.
 */
export const cognitiveRuntimeContract = {
	rankDiscovery: cognitiveRuntimeOc
		.route({
			tags: ["internal"],
			summary: "Rank authorized Code Mode discovery candidates",
			description:
				"Service-bound advisory ordering of the MCP edge's already authorized shortlist; unavailable or uncertain judgments return null.",
		})
		.input(RankDiscoveryInputSchema)
		.output(RankDiscoveryOutputSchema),
	rankSkills: cognitiveRuntimeOc
		.route({
			tags: ["internal"],
			summary: "Rank eligible runtime skills",
			description:
				"Service-bound advisory ranking of canonical tenant skill candidates; disabled or uncertain evaluations return null.",
		})
		.input(RankSkillsInputSchema)
		.output(RankSkillsOutputSchema),
	...cognitiveRuntimeOc.route({ prefix: "/tedis/{tediId}/runtime" }).router({
		listConversations: oc
			.route({
				method: "GET",
				path: "/conversations",
				summary: "List tedi conversations",
				description:
					"Returns runtime-neutral conversation records for one tedi.",
			})
			.input(ListConversationsInputSchema)
			.output(
				z.object({
					conversations: z.array(TediConversationSchema),
					nextCursor: z.string().nullable().optional(),
				}),
			),

		readMessages: oc
			.route({
				method: "GET",
				path: "/conversations/{conversationId}/messages",
				summary: "Read tedi conversation messages",
				description:
					"Returns runtime-neutral message records for one conversation.",
			})
			.input(ReadMessagesInputSchema)
			.output(ReadMessagesOutputSchema),

		enqueueMessage: oc
			.route({
				method: "POST",
				path: "/messages/enqueue",
				summary: "Enqueue a message to a tedi (fire-and-forget)",
				description:
					"Async dispatch path — forwards the message to the active " +
					"runtime backend and returns immediately with the caller-minted " +
					"idempotencyKey. The backend runId is correlated to the " +
					"idempotencyKey via the chat_dispatch_idempotency table when the " +
					"first runtime event lands. Completion streams via the canonical " +
					"event ingest path.",
			})
			.input(EnqueueMessageInputSchema)
			.output(EnqueueMessageOutputSchema),

		listApprovals: oc
			.route({
				method: "GET",
				path: "/approvals",
				summary: "List tedi runtime approval requests",
				description:
					"Returns canonical approval requests visible to the tedi runtime facade.",
			})
			.input(ListApprovalsInputSchema)
			.output(
				z.object({
					approvals: z.array(TediApprovalRequestSchema),
					nextCursor: z.string().nullable().optional(),
				}),
			),

		stopRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/stop",
				summary: "Stop a tedi runtime run",
				description:
					"Requests cancellation through the active runtime backend and records the canonical run.canceled event.",
			})
			.input(StopRunInputSchema)
			.output(
				z.object({
					ok: z.literal(true),
					event: TediRuntimeEventSchema.optional(),
				}),
			),

		approve: oc
			.route({
				method: "POST",
				path: "/approvals/{approvalRequestId}/resolve",
				summary: "Resolve a tedi runtime approval request",
				description:
					"Routes an approval decision through the active runtime backend and records the canonical approval.resolved event.",
			})
			.input(ApproveInputSchema)
			.output(
				z.object({
					ok: z.literal(true),
					event: TediRuntimeEventSchema.optional(),
				}),
			),

		getStatus: oc
			.route({
				method: "GET",
				path: "/status",
				summary: "Get tedi runtime status",
				description: "Returns the canonical Tedix runtime status for one tedi.",
			})
			.input(GetRuntimeStatusInputSchema)
			.output(z.object({ status: TediRuntimeStatusSchema })),

		getStability: oc
			.route({
				method: "GET",
				path: "/stability",
				summary: "Get tedi runtime stability diagnostics",
				description:
					"Returns runtime-neutral stability diagnostics (event loop, plugin hooks, startup, tasks) for one tedi. Routes through the active runtime backend without exposing backend-specific transports to product callers.",
			})
			.input(GetRuntimeStabilityInputSchema)
			.output(z.object({ stability: TediRuntimeStabilitySchema })),

		listEvents: oc
			.route({
				method: "GET",
				path: "/events",
				summary: "List durable cognitive runtime events",
				description:
					"Returns Tedix-owned runtime events for replay, audit, and Tedix OS Activity.",
			})
			.input(ListRuntimeEventsInputSchema)
			.output(
				z.object({
					events: z.array(TediRuntimeEventSchema),
					/**
					 * Cursor for the next older page. Pass back as `before` on
					 * the next call. Null when no more pages exist.
					 */
					nextBefore: z.string().nullable().optional(),
				}),
			),

		recordEvent: oc
			.route({
				method: "POST",
				path: "/events",
				summary: "Record a cognitive runtime event",
				description:
					"Persists one canonical Tedix runtime event emitted by a runtime adapter or bridge.",
			})
			.input(RecordRuntimeEventInputSchema)
			.output(z.object({ event: TediRuntimeEventSchema })),

		writeDispatchIdempotency: oc
			.route({
				method: "POST",
				path: "/dispatch-idempotency",
				summary: "Write chat dispatch idempotency mapping (internal)",
				description:
					"Service-binding-only — upserts a chat_dispatch_idempotency row " +
					"before the runId is known. Called by the tedi /chat/enqueue " +
					"bridge.",
				tags: ["internal"],
			})
			.input(WriteDispatchIdempotencyInputSchema)
			.output(z.object({ ok: z.literal(true) })),

		patchDispatchIdempotency: oc
			.route({
				method: "POST",
				path: "/dispatch-idempotency/patch",
				summary: "Patch chat dispatch idempotency with runId (internal)",
				description:
					"Service-binding-only — fills in the runId for the most recent " +
					"queued idempotency mapping in (tediId, conversationId). Called " +
					"by the cognitive event ingest on first runtime event.",
				tags: ["internal"],
			})
			.input(PatchDispatchIdempotencyInputSchema)
			.output(z.object({ ok: z.literal(true), matched: z.number() })),

		listArtifacts: oc
			.route({
				method: "GET",
				path: "/artifacts",
				summary: "List durable tedi artifacts",
				description:
					"Returns Tedix-owned artifacts linked to conversations, runs, messages, or cognitive events.",
			})
			.input(ListArtifactsInputSchema)
			.output(
				z.object({
					artifacts: z.array(TediArtifactSchema),
					nextCursor: z.string().nullable().optional(),
				}),
			),

		recordArtifact: oc
			.route({
				method: "POST",
				path: "/artifacts",
				summary: "Record a durable tedi artifact",
				description:
					"Persists one Tedix-owned artifact and emits an artifact.created runtime event.",
			})
			.input(RecordArtifactInputSchema)
			.output(z.object({ artifact: TediArtifactSchema })),

		getArtifact: oc
			.route({
				method: "GET",
				path: "/artifacts/{artifactId}",
				summary: "Get a durable tedi artifact",
				description: "Returns one Tedix-owned artifact by id.",
			})
			.input(GetArtifactInputSchema)
			.output(z.object({ artifact: TediArtifactSchema })),

		createArtifactShareLink: oc
			.route({
				method: "POST",
				path: "/artifacts/{artifactId}/share-link",
				summary: "Mint a temporary share link for a tedi artifact",
				description:
					"Returns a short-lived signed URL that streams the artifact body in a browser without a session. Org-ownership is checked here at mint time; the URL itself is the capability until it expires.",
			})
			.input(CreateArtifactShareLinkInputSchema)
			.output(CreateArtifactShareLinkOutputSchema),

		createRedactedArtifactRevision: oc
			.route({
				method: "POST",
				path: "/artifacts/{parentArtifactId}/redactions",
				summary: "Create a private redaction candidate",
				description:
					"Creates an immutable private text candidate for explicit human review.",
			})
			.input(CreateRedactedArtifactRevisionInputSchema)
			.output(z.object({ review: ArtifactReleaseReviewSchema })),

		getArtifactReleaseReview: oc
			.route({
				method: "GET",
				path: "/artifact-release-reviews",
				summary: "Review a private artifact source or release candidate",
				description:
					"Owner-only bounded inert preview; it does not release either artifact.",
			})
			.input(GetArtifactReleaseReviewInputSchema)
			.output(
				z.object({
					review: ArtifactReleaseReviewSchema.nullable().describe(
						"Present only for an immutable redaction candidate target.",
					),
					sourcePreview: ArtifactReleaseSourcePreviewSchema.nullable().describe(
						"Present only for an original private source target.",
					),
				}),
			),

		approveArtifactRelease: oc
			.route({
				method: "POST",
				path: "/artifact-release-reviews/{candidateId}/approve",
				summary: "Approve an exact redacted artifact revision",
				description:
					"Human-owner, fresh-step-up decision over one immutable digest.",
			})
			.input(ApproveArtifactReleaseInputSchema)
			.output(ArtifactReleaseDecisionOutputSchema),

		revokeArtifactRelease: oc
			.route({
				method: "POST",
				path: "/artifact-release-reviews/{candidateId}/revoke",
				summary: "Revoke an exact artifact release approval",
				description:
					"Human-owner, fresh-step-up revocation; old capabilities remain dead after later reapproval.",
			})
			.input(RevokeArtifactReleaseInputSchema)
			.output(ArtifactReleaseDecisionOutputSchema),
	}),

	...cognitiveRuntimeOc.router({
		emitAutomationEvent: oc
			.route({
				method: "POST",
				path: "/automation/emit",
				summary: "Enqueue an automation event (push-based workflow trigger)",
				description:
					"Publishes a message to the tedix-automation-events Cloudflare Queue. The consumer dispatches it as either a pinned skill workflow run or a real delegated tedi turn — the message IS the config; no tenant-specific platform code involved. Producers mint the idempotencyKey; redelivery dedupes downstream.",
			})
			.input(AutomationEmitInputSchema)
			.output(AutomationEmitOutputSchema),
	}),
};

export type CognitiveRuntimeContract = typeof cognitiveRuntimeContract;
