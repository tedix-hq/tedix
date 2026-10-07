import * as z from "zod";
import { JsonValueSchema } from "./common";
import {
	ExecutionCapabilitySchema,
	ExecutionRequirementSchema,
	ExecutionSurfaceSchema,
} from "./execution-evidence";
import { OwnedChannelAuthorizationReceiptSchema } from "./mcp-governance";

const JsonRecordSchema = z.record(z.string(), JsonValueSchema);

export const WorkPrincipalTypeSchema = z.enum([
	"user",
	"tedi",
	"external_agent",
	"team",
	"system",
]);

/** Principals whose active authenticated credential may author Work writes. */
export const CredentialWorkActorTypeSchema = WorkPrincipalTypeSchema.exclude([
	"team",
	"system",
]);

/** Durable business disposition. Execution and review state live on attempts
 * and evidence, never on the Work Item specification. */
export const WorkItemDispositionSchema = z.enum([
	"proposed",
	"accepted",
	"completed",
	"cancelled",
]);
export type WorkItemDisposition = z.infer<typeof WorkItemDispositionSchema>;

/** Open, adapter-neutral classification used for routing and policy. */
export const WorkItemKindSchema = z.enum([
	"coding",
	"research",
	"document",
	"design",
	"browser",
	"operations",
	"communication",
	"finance",
	"legal",
	"stewardship",
	"incident",
	"other",
]);
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;

/** Open adapter key: commit, document, receipt, deployment, citation bundle, etc. */
export const WorkEvidenceKindSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z][a-z0-9_]*$/);

const RAW_TEDI_DELIVERABLE_R2_URI =
	/^r2:\/\/[^/]+\/[^/]+\/artifacts\/deliverable(?:\/|$)/i;

/**
 * R2 is an implementation detail, not a portable artifact locator. A reviewer
 * can resolve a canonical `artifact://<id>` URI through the organization-bound
 * artifact ledger, while a raw deliverable object path has no artifact id and
 * cannot be independently inspected safely.
 */
export const WorkEvidenceUriSchema = z
	.string()
	.trim()
	.min(1)
	.max(2_000)
	.refine((uri) => !RAW_TEDI_DELIVERABLE_R2_URI.test(uri), {
		message:
			"Tedi deliverable R2 paths are not valid Work evidence locators; submit the canonical artifact://<artifact-id> URI instead",
	});

export const WorkItemRiskLevelSchema = z.enum([
	"low",
	"medium",
	"high",
	"critical",
]);

/**
 * Parses every contract ever written, including the older shape whose
 * `evidenceKinds`/`minimumAcceptedEvidence`/`requiresIndependentReview` fields
 * are still stored on live rows. Those fields are no longer consulted — see
 * `docs/decisions/minimal-gates-over-pre-proof.md` — but this schema is an
 * oRPC `.output()` schema, so a rejected stored contract would turn one past
 * write into a permanent read failure. It only ever widens: every legacy field
 * is still declared, and the object stays strict because the previous strict
 * schema means no stored contract can carry an unknown key.
 */
export const WorkItemAcceptanceContractSchema = z
	.object({
		version: z.literal(1),
		doneLooksLike: z
			.string()
			.max(2_000)
			.optional()
			.describe(
				"Plain-language statement of the accepted outcome. Replaces the mechanical claim/evidence shape.",
			),
	})
	.strict();

export const WorkItemReadinessStateSchema = z.enum([
	"ready",
	"not_accepted",
	"purpose_blocked",
	"dependencies_blocked",
	"capability_blocked",
	"approval_blocked",
	"budget_blocked",
	"resource_blocked",
	"evaluation_required",
	"already_running",
	"terminal",
]);

/**
 * Why `startAttempt` refused admission. Carried as the `data` of its typed
 * CONFLICT error so a caller can branch on the code instead of the message.
 */
export const WorkAdmissionRejectionSchema = z
	.object({
		rejectionCode: z.enum([
			"not_accepted",
			"purpose_blocked",
			"dependencies_blocked",
			"capability_blocked",
			"approval_blocked",
			"resource_blocked",
			"budget_blocked",
			"already_running",
			"evaluation_required",
			"stale_specification",
		]),
		reason: z.string().min(1).max(2_000),
	})
	.strict();
export type WorkAdmissionRejection = z.infer<
	typeof WorkAdmissionRejectionSchema
>;

/** `replaceAdmissionSpecification` names resource keys that have no enabled pool. */
export const WorkAdmissionSpecificationRejectionSchema = z
	.object({
		missingResourceKeys: z.array(z.string().min(1).max(300)).min(1).max(100),
	})
	.strict();

export const WorkItemReadinessSchema = z.object({
	workItemId: z.uuid(),
	state: WorkItemReadinessStateSchema,
	ready: z.boolean(),
	reasons: z.array(
		z.object({
			code: WorkItemReadinessStateSchema.exclude(["ready"]),
			detail: z.string().min(1).max(2_000),
		}),
	),
	derivedAt: z.iso.datetime(),
	gates: z.array(
		z.object({
			gate: z.enum([
				"disposition",
				"purpose",
				"dependencies",
				"capabilities",
				"approvals",
				"risk",
				"budget",
				"resources",
				"attempt",
			]),
			evaluation: z.enum(["passed", "failed", "unknown"]),
			detail: z.string().min(1).max(2_000),
		}),
	),
});

export const WorkAdmissionSpecificationSchema = z
	.object({
		resources: z
			.array(
				z
					.object({
						resourceKey: z.string().trim().min(1).max(300),
						quantity: z.number().int().positive(),
					})
					.strict(),
			)
			.max(100),
		budget: z
			.object({
				limitMicros: z.number().int().nonnegative(),
				reservationMicros: z.number().int().nonnegative(),
			})
			.refine(
				(value) => value.reservationMicros <= value.limitMicros,
				"reservation must fit the envelope",
			)
			.nullable()
			.describe(
				"Nullable when the Work Item has no item-specific budget reservation requirement.",
			),
	})
	.strict();

/** A normalized admission specification together with both optimistic-lock
 * coordinates required to replace it without losing a concurrent update. */
export const WorkAdmissionSpecificationReceiptSchema = z
	.object({
		workItemId: z.uuid(),
		workItemVersion: z.number().int().positive(),
		admissionSpecRevision: z.string().trim().min(1).max(200),
		resources: WorkAdmissionSpecificationSchema.shape.resources,
		budget: WorkAdmissionSpecificationSchema.shape.budget,
	})
	.strict();

export const WorkResourcePoolSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	resourceKey: z.string(),
	allocationMode: z.enum(["exclusive", "capacity"]),
	capacity: z.number().int().positive(),
	ownerRef: z
		.string()
		.nullable()
		.describe(
			"Nullable when the resource pool has no external owner reference.",
		),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso
		.datetime()
		.nullable()
		.describe("Nullable until the resource pool is changed after creation."),
	version: z.number().int().positive(),
});
export const WorkBudgetEnvelopeSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	scopeType: z.enum(["organization", "project", "case", "work_item"]),
	scopeId: z.uuid(),
	currency: z.literal("USD"),
	limitMicros: z.number().int().nonnegative(),
	reservationMicros: z.number().int().nonnegative(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso
		.datetime()
		.nullable()
		.describe("Nullable until the budget envelope is changed after creation."),
	version: z.number().int().positive(),
});
export const WorkResourcePoolProjectionSchema = z.object({
	pool: WorkResourcePoolSchema,
	activeReserved: z.number().int().nonnegative(),
	effectiveAvailable: z.number().int().nonnegative(),
	holders: z
		.array(
			z.object({
				attemptId: z.uuid(),
				workItemId: z.uuid(),
				workTitle: z.string(),
				executorType: z.enum(["tedi", "external_agent"]),
				executorId: z.string(),
				externalSessionKey: z.string().nullable(),
				quantity: z.number().int().positive(),
				expiresAt: z.iso.datetime(),
			}),
		)
		.max(8)
		.optional(),
	holdersTruncated: z.boolean().optional(),
});
export const WorkBudgetEnvelopeProjectionSchema = z.object({
	envelope: WorkBudgetEnvelopeSchema,
	committedMicros: z.number().int().nonnegative(),
	availableMicros: z.number().int().nonnegative(),
});

export const WorkAttemptStatusSchema = z.enum([
	"queued",
	"running",
	"waiting",
	"retrying",
	"failed",
	"expired",
	"finished",
	"cancelled",
]);

export const WorkAttemptOutcomeSchema = z.enum([
	"succeeded",
	"failed",
	"cancelled",
	"expired",
]);

const ArtifactsRepositoryNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._-]+$/);

