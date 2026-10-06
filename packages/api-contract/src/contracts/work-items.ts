import "@orpc/openapi/extensions/route";
/**
 * Work Items Contract
 *
 * Provider-neutral issue/work coordination for tedis and humans. External task
 * tools are projections; Work Items are the canonical Tedix object.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
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
	ListWorkItemProjectionsInputSchema,
	ListWorkItemProjectionsResultSchema,
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
	WorkAttemptRepositoryRequestSchema,
	WorkAttemptRepositorySchema,
	WorkAttemptRepositoryLifecycleSchema,
	WorkAdmissionRejectionSchema,
	WorkAdmissionSpecificationRejectionSchema,
	WorkAdmissionSpecificationSchema,
	WorkAdmissionSpecificationReceiptSchema,
	WorkResourcePoolSchema,
	WorkBudgetEnvelopeSchema,
	WorkResourcePoolProjectionSchema,
	WorkBudgetEnvelopeProjectionSchema,
	WorkCaseDependencySchema,
	WorkCaseDetailSchema,
	WorkCaseItemSchema,
	WorkCaseKindSchema,
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
	WorkItemRiskLevelSchema,
	WorkItemReadinessSchema,
	WorkItemReadinessProjectionSchema,
	WorkItemProjectionDirectionSchema,
	WorkItemProjectionSchema,
	WorkItemProjectionStatusSchema,
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
 * `null` means nobody holds it. The field is absent only from a caller reading
 * an older server.
 */
