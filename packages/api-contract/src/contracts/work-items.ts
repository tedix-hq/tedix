import {
	SetWorkItemParentInputSchema,
	RemoveWorkRelationInputSchema,
} from "../schemas/work-items";
import {
	GetAgentScorecardInputSchema,
	GetAgentScorecardResultSchema,
} from "../schemas/work-items";
import {
	PersonalCliReleaseAuthorizationInputSchema,
	PersonalCliReleaseAuthorizationSchema,
} from "../schemas/work-items";
import {
	WorkWaitInputSchema,
	WorkWaitResultSchema,
} from "../schemas/work-wait";
import { CARD_SECRET_MESSAGE, containsCardSecret } from "../utils/card-secrets";
import {
	LaneAttemptGrantInputSchema,
	LaneAttemptGrantSchema,
} from "../schemas/lane-execution";
import {
	GetWorkItemResultSchema,
	ListWorkItemAttemptsResultSchema,
	GetWorkItemInputSchema,
	ListWorkItemAttemptsInputSchema,
	CompleteWorkItemInputSchema,
	LaneDispatchPlanSchema,
	DelegationAutonomyFeedbackInputSchema,
	DelegationAutonomyFeedbackResultSchema,
	WorkExecutorSchema,
	WorkExecutorReferenceSchema,
	ListWorkCliProjectionInputSchema,
	ListWorkCliProjectionResultSchema,
	WorkCheckpointProjectionSchema,
	WorkCheckpointProjectionInputSchema,
	WorkCliLedgerInputSchema,
	WorkCliEventInputSchema,
	ListWorkAttemptCliProjectionResultSchema,
	ListWorkEvidenceCliProjectionResultSchema,
	ListWorkEventCliProjectionResultSchema,
} from "../schemas/work-items";
import {
	AppendWorkAttemptStepsInputSchema,
	AppendWorkAttemptStepsResultSchema,
	ListWorkAttemptStepsInputSchema,
	ListWorkAttemptStepsResultSchema,
	SendWorkAttemptMessageInputSchema,
	StopWorkAttemptInputSchema,
	WorkAttemptMessageSchema,
} from "../schemas/work-attempt-steps";
import {
	ListAgentRunsInputSchema,
	ListAgentRunsResultSchema,
	TellPersonAboutAgentRunInputSchema,
	TellPersonAboutAgentRunResultSchema,
} from "../schemas/work-agent-runs";
import "@orpc/openapi/extensions/route";
/**
 * Work Items Contract
 *
 * Provider-neutral issue/work coordination for tedis and humans. External task
 * tools are projections; Work Items are the canonical Tedix object.
 */

import { oc } from "@orpc/contract";
import {
	InitializeRepositoryCandidateInputSchema,
	RepositoryCandidateInputSchema,
	SubmitRepositoryCandidateInputSchema,
	SealRepositoryCandidateInputSchema,
	RepositoryCandidateResultSchema,
	ApplyRepositoryCandidateInputSchema,
	RepositoryCandidatePublicationResultSchema,
} from "../schemas/repository-candidate";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	FileAgentReviewInputSchema,
	AgentReviewReceiptSchema,
} from "../schemas/agent-review";
import { PaginationMetaSchema, PaginationSchema } from "../schemas/common";
import {
	RepositoryInspectionRequestSchema,
	RepositoryInspectionResultSchema,
} from "../schemas/workstation";
import {
	AuthorizeOwnedChannelInputSchema,
	RevokeOwnedChannelInputSchema,
	CreateWorkItemInputSchema,
	GetOrgGraphHealthInputSchema,
	GetWorkGraphHealthInputSchema,
	ListWorkActivityInputSchema,
	ListWorkActivityResultSchema,
	ListWorkAttemptProjectionInputSchema,
	ListWorkAttemptProjectionResultSchema,
	ListWorkRecoveryProjectionInputSchema,
	ListWorkRecoveryProjectionResultSchema,
	AttachWorkItemSourceInputSchema,
	AttachWorkItemSourceResultSchema,
	ListWorkItemSourcesInputSchema,
	ListWorkItemSourcesResultSchema,
	ReconcileWorkItemSourcesInputSchema,
	ReconcileWorkItemSourcesResultSchema,
	ListWorkItemRelationsInputSchema,
	ListWorkItemRelationsResultSchema,
	OrgGraphHealthReportSchema,
	RunWorkGraphStewardInputSchema,
	WorkGraphHealthReportSchema,
	WorkGraphStewardOutcomeSchema,
	WorkAttemptSchema,
	WorkAttemptCloseoutResultSchema,
	WorkAttemptSummarySchema,
	WorkAttemptRepositoryRequestSchema,
	WorkAttemptRepositorySchema,
	WorkAttemptSettlementSchema,
	WorkAttemptRepositoryLifecycleSchema,
	WorkAttemptRepositoryReadRequestSchema,
	WorkAttemptRepositoryReadResultSchema,
	WorkRepositoryReviewInputSchema,
	WorkRepositoryReviewResultSchema,
	WorkAdmissionRejectionSchema,
	WorkAdmissionSpecificationRejectionSchema,
	WorkAdmissionSpecificationSchema,
	WorkAdmissionSpecificationReceiptSchema,
	WorkResourcePoolSchema,
	WorkBudgetEnvelopeSchema,
	WorkResourcePoolProjectionSchema,
	WorkBudgetEnvelopeProjectionSchema,
	WorkCaseDetailSchema,
	WorkCaseItemSchema,
	WorkCaseKindSchema,
	WorkCaseProofSchema,
	WorkCaseSchema,
	WorkCaseStageSchema,
	WorkFactoryOwnerTypeSchema,
	WorkFactoryProjectionCursorSchema,
	ResolvedWorkEvidenceSchema,
	WorkEvidencePreviewSchema,
	WorkEvidenceKindSchema,
	WorkEvidenceUriSchema,
	WorkEventSchema,
	WorkItemClassSchema,
	WorkItemCommentSchema,
	WorkItemCorroborationSchema,
	WorkItemCorroborationStanceSchema,
	WorkItemDispositionSchema,
	WorkItemKindSchema,
	WorkItemOwnerTypeSchema,
	WorkItemAcceptanceContractSchema,
	WorkItemPrioritySchema,
	WorkItemTimestampSchema,
	WorkItemRiskLevelSchema,
	WorkItemReadinessSchema,
	WorkItemReadinessProjectionSchema,
	WorkItemRelationSchema,
	WorkItemRelationTypeSchema,
	WorkItemSchema,
} from "../schemas/work-items";