/** Opt-in repository isolation requested when an Attempt starts. */
export const WorkAttemptRepositoryRequestSchema = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.literal("create"),
		})
		.strict(),
	z
		.object({
			mode: z.literal("fork"),
			sourceRepositoryName: ArtifactsRepositoryNameSchema,
			sourceRef: z.string().trim().min(1).max(300).default("HEAD"),
			expectedBaseRevision: z
				.string()
				.regex(/^[a-f0-9]{40}$/)
				.optional()
				.describe(
					"Optional exact source commit fence; a changed source ref fails closed.",
				),
		})
		.strict(),
]);
export type WorkAttemptRepositoryRequest = z.infer<
	typeof WorkAttemptRepositoryRequestSchema
>;

/** Secret-free Artifacts provenance persisted on an Attempt and returned by start. */
export const WorkAttemptRepositorySchema = z
	.object({
		version: z.literal(1),
		provider: z.literal("cloudflare_artifacts"),
		status: z.enum(["ready", "unavailable"]),
		mode: z.enum(["create", "fork"]),
		repositoryName: ArtifactsRepositoryNameSchema,
		repositoryId: z.string().trim().min(1).max(300).nullable(),
		remote: z.url().nullable(),
		defaultBranch: z.string().trim().min(1).max(300).nullable(),
		sourceRepositoryName: ArtifactsRepositoryNameSchema.nullable(),
		sourceRef: z.string().trim().min(1).max(300).nullable(),
		baseRevision: z
			.string()
			.regex(/^[a-f0-9]{40}$/)
			.nullable(),
		workItemId: z.uuid(),
		workItemVersion: z.number().int().positive(),
		admissionSpecRevision: z.string().trim().min(1).max(200),
		admissionId: z.uuid(),
		attemptId: z.uuid(),
		observedAt: z.iso.datetime(),
		reason: z.string().trim().min(1).max(2_000).nullable(),
	})
	.strict();
export type WorkAttemptRepository = z.infer<typeof WorkAttemptRepositorySchema>;

const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

/** Settlement-time claims that carry an Artifacts result into canonical review. */
export const WorkAttemptRepositoryLifecycleSchema = z
	.object({
		version: z.literal(1),
		headRevision: GitRevisionSchema,
		review: z
			.object({
				status: z.enum(["not_reviewed", "approved", "changes_requested"]),
				evidenceRef: z.string().trim().min(1).max(2_000).nullable(),
				reviewedAt: z.iso.datetime().nullable(),
			})
			.strict(),
		merge: z
			.object({
				status: z.enum(["not_merged", "merged"]),
				canonicalLedger: z.literal("github_main").nullable(),
				repository: z.string().trim().min(1).max(300).nullable(),
				commitSha: GitRevisionSchema.nullable(),
				mergedAt: z.iso.datetime().nullable(),
			})
			.strict(),
		deployment: z
			.object({
				status: z.enum(["not_deployed", "deployed", "failed"]),
				surface: z.string().trim().min(1).max(200).nullable(),
				revision: z.string().trim().min(1).max(300).nullable(),
				evidenceRef: z.string().trim().min(1).max(2_000).nullable(),
				observedAt: z.iso.datetime().nullable(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.review.status !== "not_reviewed" &&
			(!value.review.evidenceRef || !value.review.reviewedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["review"],
				message: "A completed review requires evidenceRef and reviewedAt",
			});
		}
		if (
			value.review.status === "not_reviewed" &&
			(value.review.evidenceRef || value.review.reviewedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["review"],
				message: "An unreviewed result cannot carry a review receipt",
			});
		}
		if (
			value.merge.status === "merged" &&
			(!value.merge.canonicalLedger ||
				!value.merge.repository ||
				!value.merge.commitSha ||
				!value.merge.mergedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["merge"],
				message: "A merge requires the canonical GitHub main receipt",
			});
		}
		if (
			value.merge.status === "not_merged" &&
			(value.merge.canonicalLedger ||
				value.merge.repository ||
				value.merge.commitSha ||
				value.merge.mergedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["merge"],
				message: "An unmerged result cannot carry a merge receipt",
			});
		}
		if (
			value.deployment.status !== "not_deployed" &&
			(!value.deployment.surface ||
				!value.deployment.revision ||
				!value.deployment.evidenceRef ||
				!value.deployment.observedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["deployment"],
				message: "A deployment result requires a live receipt",
			});
		}
		if (
			value.deployment.status === "not_deployed" &&
			(value.deployment.surface ||
				value.deployment.revision ||
				value.deployment.evidenceRef ||
				value.deployment.observedAt)
		) {
			context.addIssue({
				code: "custom",
				path: ["deployment"],
				message: "An undeployed result cannot carry a deployment receipt",
			});
		}
	});
export type WorkAttemptRepositoryLifecycle = z.infer<
	typeof WorkAttemptRepositoryLifecycleSchema
>;

export const WorkAttemptSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	executorType: z.enum(["tedi", "external_agent"]),
	executorId: z.string().min(1).max(300),
	executorSessionId: z.string().max(300).nullable(),
	externalSessionKey: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Server-stamped harness session key; tedi attempts do not have one.",
		),
	runtimeState: WorkAttemptStatusSchema,
	outcome: WorkAttemptOutcomeSchema.nullable(),
	runId: z.string().max(2_000).nullable(),
	admissionId: z
		.uuid()
		.nullable()
		.describe(
			"Nullable only for historical attempts created before admission receipts were mandatory.",
		),
	attemptNumber: z.number().int().positive(),
	startedAt: z.iso.datetime(),
	heartbeatAt: z.iso.datetime(),
	expiresAt: z.iso.datetime().nullable(),
	finishedAt: z.iso.datetime().nullable(),
	summary: z.string().max(10_000).nullable(),
	metadata: JsonRecordSchema,
});

export const WorkEvidenceDispositionSchema = z.enum([
	"pending",
	"accepted",
	"rejected",
	"superseded",
]);

export const WorkEvidenceSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	attemptId: z.uuid().nullable(),
	claimKey: z.string().min(1).max(120),
	kind: WorkEvidenceKindSchema,
	uri: z.string().min(1).max(2_000),
	digest: z.string().max(300).nullable(),
	mediaType: z.string().max(200).nullable(),
	label: z.string().max(500).nullable(),
	disposition: WorkEvidenceDispositionSchema,
	submittedByType: WorkPrincipalTypeSchema,
	submittedById: z.string().min(1).max(300),
	submittedBySessionId: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Nullable when the submitting principal has no explicit session identity.",
		),
	submittedAt: z.iso.datetime(),
	reviewedByType: WorkPrincipalTypeSchema.nullable(),
	reviewedById: z.string().max(300).nullable(),
	reviewedBySessionId: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"Nullable until review, or when the reviewer has no explicit session identity.",
		),
	reviewedAt: z.iso.datetime().nullable(),
	reviewReason: z.string().max(10_000).nullable(),
	version: z.number().int().positive(),
	metadata: JsonRecordSchema,
});

export const WorkEvidenceReferenceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("artifact"),
		status: z.enum([
			"available",
			"unavailable",
			"unverified_legacy",
			"ambiguous",
		]),
		canonicalUri: z
			.string()
			.nullable()
			.describe(
				"Null when no unambiguous governed artifact identity resolved.",
			),
		artifactId: z
			.string()
			.nullable()
			.describe(
				"Null when the opaque artifact identity is missing or ambiguous.",
			),
		digest: z
			.string()
			.nullable()
			.describe(
				"Null when immutable artifact bytes or a canonical bundle manifest are not verified.",
			),
		mediaType: z
			.string()
			.nullable()
			.describe("Null when no governed artifact representation resolved."),
		reason: z
			.string()
			.nullable()
			.describe(
				"Null when access is available; otherwise the fail-closed resolution reason.",
			),
		bundleDigestKind: z
			.enum(["bytes", "manifest"])
			.nullable()
			.describe(
				"Null for unavailable or legacy artifacts; manifest distinguishes bundle identity from entry bytes.",
			),
	}),
	z.object({
		kind: z.literal("output_revision"),
		status: z.enum(["available", "unavailable"]),
		canonicalUri: z
			.string()
			.nullable()
			.describe("Null when the exact output revision no longer resolves."),
		outputId: z
			.uuid()
			.nullable()
			.describe("Null when the owning output does not resolve in the tenant."),
		revisionId: z
			.uuid()
			.nullable()
			.describe("Null when the exact immutable revision does not resolve."),
		digest: z
			.string()
			.nullable()
			.describe(
				"Null when exact revision content is unavailable for server hashing.",
			),
		mediaType: z
			.string()
			.nullable()
			.describe("Null when no exact output representation resolved."),
		reason: z
			.string()
			.nullable()
			.describe(
				"Null when current source access is available; otherwise the fail-closed reason.",
			),
	}),
	z.object({
		kind: z.literal("external_https"),
		status: z.literal("unverified"),
		href: z.url(),
		digest: z.null(),
		reason: z.literal("unverified_external"),
	}),
	z.object({
		kind: z.literal("unsupported"),
		status: z.literal("unavailable"),
		digest: z.null(),
		reason: z.string(),
	}),
]);

export const ResolvedWorkEvidenceSchema = WorkEvidenceSchema.extend({
	reference: WorkEvidenceReferenceSchema,
});