export const WorkItemListRowSchema = WorkItemSchema.extend({
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
						workKind: WorkItemKindSchema.optional(),
						objectiveId: z.uuid().optional(),
						workClass: WorkItemClassSchema.optional(),
						projectId: z.uuid().optional(),
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
				summary: "Create Work case",
				successStatus: 201,
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"Optional project context; cases may instead be objective- or organization-scoped.",
							),
						objectiveId: z
							.uuid()
							.optional()
							.describe("Optional strategic objective context for the case."),
						kind: WorkCaseKindSchema,
						title: z.string().trim().min(1).max(500),
						description: z
							.string()
							.max(10_000)
							.optional()
							.describe(
								"Optional initial narrative; investigating cases may begin title-only.",
							),
						stage: WorkCaseStageSchema.exclude(["closed"])
							.optional()
							.describe(
								"Optional initial stage; omission starts the case in investigating.",
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
							.describe("Optional target date for resolving the case."),
					})
					.strict(),
			)
			.output(WorkCaseSchema),

		listCases: oc
			.route({
				method: "GET",
				path: "/cases",
				summary: "List Work cases",
			})
			.input(
				z
					.object({
						projectId: z
							.uuid()
							.optional()
							.describe(
								"Optional project filter; omission includes cases across the organization.",
							),
						stages: z
							.array(WorkCaseStageSchema)
							.min(1)
							.max(5)
							.optional()
							.describe(
								"Optional stage filter; omission includes every case stage.",
							),
						cursor: WorkFactoryProjectionCursorSchema.optional().describe(
							"Opaque case timeline cursor; omit to start at the newest page.",
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
							"Null when the bounded case list has no further page.",
						),
					})
					.strict(),
			),

		getCase: oc
			.route({
				method: "GET",
				path: "/cases/{caseId}",
				summary: "Get Work case detail",
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
						dependencyCursor: z
							.uuid()
							.optional()
							.describe(
								"Opaque dependency cursor; omit to read the first bounded dependency page.",
							),
						dependencyLimit: z.number().int().min(1).max(100).default(50),
					})
					.strict(),
			)
			.output(WorkCaseDetailSchema),

		updateCase: oc
			.route({
				method: "PATCH",
				path: "/cases/{caseId}",
				summary: "Update Work case",
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
							.describe("Omit to preserve the current case title."),
						description: z
							.string()
							.max(10_000)
							.nullable()
							.optional()
							.describe("Omit to preserve the narrative; null clears it."),
						stage: WorkCaseStageSchema.optional().describe(
							"Omit to preserve the current case stage.",
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
					})
					.strict(),
			)
			.output(WorkCaseSchema),

		attachCaseWorkItem: oc
			.route({
				method: "POST",
				path: "/cases/{caseId}/work-items",
				summary: "Attach Work Item to case",
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
								"Optional explanation of how the attached Work Item informs the case.",
							),
					})
					.strict(),
			)
			.output(WorkCaseItemSchema),

		addCaseDependency: oc
			.route({
				method: "POST",
				path: "/cases/dependencies",
				summary: "Add Work case dependency",
				successStatus: 201,
			})
			.input(z.object({ fromCaseId: z.uuid(), toCaseId: z.uuid() }).strict())
			.output(WorkCaseDependencySchema),

		getById: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get Work Item",
			})
			.input(z.object({ id: z.uuid() }))
			.output(
				z.object({
					workItem: WorkItemSchema,
					comments: z.array(WorkItemCommentSchema),
					evidence: z.array(ResolvedWorkEvidenceSchema),
					evidenceNextCursor:
						WorkFactoryProjectionCursorSchema.nullable().describe(
							"Null when the exact Work Item evidence ledger has no further bounded page.",
						),
					projections: z.array(WorkItemProjectionSchema),
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

		listProjections: oc
			.route({
				method: "GET",
				path: "/projections",
				summary: "List external-source links across the board",
			})
			.input(ListWorkItemProjectionsInputSchema)
			.output(ListWorkItemProjectionsResultSchema),

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
				summary: "List recent org board events",
			})
			.input(ListWorkActivityInputSchema)
			.output(ListWorkActivityResultSchema),

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

		updateSpecification: oc
			.route({
				method: "PATCH",
				path: "/{id}",
				summary: "Update Work Item specification",
				description:
					"Update descriptive Work Item specification fields. Disposition, readiness, attempts, and evidence are changed only through their dedicated operations.",
			})
			.input(
				z.object({
					id: z.uuid(),
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
					startAt: z.iso
						.datetime()
						.nullable()
						.optional()
						.describe("Omit to preserve the planned start; null clears it."),
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
						scopeType: z.enum(["organization", "project", "case", "work_item"]),
						scopeId: z.uuid(),
						limitMicros: z.number().int().nonnegative(),
						reservationMicros: z.number().int().nonnegative(),
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
				}),
			)
			.output(WorkItemSchema),

		complete: oc
			.route({
				method: "POST",
				path: "/{id}/complete",
				summary: "Complete Work Item",
			})
			.input(z.object({ id: z.uuid() }))
			.output(WorkItemSchema),

		addComment: oc
			.route({
				method: "POST",
				path: "/{id}/comments",
				summary: "Add Work Item comment",
				successStatus: 201,
			})
			.input(
				z.object({
					id: z.uuid(),
					body: z.string().min(1).max(10000),
					metadata: JsonRecordSchema.optional(),
				}),
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

		settleAttempt: oc
			.route({
				method: "POST",
				path: "/{id}/attempts/{attemptId}/settle",
				summary: "Settle Work Item attempt",
			})
			.input(
				z.object({
					id: z.uuid(),
					attemptId: z.uuid(),
					outcome: z.enum(["succeeded", "failed", "cancelled", "expired"]),
					summary: z.string().max(10_000).optional(),
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
			.output(
				z.object({ workItem: WorkItemSchema, attempt: WorkAttemptSchema }),
			),

		listAttempts: oc
			.route({
				method: "GET",
				path: "/{id}/attempts",
				summary: "List Work Item attempts",
			})
			.input(
				z.object({
					id: z.uuid(),
					cursor: WorkFactoryProjectionCursorSchema.optional().describe(
						"Opaque attempt-ledger cursor; omit to read the newest bounded page.",
					),
					limit: z.number().int().min(1).max(100).default(50),
				}),
			)
			.output(
				z.object({
					data: z.array(WorkAttemptSchema),
					nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
						"Null when the Work Item has no further attempt page.",
					),
				}),
			),

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

		upsertProjection: oc
			.route({
				method: "PUT",
				path: "/{id}/projections/{provider}",
				summary: "Upsert Work Item projection",
			})
			.input(
				z.object({
					id: z.uuid(),
					provider: z.string().min(1).max(100),
					direction: WorkItemProjectionDirectionSchema.default("projection"),
					status: WorkItemProjectionStatusSchema.default("pending"),
					externalId: z.string().max(500).optional(),
					externalUrl: z.string().max(2000).optional(),
					externalProjectId: z.string().max(500).optional(),
					externalSectionId: z.string().max(500).optional(),
					lastSyncedAt: z.string().max(100).optional(),
					lastError: z.string().max(5000).nullable().optional(),
					syncCursor: z.string().max(1000).optional(),
					providerState: JsonRecordSchema.optional(),
				}),
			)
			.output(WorkItemProjectionSchema),
	});

export type WorkItemsContract = typeof workItemsContract;