const JsonRecordSchema = z.record(z.string(), z.unknown());

/**
 * A list row is a Work Item plus the Attempt currently holding it, when one
 * exists. Kept separate from `WorkItemSchema` on purpose: `create` and
 * `getById` return a Work Item as it is stored, and holding is a property of
 * the moment, not of the record.
 *
 * `null` means there is no canonical Attempt.
 */
export const WorkItemListRowSchema = WorkItemSchema.extend({
	latestAttempt: WorkAttemptSummarySchema.nullable().describe(
		"Latest canonical Attempt summary. Null means no Attempt. A succeeded Attempt is not Work completion.",
	),
	activeAttempt: z
		.object({
			attemptId: z.string(),
			executorType: z.string(),
			executorId: z.string(),
			agentSession: z
				.string()
				.nullable()
				.describe(
					"External coding-harness session key (`codex:…`, `claude-code:…`). Null when the holder is not an external agent: a tedi and a service-binding executor hold an Attempt under their own identity and mint no session key, so `external_session_key` is null for them by design.",
				),
			startedAt: z.string(),
			heartbeatAt: z.string(),
			expiresAt: z
				.string()
				.nullable()
				.describe(
					"When this Attempt's lease lapses. Null for an Attempt that carries no expiry — the column is nullable and a lease is stamped at admission, so a queued Attempt can be live and unexpiring. Absence is not an expired lease; compare `heartbeatAt` instead.",
				),
		})
		.nullable()
		.optional()
		.describe(
			"The Attempt currently holding this Work Item, or null when none does. Live means runtime state queued, running, waiting or retrying.",
		),
});