export const WorkEvidencePreviewSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("available"),
		canonicalUri: z.string(),
		mediaType: z.string(),
		digest: z.string(),
		text: z.string().max(51_200),
		truncated: z.boolean(),
	}),
	z.object({
		status: z.literal("unavailable"),
		reason: z.string(),
	}),
	z.object({
		status: z.literal("external"),
		href: z.url(),
		trust: z.literal("unverified_external"),
	}),
]);

export const WorkEventSchema = z.object({
	sequence: z.number().int().positive(),
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	attemptId: z.uuid().nullable(),
	eventType: z.string().trim().min(1).max(100),
	actorType: WorkPrincipalTypeSchema,
	actorId: z.string().max(300),
	actorSessionId: z.string().max(300).nullable(),
	payload: JsonRecordSchema,
	occurredAt: z.iso.datetime(),
});

export const WorkFactoryProjectionCursorSchema = z
	.object({
		at: z.iso.datetime(),
		id: z.uuid(),
	})
	.strict();

export const WorkFactoryItemSummarySchema = z
	.object({
		id: z.uuid(),
		title: z.string(),
		disposition: WorkItemDispositionSchema,
		workKind: WorkItemKindSchema,
		riskLevel: WorkItemRiskLevelSchema,
		priority: z.enum(["critical", "high", "medium", "low"]),
		projectId: z
			.uuid()
			.nullable()
			.describe(
				"Nullable for organization-scoped Work that is not filed in a project.",
			),
		accountableOwnerType: z
			.enum(["user", "tedi", "team", "system"])
			.nullable()
			.describe("Nullable while proposed Work has no accountable owner."),
		accountableOwnerId: z
			.string()
			.nullable()
			.describe(
				"Nullable while proposed Work has no accountable owner identity.",
			),
	})
	.strict();

export const WorkQueueItemSummarySchema = WorkFactoryItemSummarySchema.extend({
	createdAt: z.iso.datetime(),
	updatedAt: z.iso
		.datetime()
		.nullable()
		.describe("Nullable until the accepted Work Item is first updated."),
}).strict();

export const WorkItemReadinessProjectionSchema = z
	.object({
		workItem: WorkQueueItemSummarySchema,
		readiness: WorkItemReadinessSchema,
	})
	.strict();

export const WorkAttemptProjectionSchema = z
	.object({
		attempt: WorkAttemptSchema,
		workItem: WorkFactoryItemSummarySchema,
	})
	.strict();

export const WorkRecoverySignalSchema = z.enum([
	"dependencies_blocked",
	"latest_attempt_failed",
	"latest_attempt_expired",
	"attempt_lease_elapsed",
]);

export const WorkRecoveryProjectionSchema = WorkFactoryItemSummarySchema.extend(
	{
		sortAt: z.iso.datetime(),
		signals: z.array(WorkRecoverySignalSchema).min(1),
		blockingDependencyCount: z.number().int().nonnegative(),
		latestAttemptId: z
			.uuid()
			.nullable()
			.describe("Null when the Work Item has never started an attempt."),
		latestAttemptState: WorkAttemptStatusSchema.nullable().describe(
			"Null when no latest attempt exists.",
		),
		latestAttemptOutcome: WorkAttemptOutcomeSchema.nullable().describe(
			"Null while the latest attempt is unsettled or absent.",
		),
		latestAttemptFinishedAt: z.iso
			.datetime()
			.nullable()
			.describe("Null while the latest attempt is unfinished or absent."),
		latestAttemptExpiresAt: z.iso
			.datetime()
			.nullable()
			.describe(
				"Null when the latest attempt is absent or has no historical lease expiry.",
			),
	},
).strict();

const WorkFactoryPageInputSchema = z
	.object({
		cursor: WorkFactoryProjectionCursorSchema.optional().describe(
			"Opaque projection cursor; omit to start at the newest bounded page.",
		),
		limit: z.coerce.number().int().min(1).max(100).default(50),
	})
	.strict();

export const ListWorkAttemptProjectionInputSchema =
	WorkFactoryPageInputSchema.extend({
		projectId: z
			.uuid()
			.optional()
			.describe(
				"Optional project filter; omission includes attempts from every project.",
			),
		workItemId: z
			.uuid()
			.optional()
			.describe(
				"Optional Work Item filter for a single item's attempt ledger.",
			),
		runtimeStates: z
			.array(WorkAttemptStatusSchema)
			.min(1)
			.max(8)
			.optional()
			.describe(
				"Optional runtime-state filter; omission includes every attempt state.",
			),
		outcomes: z
			.array(WorkAttemptOutcomeSchema)
			.min(1)
			.max(4)
			.optional()
			.describe(
				"Optional settled-outcome filter; omission includes settled and active attempts.",
			),
		executorType: z
			.enum(["tedi", "external_agent"])
			.optional()
			.describe(
				"Optional executor-kind filter; omission includes every supported executor.",
			),
	}).strict();

export const ListWorkAttemptProjectionResultSchema = z
	.object({
		data: z.array(WorkAttemptProjectionSchema),
		nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
			"Null when the bounded attempt projection has no further page.",
		),
		hasMore: z.boolean(),
	})
	.strict();

export const ListWorkRecoveryProjectionInputSchema =
	WorkFactoryPageInputSchema.extend({
		projectId: z
			.uuid()
			.optional()
			.describe(
				"Optional project filter; omission includes recoverable Work from every project.",
			),
		workKind: WorkItemKindSchema.optional().describe(
			"Optional Work-kind filter for recovery triage.",
		),
		riskLevel: WorkItemRiskLevelSchema.optional().describe(
			"Optional risk filter for recovery triage.",
		),
		priority: z
			.enum(["critical", "high", "medium", "low"])
			.optional()
			.describe("Optional priority filter for recovery triage."),
		signal: WorkRecoverySignalSchema.optional().describe(
			"Optional recovery-signal filter; omission includes every recovery reason.",
		),
	}).strict();

export const ListWorkRecoveryProjectionResultSchema = z
	.object({
		data: z.array(WorkRecoveryProjectionSchema),
		nextCursor: WorkFactoryProjectionCursorSchema.nullable().describe(
			"Null when the bounded recovery projection has no further page.",
		),
		hasMore: z.boolean(),
		observedAt: z.iso.datetime(),
	})
	.strict();

/** Rolled-up business disposition over a subtree/project. */
export const WorkItemAggregateDispositionSchema = z.enum([
	"empty",
	"proposed",
	"accepted",
	"completed",
	"cancelled",
]);
export type WorkItemAggregateDisposition = z.infer<
	typeof WorkItemAggregateDispositionSchema
>;

export const WorkItemPrioritySchema = z.enum([
	"critical",
	"high",
	"medium",
	"low",
]);
export type WorkItemPriority = z.infer<typeof WorkItemPrioritySchema>;

/**
 * Purpose classification for canonical Work Items. `objective` is the normal
 * path; maintenance/incident/hygiene are time-bounded operational exceptions.
 */
export const WorkItemClassSchema = z.enum([
	"objective",
	"maintenance",
	"incident",
	"hygiene",
]);
export type WorkItemClass = z.infer<typeof WorkItemClassSchema>;

export const WorkItemOwnerTypeSchema = z.enum([
	"user",
	"tedi",
	"team",
	"system",
]);
export type WorkItemOwnerType = z.infer<typeof WorkItemOwnerTypeSchema>;

export const WorkItemCommentAuthorTypeSchema = z.enum([
	"user",
	"tedi",
	"external_agent",
	"system",
]);

export const WorkItemExecutorTypeSchema = z.enum(["tedi", "external_agent"]);
export type WorkItemExecutorType = z.infer<typeof WorkItemExecutorTypeSchema>;
export type WorkItemCommentAuthorType = z.infer<
	typeof WorkItemCommentAuthorTypeSchema
>;

export const WorkItemRelationTypeSchema = z.enum([
	"blocks",
	"duplicates",
	"references",
]);
export type WorkItemRelationType = z.infer<typeof WorkItemRelationTypeSchema>;

export const WorkItemProjectionDirectionSchema = z.enum([
	"source",
	"projection",
	"sync",
]);
export type WorkItemProjectionDirection = z.infer<
	typeof WorkItemProjectionDirectionSchema
>;

export const WorkItemProjectionStatusSchema = z.enum([
	"pending",
	"synced",
	"failed",
	"stale",
]);
export type WorkItemProjectionStatus = z.infer<
	typeof WorkItemProjectionStatusSchema
>;

export const WorkItemCapabilityToolRefSchema = z
	.object({
		appSlug: z.string().trim().min(1).max(160),
		toolId: z.string().trim().min(1).max(200),
	})
	.strict();
export type WorkItemCapabilityToolRef = z.infer<
	typeof WorkItemCapabilityToolRefSchema
>;

export const WorkItemCapabilityConnectionRefSchema = z
	.object({
		providerId: z.string().trim().min(1).max(160),
		tokenScope: z.enum(["tenant", "user", "either"]).default("either"),
		scopes: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
	})
	.strict();
export type WorkItemCapabilityConnectionRef = z.infer<
	typeof WorkItemCapabilityConnectionRefSchema
>;

/**
 * Versioned, config-driven execution request stored canonically at
 * `work_items.metadata.capabilityBundle`. It names requirements only; the
 * preflight resolver remains the authority for whether the selected tedi can
 * satisfy them under its current runtime, assignments, connections, and policy.
 */
export const WorkItemCapabilityBundleSchema = z
	.object({
		version: z.literal(1),
		targetTediId: z.uuid().optional(),
		requiredCapabilities: z
			.array(ExecutionCapabilitySchema)
			.max(ExecutionCapabilitySchema.options.length)
			.default([]),
		preferredSurface: ExecutionSurfaceSchema.optional(),
		prohibitedSurfaces: z.array(ExecutionSurfaceSchema).max(3).default([]),
		tools: z.array(WorkItemCapabilityToolRefSchema).max(50).default([]),
		connections: z
			.array(WorkItemCapabilityConnectionRefSchema)
			.max(25)
			.default([]),
	})
	.strict()
	.superRefine((value, ctx) => {
		const duplicate = (values: string[]) =>
			values.find((entry, index) => values.indexOf(entry) !== index);
		const duplicateCapability = duplicate(value.requiredCapabilities);
		if (duplicateCapability) {
			ctx.addIssue({
				code: "custom",
				path: ["requiredCapabilities"],
				message: `Duplicate capability: ${duplicateCapability}`,
			});
		}
		const duplicateSurface = duplicate(value.prohibitedSurfaces);
		if (duplicateSurface) {
			ctx.addIssue({
				code: "custom",
				path: ["prohibitedSurfaces"],
				message: `Duplicate prohibited surface: ${duplicateSurface}`,
			});
		}
		const duplicateTool = duplicate(
			value.tools.map((tool) => `${tool.appSlug}:${tool.toolId}`),
		);
		if (duplicateTool) {
			ctx.addIssue({
				code: "custom",
				path: ["tools"],
				message: `Duplicate tool requirement: ${duplicateTool}`,
			});
		}
		const duplicateConnection = duplicate(
			value.connections.map(
				(connection) =>
					`${connection.providerId}:${connection.tokenScope}:${connection.scopes.join(",")}`,
			),
		);
		if (duplicateConnection) {
			ctx.addIssue({
				code: "custom",
				path: ["connections"],
				message: `Duplicate connection requirement: ${duplicateConnection}`,
			});
		}
	});
export type WorkItemCapabilityBundle = z.infer<
	typeof WorkItemCapabilityBundleSchema
>;

/**
 * The exact version a dependency was pinned to, or the version that actually
 * resolved from a read. Every field is nullable because the pinning primitives
 * differ per kind: skills pin `id` + `revision` (+ an optional content
 * `digest`), policy packs and runtime profiles pin `id` + `version`, and
 * connection providers carry no version at all.
 *
 * A `resolvedPin` is only ever populated from a row that was actually read. It
 * is never inferred from the declaration: when nothing resolved it stays null.
 */
export const ExecutionPreflightPinSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(200)
			.nullable()
			.describe(
				"Row identity of the pinned dependency; null for kinds addressed by slug+scope rather than id, and on a declared pin whose resolution found nothing",
			),
		revision: z
			.number()
			.int()
			.nonnegative()
			.nullable()
			.describe(
				"The pinned revision/version counter; null when the kind carries no version (connection providers) or the resolved row has none",
			),
		digest: z
			.string()
			.min(1)
			.max(200)
			.nullable()
			.describe("Content digest (lowercase sha-256 hex) when the kind has one"),
	})
	.strict();
export type ExecutionPreflightPin = z.infer<typeof ExecutionPreflightPinSchema>;

/**
 * One resolved dependency decision. This is the single preflight vocabulary in
 * the platform: Work Item dispatch preflight, governed gadget dispatch, and
 * Blueprint instantiation preflight all emit this exact shape.
 *
 * Verdict semantics:
 * - `allowed` — the requirement resolved (for a pinned kind: the EXACT pin
 *   resolved, id and revision both matching).
 * - `denied` — something resolved, but authority refuses it (inactive, archived,
 *   or the identifier is owned by a different row than the one pinned).
 * - `missing` — nothing resolved the requirement in this organization.
 * - `incompatible` — the right row resolved, but the pinned version moved or the
 *   resolved capability cannot satisfy the declared constraint.
 * - `consent_required` — resolvable, but a human-present consent round trip is
 *   required before the credential exists (Descope Adaptive Connect).
 * - `approval_required` — resolvable and connected, but policy requires a human
 *   approval before dispatch.
 * - `not_required` — the requirement does not apply on this path.
 */
export const WorkItemExecutionPreflightDecisionSchema = z.object({
	kind: z.enum([
		"assignment",
		"runtime_profile",
		"policy",
		"app_assignment",
		"tool",
		"connection",
		"workspace_resource",
		"workstation",
		"browser",
		"skill",
		"policy_pack",
		"model",
		"layout",
		"output",
	]),
	subject: z.string().min(1),
	verdict: z.enum([
		"allowed",
		"denied",
		"missing",
		"incompatible",
		"consent_required",
		"approval_required",
		"not_required",
	]),
	reason: z.string().min(1),
	declaredPin: ExecutionPreflightPinSchema.nullish().describe(
		"The exact version pin the requirement declared; omitted for kinds that carry no pin",
	),
	resolvedPin: ExecutionPreflightPinSchema.nullish().describe(
		"What actually resolved from a real read; null when nothing resolved — never inferred from the declaration",
	),
});
export type WorkItemExecutionPreflightDecision = z.infer<
	typeof WorkItemExecutionPreflightDecisionSchema
>;

export const WorkItemExecutionPreflightSchema = z.object({
	workItemId: z.uuid(),
	status: z.enum(["not_configured", "ready", "needs_approval", "blocked"]),
	dispatchAllowed: z.boolean(),
	manifest: WorkItemCapabilityBundleSchema.nullable(),
	targetTedi: z
		.object({ id: z.uuid(), slug: z.string(), name: z.string() })
		.nullable(),
	runtimeProfile: z
		.object({
			id: z.uuid(),
			slug: z.string(),
			name: z.string(),
			status: z.string(),
		})
		.nullable(),
	policyPack: z
		.object({
			id: z.uuid(),
			slug: z.string(),
			name: z.string(),
			status: z.string(),
			requiresApproval: z.boolean(),
		})
		.nullable(),
	executionRequirement: ExecutionRequirementSchema.nullable(),
	decisions: z.array(WorkItemExecutionPreflightDecisionSchema),
	blockingReasons: z.array(z.string()),
	resolvedAt: z.string(),
});
export type WorkItemExecutionPreflight = z.infer<
	typeof WorkItemExecutionPreflightSchema
>;

export const WorkItemSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	title: z.string(),
	description: z.string().nullable(),
	disposition: WorkItemDispositionSchema,
	workKind: WorkItemKindSchema,
	riskLevel: WorkItemRiskLevelSchema,
	acceptanceContract: WorkItemAcceptanceContractSchema.nullable(),
	requiredCapabilities: z.array(z.string()),
	requiredAuthorities: z.array(z.string()),
	priority: WorkItemPrioritySchema,
	objectiveId: z.uuid().nullable(),
	workClass: WorkItemClassSchema.nullable(),
	purposeExceptionExpiresAt: z.iso.datetime().nullable(),
	projectId: z.uuid().nullable(),
	parentWorkItemId: z.uuid().nullable(),
	sourceSessionKey: z.string().nullable(),
	sourceIntentId: z.string().nullable(),
	accountableOwnerType: WorkItemOwnerTypeSchema.nullable(),
	accountableOwnerId: z.string().nullable(),
	stewardType: WorkItemOwnerTypeSchema.nullable(),
	stewardId: z.string().nullable(),
	reviewerType: WorkItemOwnerTypeSchema.nullable(),
	reviewerId: z.string().nullable(),
	reviewerLeaseExpiresAt: z.iso
		.datetime()
		.nullable()
		.describe(
			"Legacy reviewer designation kept for stored rows; nothing writes or consults it since the review plane was retired.",
		),
	dueDate: z.string().nullable(),
	deadline: z.string().nullable(),
	startAt: z.iso
		.datetime()
		.nullable()
		.describe("Null when work has no planned start."),
	durationDays: z
		.number()
		.int()
		.positive()
		.max(3650)
		.nullable()
		.describe("Null when work has no planned duration."),
	provenance: JsonRecordSchema.nullable(),
	metadata: JsonRecordSchema.nullable(),
	admissionSpecRevision: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe(
			"Opaque current admission-specification revision used with the Work Item version for exact CAS updates.",
		),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
	acceptedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	cancelledAt: z.string().nullable(),
	version: z.number().int().positive(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkCaseKindSchema = z.enum([
	"investigation",
	"incident",
	"customer",
	"opportunity",
	"legal",
	"operations",
	"other",
]);

/** Case business stage. It never represents Work Item readiness or disposition. */
export const WorkCaseStageSchema = z.enum([
	"investigating",
	"planning",
	"executing",
	"monitoring",
	"closed",
]);

export const WorkFactoryOwnerTypeSchema = WorkItemOwnerTypeSchema.exclude([
	"team",
]);

export const WorkCaseSchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		projectId: z
			.uuid()
			.nullable()
			.describe(
				"Nullable when the case spans organization-scoped Work outside one project.",
			),
		objectiveId: z
			.uuid()
			.nullable()
			.describe(
				"Nullable when the case is not tied directly to a strategic objective.",
			),
		kind: WorkCaseKindSchema,
		title: z.string().min(1).max(500),
		description: z
			.string()
			.max(10_000)
			.nullable()
			.describe(
				"Nullable while an investigating case has no authored narrative.",
			),
		stage: WorkCaseStageSchema,
		accountableOwnerType: WorkFactoryOwnerTypeSchema,
		accountableOwnerId: z.string().min(1).max(300),
		openedAt: z.iso.datetime(),
		targetResolutionAt: z.iso
			.datetime()
			.nullable()
			.describe("Nullable when no target resolution date has been committed."),
		closedAt: z.iso
			.datetime()
			.nullable()
			.describe("Set only after the case enters the closed stage."),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso
			.datetime()
			.nullable()
			.describe("Nullable until the case is changed after creation."),
		version: z.number().int().positive(),
	})
	.strict();