export const workItemsContract = oc
	.route({ tags: ["work-items"], prefix: "/work-items" })
	.errors(baseErrors)
	.router({
		recordDelegationAutonomyFeedback: oc
			.route({
				method: "POST",
				path: "/delegation-autonomy-feedback",
				summary: "Ask before this class of delegation in future",
			})
			.input(DelegationAutonomyFeedbackInputSchema)
			.output(DelegationAutonomyFeedbackResultSchema),
		fileAgentReview: oc
			.route({
				method: "POST",
				path: "/agent-reviews",
				summary: "File a private agent review",
			})
			.input(FileAgentReviewInputSchema)
			.output(AgentReviewReceiptSchema),
		listCliProjection: oc
			.route({
				method: "GET",
				path: "/cli/listCliProjection",
				summary: "Bounded CLI listCliProjection",
			})
			.input(ListWorkCliProjectionInputSchema)
			.output(ListWorkCliProjectionResultSchema),
		getCheckpointProjection: oc
			.route({
				method: "GET",
				path: "/cli/getCheckpointProjection",
				summary: "Bounded CLI getCheckpointProjection",
			})
			.input(WorkCheckpointProjectionInputSchema)
			.output(WorkCheckpointProjectionSchema),
		listAttemptCliProjection: oc
			.route({
				method: "GET",
				path: "/cli/listAttemptCliProjection",
				summary: "Bounded CLI listAttemptCliProjection",
			})
			.input(WorkCliLedgerInputSchema)
			.output(ListWorkAttemptCliProjectionResultSchema),
		listEvidenceCliProjection: oc
			.route({
				method: "GET",
				path: "/cli/listEvidenceCliProjection",
				summary: "Bounded CLI listEvidenceCliProjection",
			})
			.input(WorkCliLedgerInputSchema)
			.output(ListWorkEvidenceCliProjectionResultSchema),
		listEventCliProjection: oc
			.route({
				method: "GET",
				path: "/cli/listEventCliProjection",
				summary: "Bounded CLI listEventCliProjection",
			})
			.input(WorkCliEventInputSchema)
			.output(ListWorkEventCliProjectionResultSchema),

		authorizeOwnedChannel: oc
			.route({
				method: "POST",
				path: "/{id}/owned-channel/authorize",
				summary: "Authorize bounded owned-channel publishing",
			})
			.input(AuthorizeOwnedChannelInputSchema)
			.output(WorkEventSchema),
		revokeOwnedChannel: oc
			.route({
				method: "POST",
				path: "/{id}/owned-channel/revoke",
				summary: "Revoke owned-channel publishing",
			})
			.input(RevokeOwnedChannelInputSchema)
			.output(WorkEventSchema),
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create Work Item",
				successStatus: 201,
			})
			.input(CreateWorkItemInputSchema)
			.output(WorkItemSchema),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List Work Items",
			})
			.input(
				z
					.object({
						disposition: WorkItemDispositionSchema.optional().describe(
							'Server-side lifecycle filter: proposed | accepted | completed | cancelled. There is no "status" field — "pending" work is disposition proposed (not yet accepted) or accepted (admitted, not completed).',
						),
						excludeDisposition: WorkItemDispositionSchema.optional().describe(
							"Server-side lifecycle filter: leave out Work Items with this disposition. excludeDisposition proposed lists accepted, completed and cancelled Work without the proposals still in triage.",
						),
						executor: z
							.union([
								WorkExecutorSchema,
								z.array(WorkExecutorSchema).min(1).max(10),
							])
							.optional(),
						executorType: WorkExecutorReferenceSchema.shape.type
							.optional()
							.describe(
								"Match this executor type. When provided, executor names match exact IDs within the type.",
							),
						dispatchReadyOnly: z.boolean().optional(),
						workKind: WorkItemKindSchema.optional(),
						objectiveId: z.uuid().optional(),
						workClass: WorkItemClassSchema.optional(),
						projectId: z.uuid().optional(),
						accountableOwnerId: z
							.string()
							.trim()
							.min(1)
							.max(300)
							.optional()
							.describe(
								"Server-side filter on the exact accountable owner identity (e.g. a tedi id), applied before paging so one owner's items are never hidden behind another owner's.",
							),
						objectiveLinked: z
							.boolean()
							.optional()
							.describe(
								"Server-side filter: true keeps only items linked to an objective, false only unlinked items.",
							),
						// Server-side id resolver: match ids starting with this lowercase
						// uuid fragment. Composes with every other filter.
						idPrefix: z
							.string()
							.regex(
								/^[0-9a-f-]{6,36}$/,
								"idPrefix must be 6-36 characters using only [0-9a-f-]",
							)
							.optional(),
						// Case-insensitive title substring (LIKE wildcards are literal).
						titleContains: z.string().min(1).max(200).optional(),
						customerVisibleOnly: z
							.boolean()
							.optional()
							.describe(
								"Server-side PRE-FILTER that drops the dominant internal execution shapes (agent-session rows and transitional purpose contexts) before paging, so an embedded customer board is not paging through factory records to reach its own work. It is NOT the customer-visibility authority: the full rule has seven clauses and lives with the renderer, which must still apply it to what comes back.",
							),
						mattersThrough: z.iso
							.datetime()
							.optional()
							.describe(
								"Server-side Work-home filter: keep critical or high-priority Work, or Work whose own due date or deadline falls on or before this instant.",
							),
						needsProject: z
							.literal(true)
							.optional()
							.describe(
								"Server-side filter: keep only tasks Home started without a project that still have none. Moving a task into a project removes it from this list.",
							),
					})
					.extend(PaginationSchema.shape)
					// Strict: a silently stripped unknown key (e.g. `status`) would
					// no-op the caller's filter. Unknown keys error and name themselves.
					.strict()
					.optional(),
			)
			.output(
				z.object({
					data: z.array(WorkItemListRowSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		listReadinessProjection: oc
			.route({
				method: "GET",
				path: "/queue/readiness",
				summary: "List bounded Work queue readiness",
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"Optional project filter; omission includes accepted Work across the organization.",
							),
						workKind: WorkItemKindSchema.optional().describe(
							"Optional Work kind filter; omission includes every accepted Work kind.",
						),
						cursor: WorkFactoryProjectionCursorSchema.optional().describe(
							"Opaque accepted-queue timeline cursor; omit to read the newest bounded page.",
						),
						limit: z.number().int().min(1).max(50).default(25),
					})
					.optional(),
			)
			.output(
				z
					.object({
						data: z.array(WorkItemReadinessProjectionSchema).max(50),
						nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
							"Null when the accepted Work queue has no further bounded page.",
						),
						hasMore: z.boolean(),
						observedAt: z.iso.datetime(),
					})
					.strict(),
			),

		createCase: oc
			.route({
				method: "POST",
				path: "/cases",
				summary: "Create epic",
				successStatus: 201,
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"Optional project context; epics may instead be objective- or organization-scoped.",
							),
						objectiveId: z
							.uuid()
							.optional()
							.describe("Optional strategic objective context for the epic."),
						kind: WorkCaseKindSchema,
						title: z.string().trim().min(1).max(500),
						description: z
							.string()
							.max(10_000)
							.optional()
							.describe(
								"Optional initial narrative; investigating epics may begin title-only.",
							),
						stage: WorkCaseStageSchema.exclude(["closed"])
							.optional()
							.describe(
								"Optional initial stage; omission starts the epic in investigating.",
							),
						accountableOwnerType: WorkFactoryOwnerTypeSchema,
						accountableOwnerId: z.string().trim().min(1).max(300),
						openedAt: z.iso
							.datetime()
							.optional()
							.describe(
								"Optional historical opening time; the server uses the current time when omitted.",
							),
						targetResolutionAt: z.iso
							.datetime()
							.optional()
							.describe("Optional target date for resolving the epic."),
						proofRef: WorkCaseProofSchema.optional().describe(
							"Optional proof of delivery: a link or reference to the result.",
						),
					})
					.strict(),
			)
			.output(WorkCaseSchema),

		listCases: oc
			.route({
				method: "GET",
				path: "/cases",
				summary: "List epics",
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"Optional project filter; omission includes epics across the organization.",
							),
						stages: z
							.array(WorkCaseStageSchema)
							.min(1)
							.max(5)
							.optional()
							.describe(
								"Optional stage filter; omission includes every epic stage.",
							),
						cursor: WorkFactoryProjectionCursorSchema.optional().describe(
							"Opaque epic timeline cursor; omit to start at the newest page.",
						),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.optional(),
			)
			.output(
				z
					.object({
						data: z.array(WorkCaseSchema),
						nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
							"Null when the bounded epic list has no further page.",
						),
					})
					.strict(),
			),

		getCase: oc
			.route({
				method: "GET",
				path: "/cases/{caseId}",
				summary: "Get epic detail",
			})
			.input(
				z
					.object({
						caseId: z.uuid(),
						itemCursor: z
							.uuid()
							.optional()
							.describe(
								"Opaque attachment cursor; omit to read the first bounded item page.",
							),
						itemLimit: z.number().int().min(1).max(100).default(50),
					})
					.strict(),
			)
			.output(WorkCaseDetailSchema),

		updateCase: oc
			.route({
				method: "PATCH",
				path: "/cases/{caseId}",
				summary: "Update epic",
			})
			.input(
				z
					.object({
						caseId: z.uuid(),
						expectedVersion: z.number().int().positive(),
						title: z
							.string()
							.trim()
							.min(1)
							.max(500)
							.optional()
							.describe("Omit to preserve the current epic title."),
						description: z
							.string()
							.max(10_000)
							.nullable()
							.optional()
							.describe("Omit to preserve the narrative; null clears it."),
						stage: WorkCaseStageSchema.optional().describe(
							"Omit to preserve the current epic stage.",
						),
						accountableOwnerType:
							WorkFactoryOwnerTypeSchema.optional().describe(
								"Omit to preserve the accountable owner type.",
							),
						accountableOwnerId: z
							.string()
							.trim()
							.min(1)
							.max(300)
							.optional()
							.describe("Omit to preserve the accountable owner identity."),
						targetResolutionAt: z.iso
							.datetime()
							.nullable()
							.optional()
							.describe("Omit to preserve the target date; null removes it."),
						proofRef: WorkCaseProofSchema.nullable()
							.optional()
							.describe(
								"Omit to preserve the proof of delivery; null removes it.",
							),
					})
					.strict(),
			)
			.output(WorkCaseSchema),

		reopenCase: oc
			.route({
				method: "POST",
				path: "/cases/{caseId}/reopen",
				summary: "Reopen epic",
				description:
					"Owner/admin only, within 30 days of closing. Clears the close date and preserves proof and linked Work. Requires the current version.",
			})
			.input(
				z.strictObject({
					caseId: z.uuid(),
					expectedVersion: z.number().int().positive(),
					stage: z
						.enum(["investigating", "planning", "executing", "monitoring"])
						.default("investigating"),
				}),
			)
			.output(WorkCaseSchema),
		moveCase: oc
			.route({
				method: "POST",
				path: "/cases/{caseId}/move",
				summary: "Move epic to project",
				description:
					"Owner/admin only. Move to a non-archived project in this organization and inherit its objective. Linked Work Items retain their projects and history. Requires the current version.",
			})
			.input(
				z.strictObject({
					caseId: z.uuid(),
					projectId: z.uuid(),
					expectedVersion: z.number().int().positive(),
				}),
			)
			.output(WorkCaseSchema),

		attachCaseWorkItem: oc
			.route({
				method: "POST",
				path: "/cases/{caseId}/work-items",
				summary: "Attach Work Item to epic",
				successStatus: 201,
			})
			.input(
				z
					.object({
						caseId: z.uuid(),
						workItemId: z.uuid(),
						rationale: z
							.string()
							.max(2_000)
							.optional()
							.describe(
								"Optional explanation of how the attached Work Item informs the epic.",
							),
					})
					.strict(),
			)
			.output(WorkCaseItemSchema),

		detachCaseWorkItem: oc
			.route({
				method: "DELETE",
				path: "/cases/{caseId}/work-items/{workItemId}",
				summary: "Detach Work Item from epic",
				description:
					"Owner/admin undo of attachCaseWorkItem. Removes only the membership link; the Work Item and its history stay, and the removed link is recorded in a work.case_detached event.",
			})
			.input(
				z.strictObject({
					caseId: z.uuid(),
					workItemId: z.uuid(),
				}),
			)
			.output(WorkCaseItemSchema),

		getById: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get Work Item",
			})
			.input(GetWorkItemInputSchema)
			.output(GetWorkItemResultSchema),

		getMany: oc
			.route({
				method: "POST",
				path: "/batch-read",
				summary: "Read several Work Items",
				description:
					"Read up to 50 canonical Work Item IDs in one call. Returns each accessible item once, in request order, and missingIds for absent or out-of-organization IDs. Does not include comments or evidence.",
			})
			.input(z.strictObject({ ids: z.array(z.uuid()).min(1).max(50) }))
			.output(
				z.object({
					items: z.array(WorkItemSchema),
					missingIds: z.array(z.uuid()),
				}),
			),

		getWorkGraphHealth: oc
			.route({
				method: "GET",
				path: "/work-graph/health",
				summary: "Work-graph health report",
			})
			.input(GetWorkGraphHealthInputSchema)
			.output(WorkGraphHealthReportSchema),

		runWorkGraphSteward: oc
			.route({
				method: "POST",
				path: "/work-graph/steward",
				summary: "Run the work-graph steward",
				tags: ["internal"],
			})
			.input(RunWorkGraphStewardInputSchema)
			.output(WorkGraphStewardOutcomeSchema),

		getOrgGraphHealth: oc
			.route({
				method: "GET",
				path: "/org-graph/health",
				summary: "Org graph health (blocked-work dependency analysis)",
			})
			.input(GetOrgGraphHealthInputSchema)
			.output(OrgGraphHealthReportSchema),

		listRelations: oc
			.route({
				method: "GET",
				path: "/relations",
				summary: "List Work Item dependency edges",
			})
			.input(ListWorkItemRelationsInputSchema)
			.output(ListWorkItemRelationsResultSchema),

		attachWorkItemSource: oc
			.route({
				method: "POST",
				path: "/sources",
				summary: "Attach an external source to a project or work item",
			})
			.input(AttachWorkItemSourceInputSchema)
			.output(AttachWorkItemSourceResultSchema),

		listWorkItemSources: oc
			.route({
				method: "GET",
				path: "/sources",
				summary: "List external sources attached to work",
			})
			.input(ListWorkItemSourcesInputSchema)
			.output(ListWorkItemSourcesResultSchema),

		reconcileWorkItemSources: oc
			.route({
				method: "POST",
				path: "/sources/reconcile",
				summary: "Reconcile attached sources against what a sweep observed",
			})
			.input(ReconcileWorkItemSourcesInputSchema)
			.output(ReconcileWorkItemSourcesResultSchema),

		listActivity: oc
			.route({
				method: "GET",
				path: "/activity",
				summary: "List board history or poll activity after a checkpoint",
			})
			.input(ListWorkActivityInputSchema)
			.output(ListWorkActivityResultSchema),

		getAgentScorecard: oc
			.route({
				method: "GET",
				path: "/factory/agent-scorecard",
				summary: "Compare tedi and runner activity over 24 hours",
			})
			.input(GetAgentScorecardInputSchema)
			.output(GetAgentScorecardResultSchema),

		listAttemptProjection: oc
			.route({
				method: "GET",
				path: "/factory/attempts",
				summary: "List org-wide Work attempts",
			})
			.input(ListWorkAttemptProjectionInputSchema)
			.output(ListWorkAttemptProjectionResultSchema),

		listRecoveryProjection: oc
			.route({
				method: "GET",
				path: "/factory/recovery",
				summary: "List Work recovery signals",
			})
			.input(ListWorkRecoveryProjectionInputSchema)
			.output(ListWorkRecoveryProjectionResultSchema),

		restoreFiling: oc
			.route({
				method: "POST",
				path: "/{id}/restore-filing",
				summary: "Restore Work filing",
				description:
					"Owner/admin undo of a filing change. Writes the exact project, objective, class and exception expiry given, nulls included, behind an exact-version fence. Refused on closed Work and while an Attempt is live. Appends a work.filing_restored event holding both sides.",
			})
			.input(
				z.strictObject({
					id: z.uuid(),
					expectedWorkItemVersion: z.number().int().positive(),
					projectId: z.uuid().nullable(),
					objectiveId: z.uuid().nullable(),
					workClass: WorkItemClassSchema.nullable(),
					purposeExceptionExpiresAt: z.iso.datetime().nullable(),
				}),
			)
			.output(WorkItemSchema),

		updateSpecification: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update Work Item specification",
				description:
					"Update descriptive Work Item specification fields. Setting executor to codex or claude-code on accepted Work queues a fresh local session with the description as its brief. Disposition, readiness, attempts, and evidence are changed only through their dedicated operations.",
			})
			.input(
				z.strictObject({
					id: z.uuid(),
					idleReassignment: z
						.strictObject({
							fromExecutor: z.enum([
								"codex",
								"claude-code",
								"opencode",
								"devin",
								"tedi",
								"any-local",
							]),
							unavailableSince: z.iso.datetime(),
							minimumIdleMinutes: z.number().int().min(1).max(1440).default(15),
							reason: z
								.enum(["unreachable", "unavailable", "chosen"])
								.describe(
									"unreachable/unavailable: the tool cannot take Work; chosen: the decision model picked another available tool (no waiting time)",
								),
							detail: z
								.string()
								.trim()
								.min(1)
								.max(300)
								.optional()
								.describe(
									"Why the assigned tool cannot take Work, in plain words; written on the item.",
								),
						})
						.optional()
						.describe(
							"Owner/admin dispatcher reassignment when the assigned tool is unreachable or unavailable (out of credits, at its limit, signed out). Preserves the Work revision and failure hold; cannot accompany specification edits. Work with metadata.onlyExecutor stays on its tool.",
						),
					executorReference: WorkExecutorReferenceSchema.optional().describe(
						"The executor's type and ID. Owners, admins and the Work's tedi steward may set it. External agents codex and claude-code queue a fresh session on accepted Work.",
					),
					laneDispatch: LaneDispatchPlanSchema.optional(),
					delegationDepth: z
						.number()
						.int()
						.min(0)
						.max(10)
						.nullable()
						.optional(),
					maxAttempts: z.number().int().min(1).max(20).nullable().optional(),
					rootWorkItemId: z.uuid().nullable().optional(),
					rootGoal: z.string().trim().min(1).max(10_000).nullable().optional(),
					budgetShareMicros: z
						.number()
						.int()
						.min(0)
						.max(1_000_000)
						.nullable()
						.optional(),
					projectId: z
						.uuid()
						.optional()
						.describe(
							"Owner/admin move to another project in this organization. Objective Work takes the new project's objective.",
						),
					expectedWorkItemVersion: z
						.number()
						.int()
						.positive()
						.optional()
						.describe(
							"Optional exact-version fence; omitted updates retain their server-side compare-and-swap behavior.",
						),
					title: z.string().min(1).max(500).optional(),
					description: z.string().max(10000).nullable().optional(),
					workKind: WorkItemKindSchema.optional(),
					workClass: WorkItemClassSchema.optional().describe(
						"Owner/admin purpose repair. Choose objective to use the project's objective and clear the exception expiry; other existing classes cannot change.",
					),
					purposeExceptionExpiresAt: z.iso
						.datetime()
						.optional()
						.describe(
							"Owner/admin renewal of operational purpose, bounded to 30 days.",
						),
					riskLevel: WorkItemRiskLevelSchema.optional(),
					priority: WorkItemPrioritySchema.optional(),
					accountableOwnerType: WorkItemOwnerTypeSchema.nullable().optional(),
					accountableOwnerId: z.string().max(300).nullable().optional(),
					stewardType: WorkItemOwnerTypeSchema.nullable().optional(),
					stewardId: z.string().max(300).nullable().optional(),
					requiredCapabilities: z
						.array(z.string().min(1).max(200))
						.max(100)
						.optional(),
					requiredAuthorities: z
						.array(z.string().min(1).max(200))
						.max(100)
						.optional(),
					dueDate: WorkItemTimestampSchema.nullable().optional(),
					deadline: WorkItemTimestampSchema.nullable().optional(),
					startAt: z.iso
						.datetime()
						.nullable()
						.optional()
						.describe(
							"Start date: runners are not handed the Work before it, and readiness reports not_before until then. Omit to preserve it; null clears it.",
						),
					durationDays: z
						.number()
						.int()
						.positive()
						.max(3650)
						.nullable()
						.optional()
						.describe("Omit to preserve duration; null clears it."),
					// Widening only. `accept` is the only creator of an acceptance
					// contract and requires a `proposed` item, so without this the
					// kinds chosen at accept time — before the work is done — were the
					// only kinds a claim would ever take, and evidence discovered later
					// could not be attached at all. Removal stays inexpressible: it
					// would orphan evidence already accepted under a dropped kind.
					addEvidenceKinds: z
						.record(
							z.string().trim().min(1).max(120),
							z.array(WorkEvidenceKindSchema).min(1).max(50),
						)
						.optional()
						.describe(
							"Additional evidence kinds per acceptance claim key. Additive only: existing kinds are always retained, so evidence already submitted stays valid.",
						),
				}),
			)
			.output(WorkItemSchema),

		replaceAdmissionSpecification: oc
			.route({
				method: "PUT",
				path: "/{id}/admission-specification",
				summary: "Replace Work admission specification",
			})
			.errors({
				UNPROCESSABLE_CONTENT: {
					message:
						"Admission specification references unregistered resource pools",
					data: WorkAdmissionSpecificationRejectionSchema,
				},
			})
			.input(
				z
					.object({
						id: z.uuid(),
						expectedWorkItemVersion: z.number().int().positive(),
						expectedAdmissionSpecRevision: z.string().trim().min(1).max(200),
						specification: WorkAdmissionSpecificationSchema,
					})
					.strict(),
			)
			.output(WorkAdmissionSpecificationReceiptSchema),

		grantLaneAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/lane-attempt-grants",
				summary: "Grant one extra lane Attempt",
				description:
					"An organization owner or admin restores one lane Attempt on open Work by naming a failed or expired Attempt it replaces. The grant is recorded with who approved it and why; each Attempt can be replaced once. Agents cannot grant Attempts.",
			})
			.input(LaneAttemptGrantInputSchema)
			.output(LaneAttemptGrantSchema),

		getAdmissionSpecification: oc
			.route({
				method: "GET",
				path: "/{id}/admission-specification",
				summary: "Get Work admission specification",
			})
			.input(z.object({ id: z.uuid() }).strict())
			.output(WorkAdmissionSpecificationReceiptSchema),

		putResourcePool: oc
			.route({
				method: "PUT",
				path: "/admission/resource-pools/{resourceKey}",
				summary: "Upsert Work resource pool",
			})
			.input(
				z
					.object({
						resourceKey: z.string().trim().min(1).max(300),
						allocationMode: z.enum(["exclusive", "capacity"]),
						capacity: z.number().int().positive(),
						ownerRef: z
							.string()
							.max(500)
							.nullable()
							.optional()
							.describe(
								"Omit on create or to preserve the owner reference; null clears it on update.",
							),
						expectedVersion: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Required to CAS-update an existing pool; omit only when creating it.",
							),
					})
					.strict(),
			)
			.output(WorkResourcePoolSchema),

		putBudgetEnvelope: oc
			.route({
				method: "PUT",
				path: "/admission/budget-envelopes/{scopeType}/{scopeId}",
				summary: "Upsert Work budget envelope",
			})
			.input(
				z
					.object({
						scopeType: z.enum([
							"organization",
							"project",
							"case",
							"work_item",
							"objective",
						]),
						scopeId: z.uuid(),
						currency: z
							.enum(["USD", "credits"])
							.optional()
							.describe(
								"Set when creating: credits for a Tedix credit budget (limitMicros in millionths of a credit, reservationMicros 0), USD (default) for a per-Attempt reservation budget. An envelope keeps its currency.",
							),
						mode: z
							.enum(["stop", "alert"])
							.optional()
							.describe(
								"Credit budgets only. stop (default): spend past the limit is refused and the Work waits for a raise. alert: spend continues; owners get 80% and 100% notices.",
							),
						limitMicros: z.number().int().nonnegative(),
						reservationMicros: z.number().int().nonnegative(),
						enabled: z
							.boolean()
							.optional()
							.describe(
								"false turns an existing budget off: nothing counts against it or waits on it. true turns it back on. Omit to leave it as it is.",
							),
						expectedVersion: z
							.number()
							.int()
							.positive()
							.optional()
							.describe(
								"Required to CAS-update an existing envelope; omit only when creating it.",
							),
					})
					.strict(),
			)
			.output(WorkBudgetEnvelopeSchema),

		listResourcePools: oc
			.route({
				method: "GET",
				path: "/admission/resource-pools",
				summary: "List Work resource pools",
			})
			.input(
				z
					.object({
						saturatedOnly: z.boolean().optional(),
						resourceKey: z
							.string()
							.min(1)
							.max(300)
							.optional()
							.describe(
								"Exact resource key equality; omit to list all enabled pools.",
							),
						cursor: z
							.uuid()
							.optional()
							.describe(
								"Opaque resource-pool cursor; omit to read the first bounded page.",
							),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.optional(),
			)
			.output(
				z.object({
					data: z.array(WorkResourcePoolProjectionSchema),
					nextCursor: z
						.uuid()
						.nullable()
						.describe("Null when the resource-pool list has no further page."),
					observedAt: z.iso.datetime(),
				}),
			),

		listBudgetEnvelopes: oc
			.route({
				method: "GET",
				path: "/admission/budget-envelopes",
				summary: "List Work budget envelopes",
			})
			.input(
				z
					.object({
						includeDisabled: z
							.boolean()
							.optional()
							.describe("true also lists budgets that were turned off."),
						cursor: z
							.uuid()
							.optional()
							.describe(
								"Opaque budget-envelope cursor; omit to read the first bounded page.",
							),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.optional(),
			)
			.output(
				z.object({
					data: z.array(WorkBudgetEnvelopeProjectionSchema),
					nextCursor: z
						.uuid()
						.nullable()
						.describe(
							"Null when the budget-envelope list has no further page.",
						),
					observedAt: z.iso.datetime(),
				}),
			),

		accept: oc
			.route({
				method: "POST",
				path: "/{id}/accept",
				summary: "Accept Work Item",
			})
			.input(
				z.object({
					id: z.uuid(),
					acceptanceContract: WorkItemAcceptanceContractSchema,
				}),
			)
			.output(WorkItemSchema),

		getReadiness: oc
			.route({
				method: "GET",
				path: "/{id}/readiness",
				summary: "Derive Work Item readiness",
			})
			.input(z.object({ id: z.uuid() }))
			.output(WorkItemReadinessSchema),

		cancel: oc
			.route({
				method: "POST",
				path: "/{id}/cancel",
				summary: "Cancel Work Item",
			})
			.input(
				z.object({
					id: z.uuid(),
					reason: z.string().max(2000).optional(),
					hygiene: z
						.object({
							expectedWorkItemVersion: z.number().int().positive(),
							humanQuietHours: z.number().min(48),
							noAttempts: z.boolean(),
						})
						.strict()
						.optional()
						.describe(
							"Atomically preserve recent human comments and, for idle cleanup, any Attempt history.",
						),
				}),
			)
			.output(WorkItemSchema),

		decline: oc
			.route({
				method: "POST",
				path: "/{id}/decline",
				summary: "Decline a proposed Work Item",
			})
			.input(
				z.object({
					id: z.uuid(),
					reason: z
						.string()
						.trim()
						.min(1)
						.max(2000)
						.describe("Why this proposal will not be done."),
				}),
			)
			.output(WorkItemSchema),

		markDuplicate: oc
			.route({
				method: "POST",
				path: "/{id}/duplicate",
				summary: "Close a proposed Work Item as a duplicate of another",
			})
			.input(
				z.object({
					id: z.uuid(),
					duplicateOfWorkItemId: z
						.uuid()
						.describe("The Work Item that already covers this proposal."),
					reason: z.string().trim().min(1).max(2000).optional(),
				}),
			)
			.output(WorkItemSchema),

		snooze: oc
			.route({
				method: "POST",
				path: "/{id}/snooze",
				summary: "Snooze a proposed Work Item out of triage",
			})
			.input(
				z.object({
					id: z.uuid(),
					until: z.iso
						.datetime({ offset: true })
						.nullable()
						.describe(
							"When the proposal returns to its triage queue. Null wakes it now.",
						),
				}),
			)
			.output(WorkItemSchema),

		listTriage: oc
			.route({
				method: "GET",
				path: "/triage",
				summary: "List Work Items waiting in triage",
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"A project's triage queue. Omit for the organization queue: proposals that have no project yet.",
							),
					})
					.extend(PaginationSchema.shape)
					.strict()
					.optional(),
			)
			.output(
				z.object({
					data: z.array(WorkItemSchema),
					pagination: PaginationMetaSchema,
					queues: z
						.array(
							z.object({
								projectId: z.uuid().nullable(),
								count: z.number().int().nonnegative(),
							}),
						)
						.describe(
							"Waiting proposals per project; a null project is the organization queue.",
						),
					snoozed: z
						.number()
						.int()
						.nonnegative()
						.describe("Proposals snoozed out of every queue."),
				}),
			),

		closeoutDelegated: oc
			.route({
				method: "POST",
				path: "/{id}/delegated-closeout",
				tags: ["internal"],
				summary: "Close a settled Work Item within a persisted Home request",
			})
			.input(
				z.object({
					id: z.uuid(),
					homeRunId: z.uuid(),
					runId: z.string().min(1).max(500),
					linkedWorkItemId: z.uuid(),
					sha: z.string().regex(/^[a-f\d]{40}$/i),
				}),
			)
			.output(WorkItemSchema),

		complete: oc
			.route({
				method: "POST",
				path: "/{id}/complete",
				summary: "Complete Work Item",
			})
			.input(CompleteWorkItemInputSchema)
			.output(WorkItemSchema),

		addComment: oc
			.route({
				method: "POST",
				path: "/{id}/comments",
				summary: "Add Work Item comment",
				successStatus: 201,
			})
			.input(
				z
					.object({
						id: z.uuid(),
						body: z.string().min(1).max(10000),
						requestDelegation: z
							.boolean()
							.optional()
							.describe(
								"Explicitly request executor assignment from this comment; requires specification authority. Ordinary comment text never changes assignment.",
							),
						metadata: JsonRecordSchema.optional().describe(
							'Set decisionImpact to "progress" only for routine notes that change no decision facts. Such notes do not stale cards created by the same agent; unmarked and fact-changing comments still do.',
						),
					})
					.refine(
						(value) => !containsCardSecret([value.body, value.metadata]),
						CARD_SECRET_MESSAGE,
					),
			)
			.output(WorkItemCommentSchema),

		corroborate: oc
			.route({
				method: "POST",
				path: "/{id}/corroborations",
				summary: "Corroborate an existing Work Item",
				successStatus: 201,
			})
			.input(
				z.object({
					id: z.uuid(),
					evidenceRef: z.string().trim().min(1).max(2_000),
					stance: WorkItemCorroborationStanceSchema.default("corroborates"),
					body: z.string().trim().min(1).max(10_000),
				}),
			)
			.output(WorkItemCorroborationSchema),

		listCorroborations: oc
			.route({
				method: "GET",
				path: "/{id}/corroborations",
				summary: "List canonical Work Item corroborations",
			})
			.input(z.object({ id: z.uuid() }))
			.output(z.array(WorkItemCorroborationSchema)),

		setParent: oc
			.route({
				method: "POST",
				path: "/{id}/parent",
				summary: "Set or clear a Work Item parent",
			})
			.input(SetWorkItemParentInputSchema)
			.output(WorkItemSchema),

		removeRelation: oc
			.route({
				method: "DELETE",
				path: "/{workItemId}/relations",
				summary: "Remove a Work Item relation",
			})
			.input(RemoveWorkRelationInputSchema)
			.output(z.object({ removed: z.boolean() })),

		addRelation: oc
			.route({
				method: "POST",
				path: "/{id}/relations",
				summary: "Add Work Item relation",
				successStatus: 201,
			})
			.input(
				z.object({
					id: z.uuid(),
					toWorkItemId: z.uuid(),
					relationType: WorkItemRelationTypeSchema,
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(WorkItemRelationSchema),

		authorizePersonalCliRelease: oc
			.route({
				method: "POST",
				path: "/{id}/personal-cli-release-authorization",
				summary: "Check personal CLI release authority",
				description:
					"Read-only check of the signed-in person's live release Attempt for an exact commit, version and ref.",
			})
			.input(PersonalCliReleaseAuthorizationInputSchema)
			.output(PersonalCliReleaseAuthorizationSchema),

		startAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/attempts",
				summary: "Start Work Item attempt",
			})
			.errors({
				CONFLICT: {
					message: "Work Item was not admitted",
					data: WorkAdmissionRejectionSchema.optional().describe(
						"Present when admission was evaluated and rejected; absent for a plain concurrency conflict.",
					),
				},
			})
			.input(
				z.object({
					id: z.uuid(),
					runId: z.string().max(2_000).optional(),
					metadata: JsonRecordSchema.optional(),
					repository: WorkAttemptRepositoryRequestSchema.optional().describe(
						"Opt in to one isolated Cloudflare Artifacts repository for this Attempt.",
					),
				}),
			)
			.output(
				z.object({
					workItem: WorkItemSchema,
					attempt: WorkAttemptSchema,
					resumed: z.boolean(),
					repository: WorkAttemptRepositorySchema.nullable().optional(),
				}),
			),

		heartbeatAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/heartbeat",
				summary: "Heartbeat Work Item attempt",
			})
			.input(
				z.object({
					id: z.uuid(),
					attemptId: z.uuid(),
					costMicros: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe(
							"Spend committed so far by this Attempt, in micros; replaces the running total on its budget reservation.",
						),
				}),
			)
			.output(WorkAttemptSchema),

		appendAttemptSteps: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/steps",
				summary: "Report run steps",
				description:
					"Called by the runner holding the Attempt. Stores the new steps of its run and returns the follow-ups or stop waiting for it. A stale Attempt, or one held by another runner, is refused.",
			})
			.input(AppendWorkAttemptStepsInputSchema)
			.output(AppendWorkAttemptStepsResultSchema),

		listAttemptSteps: oc
			.route({
				method: "GET",
				path: "/{id}/attempt-steps",
				summary: "List run steps",
				description:
					"Read the steps of a run on a Work Item, oldest first, with the messages sent to it. Without attemptId it reads the newest run.",
			})
			.input(ListWorkAttemptStepsInputSchema)
			.output(ListWorkAttemptStepsResultSchema),

		sendAttemptMessage: oc
			.route({
				method: "POST",
				path: "/{id}/attempt-messages",
				summary: "Send a follow-up to a run",
				description:
					"Send a follow-up to the run in progress on a Work Item. The agent applies it after its current turn ends; with interrupt set, the runner stops the current turn and applies it right away. An ended run can take an answer to its open question. Only the Work Item's owner or steward may send a message.",
			})
			.input(SendWorkAttemptMessageInputSchema)
			.output(WorkAttemptMessageSchema),

		stopAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/attempt-stop",
				summary: "Stop a run",
				description:
					"Ask the run in progress on a Work Item to stop. The runner ends the agent and settles the Attempt as cancelled. Needs a run in progress; only the Work Item's owner or steward may stop it.",
			})
			.input(StopWorkAttemptInputSchema)
			.output(WorkAttemptMessageSchema),

		listAgentRuns: oc
			.route({
				method: "GET",
				path: "/agent-runs",
				summary: "List agent runs started by tedis",
				description:
					"List the agent runs tedis started from a chat, newest first: whether each waits for a runner, runs or has ended, its newest step, the follow-ups not yet applied and, when it is not running, the reason the platform knows. A tedi reads only the runs it started.",
			})
			.input(ListAgentRunsInputSchema)
			.output(ListAgentRunsResultSchema),

		tellPersonAboutAgentRun: oc
			.route({
				method: "POST",
				path: "/{id}/agent-run-update",
				summary: "Tell the person about an agent run",
				description:
					"For the tedi that started an agent run from a chat: send the person an update about that run in the chat it was started from. Only that tedi may call it, and at most once per run in five minutes.",
			})
			.input(TellPersonAboutAgentRunInputSchema)
			.output(TellPersonAboutAgentRunResultSchema),

		settleAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/settle",
				summary: "Settle Work Item attempt",
			})
			.input(
				z.strictObject({
					id: z.uuid(),
					attemptId: z.uuid(),
					outcome: z.enum([
						"landed_unverified",
						"succeeded",
						"failed",
						"rejected",
						"cancelled",
						"expired",
					]),
					summary: z.string().max(10_000).optional(),
					complete: z
						.strictObject({
							expectedWorkItemVersion: z.number().int().positive(),
						})
						.optional()
						.describe(
							"Complete this Work revision in the same write as successful settlement.",
						),
					settlement: WorkAttemptSettlementSchema.optional().describe(
						"Result delivered by the Attempt.",
					),
					metadata: JsonRecordSchema.optional(),
					repositoryLifecycle:
						WorkAttemptRepositoryLifecycleSchema.optional().describe(
							"Secret-free review, canonical GitHub main merge, and live deployment receipt for an Artifacts-backed Attempt.",
						),
					costMicros: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe(
							"Spend committed by this Attempt, in micros. The budget reservation consumes exactly this amount; Omitted, the running total reported by heartbeats is used; with none, a succeeded/failed Attempt consumes its full reservation and a cancelled/expired one releases it.",
						),
				}),
			)
			.output(WorkAttemptCloseoutResultSchema),

		listAttempts: oc
			.route({
				method: "GET",
				path: "/{id}/attempts",
				summary: "List Work Item attempts",
			})
			.input(ListWorkItemAttemptsInputSchema)
			.output(ListWorkItemAttemptsResultSchema),

		reviewAttemptRepository: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/review",
				summary: "Review the immutable repository result of a settled Attempt",
			})
			.input(WorkRepositoryReviewInputSchema)
			.output(WorkRepositoryReviewResultSchema),

		inspectAttemptRepository: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/inspect",
				summary: "Inspect the active governed repository checkout",
			})
			.input(
				RepositoryInspectionRequestSchema.and(
					z.object({ id: z.uuid(), attemptId: z.uuid() }),
				),
			)
			.output(RepositoryInspectionResultSchema),

		initializeRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/initialize",
				summary:
					"Freeze selected repository text files for shared candidate editing",
			})
			.input(InitializeRepositoryCandidateInputSchema)
			.output(RepositoryCandidateResultSchema),
		readRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/read",
				summary: "Read the shared repository candidate without writing Git",
			})
			.input(RepositoryCandidateInputSchema)
			.output(RepositoryCandidateResultSchema),
		submitRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/submit",
				summary: "Submit an OT edit to a shared repository candidate",
			})
			.input(SubmitRepositoryCandidateInputSchema)
			.output(RepositoryCandidateResultSchema),
		sealRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/seal",
				summary:
					"Seal an exact candidate stream position and digest without writing Git",
			})
			.input(SealRepositoryCandidateInputSchema)
			.output(RepositoryCandidateResultSchema),

		applyRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/apply",
				summary:
					"Apply an exact sealed candidate to its isolated repository using the current executor",
			})
			.input(ApplyRepositoryCandidateInputSchema)
			.output(RepositoryCandidatePublicationResultSchema),
		reconcileRepositoryCandidate: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/candidate/reconcile",
				summary:
					"Observe prepared candidate publication without minting credentials or retrying writes",
			})
			.input(RepositoryCandidateInputSchema)
			.output(RepositoryCandidatePublicationResultSchema),

		readAttemptRepository: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/repository/read",
				summary: "Read the immutable Artifacts repository bound to an Attempt",
			})
			.input(
				WorkAttemptRepositoryReadRequestSchema.and(
					z.object({ id: z.uuid(), attemptId: z.uuid() }),
				),
			)
			.output(WorkAttemptRepositoryReadResultSchema),

		submitEvidence: oc
			.route({
				method: "POST",
				path: "/{id}/evidence",
				summary: "Submit Work Item evidence",
				successStatus: 201,
			})
			.input(
				z.object({
					id: z.uuid(),
					attemptId: z.uuid().optional(),
					claimKey: z.string().min(1).max(120),
					kind: WorkEvidenceKindSchema,
					uri: WorkEvidenceUriSchema,
					digest: z.string().max(300).optional(),
					mediaType: z.string().max(200).optional(),
					label: z.string().max(500).optional(),
					metadata: JsonRecordSchema.optional(),
				}),
			)
			.output(ResolvedWorkEvidenceSchema),

		listEvidence: oc
			.route({
				method: "GET",
				path: "/{id}/evidence",
				summary: "List Work Item evidence",
			})
			.input(
				z.object({
					id: z.uuid(),
					cursor: WorkFactoryProjectionCursorSchema.optional().describe(
						"Opaque evidence-ledger cursor; omit to read the newest bounded page.",
					),
					limit: z.number().int().min(1).max(100).default(50),
				}),
			)
			.output(
				z.object({
					data: z.array(ResolvedWorkEvidenceSchema),
					nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
						"Null when the Work Item has no further evidence page.",
					),
				}),
			),

		previewEvidence: oc
			.route({
				method: "GET",
				path: "/{id}/evidence/{evidenceId}/preview",
				summary: "Preview governed Work Item evidence",
			})
			.input(z.object({ id: z.uuid(), evidenceId: z.uuid() }))
			.output(WorkEvidencePreviewSchema),

		wait: oc
			.route({
				method: "POST",
				path: "/wait",
				summary: "Wait for Work changes or an answer",
			})
			.input(WorkWaitInputSchema)
			.output(WorkWaitResultSchema),

		listEvents: oc
			.route({
				method: "GET",
				path: "/{id}/events",
				summary: "List immutable Work Item events",
			})
			.input(
				z.object({
					id: z.uuid(),
					afterSequence: z.number().int().nonnegative().optional(),
					limit: z.number().int().min(1).max(200).default(100),
				}),
			)
			.output(
				z.object({
					events: z.array(WorkEventSchema),
					nextSequence: z.number().int().positive().nullable(),
				}),
			),
	});

export type WorkItemsContract = typeof workItemsContract;