export const WorkCaseItemSchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		caseId: z.uuid(),
		workItemId: z.uuid(),
		rationale: z
			.string()
			.max(2_000)
			.nullable()
			.describe(
				"Nullable when the attachment needs no discovery or relevance explanation.",
			),
		discoveredAt: z.iso.datetime(),
	})
	.strict();

export const WorkCaseDependencySchema = z
	.object({
		id: z.uuid(),
		orgId: z.uuid(),
		fromCaseId: z.uuid(),
		toCaseId: z.uuid(),
		createdAt: z.iso.datetime(),
	})
	.strict();

export const WorkCaseDetailSchema = z
	.object({
		workCase: WorkCaseSchema,
		items: z
			.object({
				data: z.array(WorkCaseItemSchema),
				nextCursor: z
					.uuid()
					.nullable()
					.describe(
						"Null when the case has no further attached Work Item page.",
					),
			})
			.strict(),
		dependencies: z
			.object({
				data: z.array(WorkCaseDependencySchema),
				nextCursor: z
					.uuid()
					.nullable()
					.describe("Null when the case has no further dependency page."),
			})
			.strict(),
	})
	.strict();

export const WorkItemCommentIdSchema = z.string().min(1);

export const WorkItemCommentSchema = z.object({
	id: WorkItemCommentIdSchema,
	workItemId: z.uuid(),
	orgId: z.uuid(),
	authorType: WorkItemCommentAuthorTypeSchema,
	authorId: z.string().nullable(),
	body: z.string(),
	metadata: JsonRecordSchema.nullable(),
	createdAt: z.string(),
});
export type WorkItemComment = z.infer<typeof WorkItemCommentSchema>;

/**
 * Owner/admin user steering input for a bounded CMO-owned blog campaign. The server adds
 * every invariant field in the strict receipt; callers only choose the
 * campaign, exact draft ids, and expiry.
 */
export const AuthorizeOwnedChannelInputSchema = z
	.object({
		id: z.uuid(),
		campaignKey: OwnedChannelAuthorizationReceiptSchema.shape.campaignKey,
		contentIds: OwnedChannelAuthorizationReceiptSchema.shape.contentIds,
		validUntil: OwnedChannelAuthorizationReceiptSchema.shape.validUntil,
	})
	.strict();
export type AuthorizeOwnedChannelInput = z.infer<
	typeof AuthorizeOwnedChannelInputSchema
>;

export const RevokeOwnedChannelInputSchema = z
	.object({
		id: z.uuid(),
		campaignKey: OwnedChannelAuthorizationReceiptSchema.shape.campaignKey,
		reason: z.string().trim().min(1).max(2_000),
	})
	.strict();
export type RevokeOwnedChannelInput = z.infer<
	typeof RevokeOwnedChannelInputSchema
>;

export const MarketingMetricSnapshotSchema = z
	.object({
		impressions: z.number().int().nonnegative().optional(),
		searchImpressions: z.number().int().nonnegative().optional(),
		clicks: z.number().int().nonnegative().optional(),
		searchClicks: z.number().int().nonnegative().optional(),
		organicSessions: z.number().int().nonnegative().optional(),
		engagedSessions: z.number().int().nonnegative().optional(),
		signups: z.number().int().nonnegative().optional(),
	})
	.strict();
export type MarketingMetricSnapshot = z.infer<
	typeof MarketingMetricSnapshotSchema
>;

/**
 * CMO-only receipt recorded after the CMS mutation and independent readback.
 * The server re-resolves the exact owned-channel grant and creates the delayed
 * 7/28/90-day checkpoints; the caller cannot choose their ids or due dates.
 */
export const RecordOwnedChannelPublishInputSchema = z
	.object({
		id: z.uuid(),
		attemptId: z.uuid(),
		campaignKey: z.string().trim().min(1).max(128),
		contentId: z.string().trim().min(1).max(200),
		slug: z.string().trim().min(1).max(300),
		publicUrl: z.url().max(2_000),
		beforeRev: z.string().trim().min(1).max(300),
		afterRev: z.string().trim().min(1).max(300),
		beforeStatus: z.string().trim().min(1).max(100),
		afterStatus: z.literal("published"),
		publishedAt: z.iso.datetime({ offset: true }),
		hypothesis: z.string().trim().min(1).max(2_000),
		baseline: MarketingMetricSnapshotSchema,
		sourceUrls: z.array(z.url().max(2_000)).max(20).default([]),
		rollbackArtifactRef: z.string().trim().min(1).max(2_000),
		evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(2).max(30),
	})
	.strict();
export type RecordOwnedChannelPublishInput = z.infer<
	typeof RecordOwnedChannelPublishInputSchema
>;

export const RecordDemandQualificationInputSchema = z
	.object({
		id: z.uuid(),
		attemptId: z.uuid(),
		status: z.enum(["qualified", "disqualified"]),
		evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
		summary: z.string().trim().min(1).max(2_000),
	})
	.strict();
export type RecordDemandQualificationInput = z.infer<
	typeof RecordDemandQualificationInputSchema
>;

export const MarketingEvaluationOutcomeSchema = z.enum([
	"observed",
	"zero",
	"unavailable",
]);

export const RecordMarketingEvaluationInputSchema = z
	.object({
		id: z.uuid(),
		attemptId: z.uuid(),
		outcomeStatus: MarketingEvaluationOutcomeSchema,
		observed: MarketingMetricSnapshotSchema,
		evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
		qualifiedDemandWorkItemIds: z
			.array(z.uuid())
			.max(100)
			.default([])
			.refine((ids) => new Set(ids).size === ids.length, {
				message: "qualifiedDemandWorkItemIds must be unique",
			}),
		summary: z.string().trim().min(1).max(2_000),
		unavailableReason: z.string().trim().min(1).max(1_000).optional(),
		ownerAttention: z
			.object({
				kind: z.enum(["taste", "purpose", "authority"]),
				question: z.string().trim().min(1).max(500),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.outcomeStatus === "unavailable" && !value.unavailableReason) {
			context.addIssue({
				code: "custom",
				path: ["unavailableReason"],
				message: "unavailableReason is required for unavailable outcomes",
			});
		}
		if (value.outcomeStatus !== "unavailable" && value.unavailableReason) {
			context.addIssue({
				code: "custom",
				path: ["unavailableReason"],
				message: "unavailableReason is only valid for unavailable outcomes",
			});
		}
	});
export type RecordMarketingEvaluationInput = z.infer<
	typeof RecordMarketingEvaluationInputSchema
>;

export const ReviewMarketingEvaluationInputSchema = z
	.object({
		id: z.uuid(),
		accepted: z.boolean(),
		expectedResultObservedAt: z.iso.datetime(),
		evidenceRef: z.string().trim().min(1).max(2_000),
		summary: z.string().trim().min(1).max(2_000),
	})
	.strict();
export type ReviewMarketingEvaluationInput = z.infer<
	typeof ReviewMarketingEvaluationInputSchema
>;

export const WorkItemCorroborationPrincipalTypeSchema = z.enum([
	"user",
	"organization",
	"tedi",
	"external_agent",
]);

/**
 * What a second principal asserts about a settled claim. `corroborates` is the
 * original meaning of every row in this ledger and stays the default; the
 * ledger existed to suppress duplicate reports. `contradicts` is what makes it
 * a detection plane instead of a ranking signal — AGENTS.md delegates
 * after-the-fact correctness here, and a table that can only agree cannot
 * carry that.
 */
export const WorkItemCorroborationStanceSchema = z
	.enum(["corroborates", "contradicts"])
	.describe(
		"Whether this principal independently agrees with the Work Item's settled claim, or asserts it is false.",
	);

export const WorkItemCorroborationSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	principalType: WorkItemCorroborationPrincipalTypeSchema,
	principalId: z.string().min(1).max(300),
	sessionId: z.string().max(300).nullable(),
	evidenceRef: z.string().min(1).max(2_000),
	stance: WorkItemCorroborationStanceSchema,
	body: z.string().min(1).max(10_000),
	occurredAt: z.string(),
	createdAt: z.string(),
});
export type WorkItemCorroboration = z.infer<typeof WorkItemCorroborationSchema>;

export const WorkItemProjectionSchema = z.object({
	id: z.uuid(),
	workItemId: z.uuid(),
	orgId: z.uuid(),
	provider: z.string(),
	direction: WorkItemProjectionDirectionSchema,
	status: WorkItemProjectionStatusSchema,
	externalId: z.string().nullable(),
	externalUrl: z.string().nullable(),
	externalProjectId: z.string().nullable(),
	externalSectionId: z.string().nullable(),
	lastSyncedAt: z.string().nullable(),
	lastError: z.string().nullable(),
	syncCursor: z.string().nullable(),
	providerState: JsonRecordSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
});
export type WorkItemProjection = z.infer<typeof WorkItemProjectionSchema>;

export const WorkItemRelationSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	fromWorkItemId: z.uuid(),
	toWorkItemId: z.uuid(),
	relationType: WorkItemRelationTypeSchema,
	metadata: JsonRecordSchema.nullable(),
	createdAt: z.string(),
});
export type WorkItemRelation = z.infer<typeof WorkItemRelationSchema>;

/**
 * A schedulable point in time: an ISO-8601 instant, or the ISO calendar date
 * form the board legitimately uses for a day-granularity due date.
 *
 * `dueDate`/`deadline` were plain `z.string().max(100)`, and the scheduler ranks
 * urgency with `Date.parse(item.deadline ?? item.dueDate)`
 * (`packages/db/src/queries/work-items/scheduler.ts`). Prose therefore scored
 * `NaN`, which scrambled the ranking comparator and failed
 * `WorkSchedulerReadyQueueSchema`'s `z.number().int()`, 500-ing the whole
 * ready-queue response as soon as such a row reached the returned page.
 * Production collected 555 accepted rows holding values like `today`, `now`,
 * `immediately`, `90s after run start`, and `~8 minutes after run start`.
 *
 * Date-only is deliberately kept: 1,703 accepted rows carry a well-formed
 * `YYYY-MM-DD` due date, which `Date.parse` resolves deterministically to UTC
 * midnight and the scheduler ranks correctly. Narrowing to `z.iso.datetime()`
 * alone would reject the board's dominant legitimate form.
 *
 * A relative or descriptive expression is real intent but is not a due date:
 * it belongs in `metadata`, and the resolved timestamp belongs here.
 */
export const WorkItemTimestampSchema = z.union([
	z.iso.datetime(),
	z.iso.date(),
]);

export const CreateWorkItemInputSchema = z
	.object({
		factoryCycle: z
			.object({
				workspaceId: z.uuid(),
				blueprintRevisionId: z.uuid(),
				templateKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
				cycleKey: z.string().trim().min(1).max(200),
				sourceRefs: z
					.array(
						z
							.object({
								uri: z.string().trim().min(1).max(2_000),
								revision: z.string().trim().min(1).max(200),
							})
							.strict(),
					)
					.min(1)
					.max(50),
			})
			.strict()
			.optional()
			.describe(
				"Derive proposed Work from an installed, pinned factory Blueprint. Same workspace/cycle key replays one Work Item; changed inputs conflict. Never grants execution authority.",
			),
		title: z.string().min(1).max(500),
		description: z.string().max(10000).optional(),
		workKind: WorkItemKindSchema.default("other"),
		riskLevel: WorkItemRiskLevelSchema.default("medium"),
		requiredCapabilities: z
			.array(z.string().min(1).max(200))
			.max(100)
			.default([]),
		requiredAuthorities: z
			.array(z.string().min(1).max(200))
			.max(100)
			.default([]),
		accountableOwnerType: WorkItemOwnerTypeSchema.optional(),
		accountableOwnerId: z.string().max(300).optional(),
		stewardType: WorkItemOwnerTypeSchema.optional(),
		stewardId: z.string().max(300).optional(),
		priority: WorkItemPrioritySchema.default("medium"),
		objectiveId: z.uuid().optional(),
		workClass: WorkItemClassSchema.optional(),
		purposeExceptionExpiresAt: z.iso.datetime().optional(),
		projectId: z.uuid().optional(),
		parentWorkItemId: z.uuid().optional(),
		sourceSessionKey: z.string().max(500).optional(),
		sourceIntentId: z.string().max(500).optional(),
		dueDate: WorkItemTimestampSchema.optional(),
		deadline: WorkItemTimestampSchema.optional(),
		startAt: z.iso
			.datetime()
			.optional()
			.describe("Optional planned start for schedule views."),
		durationDays: z
			.number()
			.int()
			.positive()
			.max(3650)
			.optional()
			.describe("Optional positive calendar-day duration."),
		provenance: JsonRecordSchema.optional(),
		metadata: JsonRecordSchema.optional(),
	})
	.strict();
export type CreateWorkItemInput = z.infer<typeof CreateWorkItemInputSchema>;

export const UpdateWorkItemInputSchema =
	CreateWorkItemInputSchema.partial().extend({
		id: z.uuid(),
		disposition: z.never().optional(),
	});
export type UpdateWorkItemInput = z.infer<typeof UpdateWorkItemInputSchema>;

// =============================================================================
// Work hierarchy — subtree + rollup outputs (work hierarchy v1)
// =============================================================================

export const WorkItemSubtreeNodeSchema = z.object({
	id: z.string(),
	title: z.string(),
	disposition: WorkItemDispositionSchema,
	parentWorkItemId: z.string().nullable(),
	depth: z.number(),
});
export type WorkItemSubtreeNode = z.infer<typeof WorkItemSubtreeNodeSchema>;

export const WorkItemSubtreeSchema = z.object({
	root: WorkItemSubtreeNodeSchema,
	nodes: z.array(WorkItemSubtreeNodeSchema),
	edges: z.array(z.object({ parentId: z.string(), childId: z.string() })),
	truncated: z.boolean(),
});
export type WorkItemSubtreeOutput = z.infer<typeof WorkItemSubtreeSchema>;

export const WorkItemRollupTotalsSchema = z.object({
	total: z.number(),
	byDisposition: z.record(z.string(), z.number()),
	byWorkKind: z.record(z.string(), z.number()),
	percentDone: z.number(),
	aggregateDisposition: WorkItemAggregateDispositionSchema,
	distinctExecutors: z.array(
		z.object({ type: WorkItemExecutorTypeSchema, id: z.string() }),
	),
});

export const WorkItemRollupSchema = WorkItemRollupTotalsSchema.extend({
	rootId: z.string(),
	truncated: z.boolean(),
});
export type WorkItemRollupOutput = z.infer<typeof WorkItemRollupSchema>;

// =============================================================================
// Work-graph steward — coherence report + gated repair (deterministic, no LLM)
// =============================================================================

export const WorkGraphDuplicateClusterSchema = z.object({
	canonicalWorkItemId: z.string(),
	duplicateWorkItemIds: z.array(z.string()),
	workItemIds: z.array(z.string()),
	normalizedTitle: z.string(),
	method: z.enum(["exact", "jaccard"]),
	suggestedAction: z.literal("link_duplicates"),
});

export const WorkGraphIdleAcceptedFindingSchema = z.object({
	workItemId: z.string(),
	title: z.string(),
	disposition: WorkItemDispositionSchema,
	readiness: WorkItemReadinessStateSchema,
	lastActivityAt: z.string(),
	idleDays: z.number(),
	suggestedAction: z.literal("review_idle"),
});

export const WorkGraphNamingIssueSchema = z.enum([
	"empty_title",
	"overlong_title",
	"tier_violation",
	"orphan_project",
	"unlinked_project",
	"unfiled_project_match",
	"orphan_parent",
]);
export type WorkGraphNamingIssue = z.infer<typeof WorkGraphNamingIssueSchema>;

export const WorkGraphNamingFindingSchema = z.object({
	workItemId: z.string(),
	issue: WorkGraphNamingIssueSchema,
	detail: z.string(),
	suggestedAction: z.literal("flag"),
});

export const WorkGraphExpiredAttemptFindingSchema = z.object({
	workItemId: z.string(),
	attemptId: z.string(),
	executorType: WorkItemExecutorTypeSchema,
	executorId: z.string(),
	executorSessionId: z
		.string()
		.nullable()
		.describe(
			"Nullable for tedi attempts and historical executions without a session identity.",
		),
	expiresAt: z
		.string()
		.nullable()
		.describe(
			"Nullable only for historical attempts created before bounded leases were required.",
		),
	suggestedAction: z.literal("flag"),
});

export const WorkGraphHealthReportSchema = z.object({
	orgId: z.string(),
	projectId: z.string().nullable(),
	generatedAt: z.string(),
	idleThresholdDays: z.number(),
	dupThreshold: z.number(),
	scannedCount: z.number(),
	duplicates: z.array(WorkGraphDuplicateClusterSchema),
	idleAccepted: z.array(WorkGraphIdleAcceptedFindingSchema),
	naming: z.array(WorkGraphNamingFindingSchema),
	expiredAttempts: z.array(WorkGraphExpiredAttemptFindingSchema),
	counts: z.object({
		duplicateClusters: z.number(),
		duplicateItems: z.number(),
		idleAccepted: z.number(),
		naming: z.number(),
		expiredAttempts: z.number(),
	}),
	truncated: z.object({
		scan: z.boolean(),
		idleAccepted: z.boolean(),
		expiredAttempts: z.boolean(),
	}),
});
export type WorkGraphHealthReportOutput = z.infer<
	typeof WorkGraphHealthReportSchema
>;

export const WorkGraphStewardActionSchema = z.enum(["link_duplicates", "flag"]);
export type WorkGraphStewardAction = z.infer<
	typeof WorkGraphStewardActionSchema
>;

export const WorkGraphStewardOutcomeSchema = z.object({
	applied: z.boolean(),
	report: WorkGraphHealthReportSchema,
	actions: z.object({
		linkedDuplicateClusters: z.number(),
		linkedDuplicateRelations: z.number(),
		flaggedNaming: z.number(),
		flaggedExpiredAttempts: z.number(),
		duplicateComments: z.number(),
	}),
	errors: z.array(z.string()),
});
export type WorkGraphStewardOutcomeOutput = z.infer<
	typeof WorkGraphStewardOutcomeSchema
>;

export const GetWorkGraphHealthInputSchema = z.object({
	projectId: z.uuid().optional(),
	idleThresholdDays: z.number().int().min(1).max(365).default(14),
	dupThreshold: z.number().min(0.1).max(1).default(0.85),
	scanCap: z.number().int().min(10).max(2000).default(500),
});
export type GetWorkGraphHealthInput = z.infer<
	typeof GetWorkGraphHealthInputSchema
>;

export const RunWorkGraphStewardInputSchema = z.object({
	confirmDestructive: z
		.boolean()
		.optional()
		.describe(
			"Explicit confirmation for stateless MCP clients that cannot answer form elicitation",
		),
	reason: z
		.string()
		.min(1)
		.max(4000)
		.optional()
		.describe("Audited reason for running the destructive work-graph steward"),
	projectId: z.uuid().optional(),
	apply: z.boolean().default(false),
	idleThresholdDays: z.number().int().min(1).max(365).default(14),
	dupThreshold: z.number().min(0.1).max(1).default(0.85),
	scanCap: z.number().int().min(10).max(2000).default(500),
	actions: z
		.array(WorkGraphStewardActionSchema)
		.min(1)
		.default(["link_duplicates", "flag"]),
	limit: z.number().int().min(1).max(1000).default(200),
});
export type RunWorkGraphStewardInput = z.infer<
	typeof RunWorkGraphStewardInputSchema
>;

// =============================================================================
// Org graph health — the blocked-work dependency read (org "digital twin",
// Stage 1). Sibling of the work-graph steward's health report.
// =============================================================================

export const OrgGraphRootBlockerSchema = z.object({
	id: z.string(),
	title: z.string(),
	disposition: WorkItemDispositionSchema,
	/** Accountable owner for the blocker. */
	ownerTediId: z.string().nullable(),
	/** Distinct non-terminal items transitively reachable along `blocks` edges. */
	downstreamBlockedCount: z.number(),
});

export const OrgGraphBlockerTediSchema = z.object({
	tediId: z.string(),
	rootBlockerCount: z.number(),
	downstreamImpact: z.number(),
});

export const OrgGraphCapabilityStallSchema = z.object({
	valueStream: z.string().nullable(),
	paceLayer: z.string(),
	capabilityId: z.string(),
	dependencyBlockedCount: z.number(),
});

export const OrgGraphHealthReportSchema = z.object({
	orgId: z.string(),
	generatedAt: z.string(),
	limit: z.number(),
	rootBlockers: z.array(OrgGraphRootBlockerSchema),
	blockerTedis: z.array(OrgGraphBlockerTediSchema),
	capabilityStall: z.array(OrgGraphCapabilityStallSchema),
	capabilityLinksAvailable: z.boolean(),
	counts: z.object({
		totalNonTerminal: z.number(),
		blockedCount: z.number(),
		rootBlockerCount: z.number(),
		scannedCount: z.number(),
		truncated: z.boolean(),
	}),
	notes: z.array(z.string()),
});
export type OrgGraphHealthReportOutput = z.infer<
	typeof OrgGraphHealthReportSchema
>;

export const GetOrgGraphHealthInputSchema = z.object({
	/** Canonical project scope. */
	projectId: z.uuid().optional(),
	/** Root blockers to return, ranked by downstream impact (default 20). */
	limit: z.number().int().min(1).max(100).default(20),
});
export type GetOrgGraphHealthInput = z.infer<
	typeof GetOrgGraphHealthInputSchema
>;

// =============================================================================
// Relations edges — the dependency-graph read (node-edge DAG lens).
// =============================================================================

export const WorkItemRelationEdgeSchema = z.object({
	id: z.string(),
	fromWorkItemId: z.string(),
	toWorkItemId: z.string(),
	relationType: WorkItemRelationTypeSchema,
	createdAt: z.string(),
});
export type WorkItemRelationEdge = z.infer<typeof WorkItemRelationEdgeSchema>;

export const ListWorkItemRelationsInputSchema = z.object({
	projectId: z.uuid().optional(),
	limit: z.number().int().min(1).max(5000).optional(),
});
export type ListWorkItemRelationsInput = z.infer<
	typeof ListWorkItemRelationsInputSchema
>;

export const ListWorkItemRelationsResultSchema = z.object({
	relations: z.array(WorkItemRelationEdgeSchema),
	truncated: z.boolean(),
});

// ── Source graph ─────────────────────────────────────────────────────────────

export const WorkItemSourceKindSchema = z.enum([
	"document",
	"thread",
	"message",
	"file",
	"record",
	"page",
	"other",
]);

export const WorkItemSourceStateSchema = z.enum([
	"current",
	"changed",
	"missing",
	"tombstoned",
]);

export const WorkItemSourceSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	projectId: z.string().nullable(),
	workItemId: z.string().nullable(),
	provider: z.string(),
	externalId: z.string(),
	kind: WorkItemSourceKindSchema,
	externalUrl: z.string().nullable(),
	title: z.string().nullable(),
	contentHash: z.string().nullable(),
	state: WorkItemSourceStateSchema,
	lastCheckedAt: z.string().nullable(),
	lastChangedAt: z.string().nullable(),
	missingSinceAt: z.string().nullable(),
	tombstonedAt: z.string().nullable(),
	attributedTo: z.string().nullable(),
	metadata: JsonRecordSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string().nullable(),
});

export const AttachWorkItemSourceInputSchema = z
	.object({
		projectId: z.uuid().optional(),
		workItemId: z.uuid().optional(),
		provider: z.string().min(1).max(100),
		externalId: z.string().min(1).max(500),
		kind: WorkItemSourceKindSchema.optional(),
		externalUrl: z.string().max(2000).optional(),
		title: z.string().max(500).optional(),
		/** Caller-computed digest of the source content. Opaque to the platform. */
		contentHash: z.string().max(200).optional(),
		metadata: JsonRecordSchema.optional(),
	})
	.refine((v) => Boolean(v.projectId || v.workItemId), {
		message: "A source must attach to a project, a work item, or both.",
	});
export type AttachWorkItemSourceInput = z.infer<
	typeof AttachWorkItemSourceInputSchema
>;

export const AttachWorkItemSourceResultSchema = z.object({
	source: WorkItemSourceSchema,
});

export const ListWorkItemSourcesInputSchema = z.object({
	projectId: z.uuid().optional(),
	workItemId: z.uuid().optional(),
	provider: z.string().max(100).optional(),
	includeTombstoned: z.boolean().optional(),
	limit: z.number().int().min(1).max(500).optional(),
	offset: z.number().int().min(0).optional(),
});
export type ListWorkItemSourcesInput = z.infer<
	typeof ListWorkItemSourcesInputSchema
>;

export const ListWorkItemSourcesResultSchema = z.object({
	data: z.array(WorkItemSourceSchema),
	pagination: z.object({
		limit: z.number(),
		offset: z.number(),
		total: z.number(),
		hasMore: z.boolean(),
	}),
	freshness: z.object({
		byState: z.record(z.string(), z.number()),
		total: z.number(),
		oldestCheckedAt: z.string().nullable(),
		neverChecked: z.number(),
	}),
});

export const ReconcileWorkItemSourcesInputSchema = z.object({
	provider: z.string().min(1).max(100),
	projectId: z.uuid().optional(),
	/**
	 * Every external id the sweep observed for this provider (and project, when
	 * scoped). Anything currently attached and absent from this list is marked
	 * missing — this is the delete detection.
	 */
	seenExternalIds: z.array(z.string().max(500)).max(2000),
	/** Hours a source may stay missing before it is tombstoned. */
	graceHours: z.number().int().min(1).max(720).optional(),
	/** Preview the sweep without writing. */
	dryRun: z.boolean().optional(),
});
export type ReconcileWorkItemSourcesInput = z.infer<
	typeof ReconcileWorkItemSourcesInputSchema
>;

export const ReconcileWorkItemSourcesResultSchema = z.object({
	markedMissing: z.number(),
	tombstoned: z.array(z.string()),
	dryRun: z.boolean(),
	freshness: z.object({
		byState: z.record(z.string(), z.number()),
		total: z.number(),
		oldestCheckedAt: z.string().nullable(),
		neverChecked: z.number(),
	}),
});

export const ListWorkItemProjectionsInputSchema = z.object({
	projectId: z.uuid().optional(),
	provider: z.string().max(100).optional(),
	limit: z.number().int().min(1).max(500).optional(),
	offset: z.number().int().min(0).optional(),
});
export type ListWorkItemProjectionsInput = z.infer<
	typeof ListWorkItemProjectionsInputSchema
>;

export const OrgWorkItemProjectionSchema = z.object({
	id: z.string(),
	workItemId: z.string(),
	workItemTitle: z.string(),
	workItemDisposition: WorkItemDispositionSchema,
	projectId: z.string().nullable(),
	provider: z.string(),
	direction: WorkItemProjectionDirectionSchema,
	syncStatus: WorkItemProjectionStatusSchema,
	externalId: z.string().nullable(),
	externalUrl: z.string().nullable(),
	lastSyncedAt: z.string().nullable(),
	lastError: z.string().nullable(),
	createdAt: z.string(),
});

export const ListWorkItemProjectionsResultSchema = z.object({
	data: z.array(OrgWorkItemProjectionSchema),
	pagination: z.object({
		limit: z.number(),
		offset: z.number(),
		total: z.number(),
		hasMore: z.boolean(),
	}),
});

// =============================================================================
// Activity feed — the org-wide append-only board-event stream (Agents lens +
// session swimlane). Each event carries its agent session for fleet grouping.
// =============================================================================

/**
 * How a terminal event settled its item. Present only on settlement events.
 * `mode` is the audited path (a verified commit, a hand close, or a human
 * override); `commitSha` is the proof when one exists.
 */
export const WorkActivitySettlementSchema = z.object({
	mode: z.string(),
	commitSha: z.string().nullable(),
});
export type WorkActivitySettlement = z.infer<
	typeof WorkActivitySettlementSchema
>;

export const WorkActivityEventSchema = z.object({
	id: z.string(),
	workItemId: z.string(),
	workItemTitle: z.string(),
	workItemDisposition: WorkItemDispositionSchema,
	eventType: z.string(),
	authorType: z.string(),
	authorId: z.string().nullable(),
	agentSession: z.string().nullable(),
	agentHarness: z.string().nullable(),
	settlement: WorkActivitySettlementSchema.nullable(),
	body: z.string(),
	createdAt: z.string(),
});
export type WorkActivityEvent = z.infer<typeof WorkActivityEventSchema>;

export const ListWorkActivityInputSchema = z
	.object({
		// Scope to one Work Item's own history. Callers building a per-item
		// audit trail passed this long before it existed, and a non-strict
		// object silently dropped it — the caller then reasonably believed an
		// org-wide feed was one item's history.
		workItemId: z
			.uuid()
			.optional()
			.describe(
				"Scope the feed to one Work Item's own history. Absent keeps the org-wide board feed, which is the established behavior every existing caller depends on.",
			),
		projectId: z.uuid().optional(),
		// Capped: passed straight into an unchunked inArray; keep well under D1's
		// 100 bound-param limit.
		eventTypes: z.array(z.string().max(100)).max(50).optional(),
		limit: z.number().int().min(1).max(300).optional(),
	})
	// Strict for the same reason the Work Item list is: a dropped filter is
	// indistinguishable from an honest empty scope at the call site.
	.strict();
export type ListWorkActivityInput = z.infer<typeof ListWorkActivityInputSchema>;

export const ListWorkActivityResultSchema = z.object({
	events: z.array(WorkActivityEventSchema),
	truncated: z.boolean(),
});

/** Exact bounded CLI read shapes; full Work records remain separate. */
export const WorkCliBoardRowSchema = WorkItemSchema.pick({
	id: true,
	workKind: true,
	disposition: true,
	riskLevel: true,
	priority: true,
	title: true,
	projectId: true,
	createdAt: true,
})
	.extend({
		title: z.string().max(500),
		activeAttempt: z
			.strictObject({
				agentSession: z.string().max(300).nullable(),
				executorId: z.string().max(300),
			})
			.nullable(),
	})
	.strict();
export const WorkCliResolveRowSchema = WorkCliBoardRowSchema.omit({
	activeAttempt: true,
});
export const ListWorkCliProjectionInputSchema = z.strictObject({
	view: z.enum(["board", "resolve"]),
	disposition: WorkItemDispositionSchema.optional(),
	workKind: WorkItemKindSchema.optional(),
	projectId: z.uuid().optional(),
	objectiveId: z.uuid().optional(),
	workClass: WorkItemClassSchema.optional(),
	idPrefix: z
		.string()
		.regex(/^[0-9a-f-]{6,36}$/)
		.optional(),
	titleContains: z.string().min(1).max(200).optional(),
	customerVisibleOnly: z.boolean().optional(),
	limit: z.number().int().min(1).max(50).default(50),
	offset: z.number().int().nonnegative().default(0),
});
const WorkCliPaginationSchema = z.strictObject({
	limit: z.number().int().min(1).max(50),
	offset: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	hasMore: z.boolean(),
});
export const ListWorkCliProjectionResultSchema = z.discriminatedUnion("view", [
	z.strictObject({
		view: z.literal("board"),
		data: z.array(WorkCliBoardRowSchema).max(50),
		pagination: WorkCliPaginationSchema,
	}),
	z.strictObject({
		view: z.literal("resolve"),
		data: z.array(WorkCliResolveRowSchema).max(50),
		pagination: WorkCliPaginationSchema,
	}),
]);
export const WorkCheckpointProjectionSchema = WorkItemSchema.pick({
	id: true,
	projectId: true,
	orgId: true,
	disposition: true,
}).strict();
export const WorkCheckpointProjectionInputSchema = z.strictObject({
	id: z.uuid(),
});
export const WorkAttemptCliRowSchema = WorkAttemptSchema.pick({
	id: true,
	attemptNumber: true,
	runtimeState: true,
	outcome: true,
	executorType: true,
	executorId: true,
	externalSessionKey: true,
	startedAt: true,
	heartbeatAt: true,
	expiresAt: true,
	finishedAt: true,
	summary: true,
}).strict();
export const WorkEvidenceCliRowSchema = WorkEvidenceSchema.pick({
	id: true,
	claimKey: true,
	kind: true,
	disposition: true,
	uri: true,
	label: true,
	attemptId: true,
	submittedByType: true,
	submittedById: true,
	submittedAt: true,
	reviewedByType: true,
	reviewedById: true,
	reviewedAt: true,
	reviewReason: true,
}).strict();
export const WorkEventCliRowSchema = WorkEventSchema.pick({
	sequence: true,
	id: true,
	eventType: true,
	actorType: true,
	actorId: true,
	attemptId: true,
	occurredAt: true,
}).strict();
export const WorkCliLedgerInputSchema = z.strictObject({
	id: z.uuid(),
	cursor: WorkFactoryProjectionCursorSchema.strict().optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
export const ListWorkAttemptCliProjectionResultSchema = z.strictObject({
	data: z.array(WorkAttemptCliRowSchema).max(100),
	nextCursor: WorkFactoryProjectionCursorSchema.strict().nullable(),
});
export const ListWorkEvidenceCliProjectionResultSchema = z.strictObject({
	data: z.array(WorkEvidenceCliRowSchema).max(100),
	nextCursor: WorkFactoryProjectionCursorSchema.strict().nullable(),
});
export const WorkCliEventInputSchema = z.strictObject({
	id: z.uuid(),
	afterSequence: z.number().int().nonnegative().optional(),
	limit: z.number().int().min(1).max(100).default(100),
});
export const ListWorkEventCliProjectionResultSchema = z.strictObject({
	events: z.array(WorkEventCliRowSchema).max(100),
	nextSequence: z.number().int().positive().nullable(),
});
