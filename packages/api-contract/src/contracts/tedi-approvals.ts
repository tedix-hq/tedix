import "@orpc/openapi/extensions/route";
/**
 * Tedi Approvals Contract
 * oRPC contract for the human-in-the-loop approval queue
 *
 * Used by: Tedix OS Activity, tedi Workers (via service binding)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
} from "../schemas/common";

// =============================================================================
// SCHEMAS
// =============================================================================

export const ApprovalReviewEvidenceRefSchema = z.object({
	kind: z.enum([
		"approval_request",
		"conversation",
		"home_run",
		"runtime_run",
		"tedi",
		"delegate_tedi",
		"tool_call",
		"trace_bundle",
		"workflow",
		"browser_session",
		"work_item",
	]),
	id: z.string(),
});

export const BrowserTakeoverInteractionSchema = z.object({
	type: z.literal("browser_takeover"),
	reason: z.enum(["login", "mfa", "captcha", "consent", "operator_takeover"]),
	sessionId: z.string(),
	mode: z.literal("tab"),
	targets: z.array(
		z.object({
			targetId: z.string(),
			url: z.url(),
			pageUrl: z.url().nullable(),
			title: z.string().nullable(),
		}),
	),
	urlExpiresAt: z.string(),
});

export const ApprovalReviewSchema = z.object({
	intent: z.enum([
		"tool_write",
		"workstation_attach",
		"runtime_permission",
		"browser_takeover",
		"unknown",
	]),
	state: z.enum(["requires_decision", "resolved", "closed"]),
	decisionMode: z.enum(["approve_or_reject", "no_action"]),
	outcome: z.enum(["approved", "rejected", "cancelled", "expired"]).nullable(),
	safetyDefault: z.literal("deny_on_timeout"),
	summary: z.string(),
	operatorQuestion: z.string(),
	timeout: z.object({
		expired: z.boolean(),
		terminalStatus: z.enum(["expired"]).nullable(),
		defaultDecision: z.enum(["deny"]).nullable(),
		reason: z.string(),
	}),
	evidenceRefs: z.array(ApprovalReviewEvidenceRefSchema),
	interaction: BrowserTakeoverInteractionSchema.nullable(),
});

export const ApprovalRequestSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	orgId: z.string(),
	actionType: z.string(),
	description: z.string(),
	payload: z.record(z.string(), JsonValueSchema),
	status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]),
	createdAt: z.string(),
	expiresAt: z.string(),
	resolvedAt: z.string().nullable(),
	resolvedBy: z.string().nullable(),
	resolution: z.string().nullable(),
	workflowId: z.string().nullable(),
	review: ApprovalReviewSchema,
});

export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const ApprovalProvenanceCursorSchema = z.strictObject({
	timestamp: z.string().min(1).max(64),
	id: z.string().min(1).max(200),
});
const ApprovalProvenancePageInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(25).default(10),
	cursor: ApprovalProvenanceCursorSchema.optional(),
});

export const ApprovalSimulationRecordSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	approvalRequestId: z.string(),
	simulatorId: z.string(),
	simulatorVersion: z.string(),
	canonicalInputHash: z.string(),
	recordHash: z.string(),
	baselineEvidenceRefs: z.array(
		z.object({ ref: z.string(), revision: z.string().nullable() }),
	),
	predictedResult: z.record(z.string(), JsonValueSchema),
	assumptions: z.array(z.object({ name: z.string(), value: JsonValueSchema })),
	confidence: z.number().min(0).max(1),
	evidenceKind: z.literal("simulation"),
	notProof: z.literal(true),
	createdAt: z.string(),
});

const ApprovalExecutionReceiptBaseSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	approvalRequestId: z.string(),
	simulationId: z.string().nullable(),
	idempotencyKey: z.string(),
	canonicalInputHash: z.string(),
	recordHash: z.string(),
	evidenceKind: z.literal("execution_receipt"),
	baselineFenceOutcome: z.enum(["matched", "stale", "not_checked"]),
	providerReceiptRefs: z.array(
		z.object({ provider: z.string(), ref: z.string() }),
	),
	executedAt: z.string(),
	createdAt: z.string(),
});
export const ApprovalExecutionReceiptRecordSchema = z.discriminatedUnion(
	"outcome",
	[
		ApprovalExecutionReceiptBaseSchema.extend({
			outcome: z.literal("succeeded"),
			observedResult: z.record(z.string(), JsonValueSchema),
			observedError: z.null(),
		}),
		ApprovalExecutionReceiptBaseSchema.extend({
			outcome: z.literal("failed"),
			observedResult: z.null(),
			observedError: z.object({
				code: z.string(),
				message: z.string(),
				retryable: z.boolean().optional(),
			}),
		}),
	],
);

export const ApprovalProvenanceSchema = z.object({
	approvalRequestId: z.string(),
	simulations: z.object({
		records: z.array(ApprovalSimulationRecordSchema).max(25),
		nextCursor: ApprovalProvenanceCursorSchema.nullable(),
	}),
	executionReceipts: z.object({
		records: z.array(ApprovalExecutionReceiptRecordSchema).max(25),
		nextCursor: ApprovalProvenanceCursorSchema.nullable(),
	}),
});
export type ApprovalProvenance = z.infer<typeof ApprovalProvenanceSchema>;

export const ApprovalReviewManifestActionSchema = z.object({
	order: z.number().int().nonnegative(),
	inclusion: z.enum(["requested", "hard_dependency_component"]),
	canonicalInputHash: Sha256Schema,
	approval: ApprovalRequestSchema,
	dependencies: z.array(
		z.object({
			declarationEventId: z.string(),
			prerequisiteApprovalRequestId: z.string().uuid(),
			kind: z.enum(["hard", "informational"]),
			enforcement: z.literal("unsupported_baseline_verifier"),
		}),
	),
	vetoCascadeApprovalRequestIds: z.array(z.string().uuid()),
	execution: z.object({
		state: z.enum(["none", "succeeded", "failed", "unknown"]),
		receiptId: z
			.string()
			.nullable()
			.describe(
				"Null when no execution receipt matches the exact executable input; approval alone does not prove execution.",
			),
	}),
});

export const ApprovalReviewManifestSchema = z.object({
	manifestHash: Sha256Schema,
	generatedAt: z.string(),
	actions: z.array(ApprovalReviewManifestActionSchema).max(25),
});
export type ApprovalReviewManifest = z.infer<
	typeof ApprovalReviewManifestSchema
>;

export const ApprovalReviewDecisionResultSchema = z.object({
	approvalRequestId: z.string().uuid(),
	outcome: z.enum([
		"approved",
		"vetoed",
		"cascade_cancelled",
		"blocked",
		"failed",
		"unknown",
		"conflict",
	]),
	reason: z.string(),
});

export const ProvisionalOutcomeSchema = z.strictObject({
	id: z.uuid(),
	tediId: z.uuid(),
	orgId: z.uuid(),
	conversationId: z
		.string()
		.nullable()
		.describe(
			"Absent when the provisional outcome was not produced in a conversation.",
		),
	runId: z
		.string()
		.nullable()
		.describe(
			"Absent when the provisional outcome was not produced by a runtime run.",
		),
	kind: z.enum(["draft", "configuration_proposal"]),
	state: z.enum(["provisional", "promoted", "rolled_back"]),
	title: z.string(),
	payload: z.record(z.string(), JsonValueSchema),
	createdAt: z.string(),
	promotionApprovalRequestId: z
		.uuid()
		.nullable()
		.describe("Present only after promotion through canonical approval."),
	promotedAt: z
		.string()
		.nullable()
		.describe("Present only after the outcome has been promoted."),
	promotedBy: z
		.string()
		.nullable()
		.describe("Principal that recorded the approved promotion."),
	rolledBackAt: z
		.string()
		.nullable()
		.describe("Present only after a promoted outcome has been rolled back."),
	rolledBackBy: z
		.string()
		.nullable()
		.describe("Principal that recorded the rollback."),
	rollbackReason: z
		.string()
		.nullable()
		.describe("Operator-supplied reason for rollback, absent before rollback."),
});
export type ProvisionalOutcome = z.infer<typeof ProvisionalOutcomeSchema>;

// =============================================================================
// CONTRACT
// =============================================================================

export const tediApprovalsContract = oc
	.route({ tags: ["tedi-approvals"], prefix: "/tedi-approvals" })
	.errors(baseErrors)
	.router({
		/** Store a non-canonical outcome. This never creates or resolves approval. */
		createProvisionalOutcome: oc
			.route({
				method: "POST",
				path: "/provisional-outcomes",
				summary: "Record a provisional outcome",
				tags: ["tedi-approvals", "internal"],
				successStatus: 201,
			})
			.input(
				z.strictObject({
					tediId: z.uuid(),
					orgId: z.uuid(),
					conversationId: z
						.string()
						.min(1)
						.optional()
						.describe(
							"Optional for provisional outcomes created outside a conversation.",
						),
					runId: z
						.string()
						.min(1)
						.optional()
						.describe(
							"Optional for provisional outcomes created outside a runtime run.",
						),
					kind: z.enum(["draft", "configuration_proposal"]),
					title: z.string().min(1).max(200),
					payload: z.record(z.string(), JsonValueSchema),
				}),
			)
			.output(ProvisionalOutcomeSchema),

		/** List non-canonical outcomes for the caller's organization. */
		listProvisionalOutcomes: oc
			.route({
				method: "GET",
				path: "/provisional-outcomes",
				summary: "List provisional outcomes",
			})
			.input(
				z.strictObject({
					tediId: z
						.uuid()
						.optional()
						.describe(
							"Optional filter; omission lists outcomes for every tedi in the caller organization.",
						),
					limit: z.coerce.number().int().min(1).max(100).default(50),
				}),
			)
			.output(z.object({ data: z.array(ProvisionalOutcomeSchema) })),

		/** Create the exact typed approval that may promote this inert record. */
		requestProvisionalOutcomePromotion: oc
			.route({
				method: "POST",
				path: "/provisional-outcomes/{id}/request-promotion",
				summary: "Request promotion of a provisional outcome",
				tags: ["tedi-approvals", "internal"],
				successStatus: 201,
			})
			.input(
				z.strictObject({
					id: z.uuid(),
					tediId: z.uuid(),
					orgId: z.uuid(),
					ttlHours: z.number().min(1).max(168).default(24),
				}),
			)
			.output(ApprovalRequestSchema),

		promoteProvisionalOutcome: oc
			.route({
				method: "POST",
				path: "/provisional-outcomes/{id}/promote",
				summary: "Promote an approved provisional outcome",
			})
			.input(z.strictObject({ id: z.uuid(), approvalRequestId: z.uuid() }))
			.output(ProvisionalOutcomeSchema),

		rollbackProvisionalOutcome: oc
			.route({
				method: "POST",
				path: "/provisional-outcomes/{id}/rollback",
				summary: "Roll back a promoted provisional outcome",
			})
			.input(
				z.strictObject({ id: z.uuid(), reason: z.string().min(1).max(2000) }),
			)
			.output(ProvisionalOutcomeSchema),

		/**
		 * Create an approval request (internal — called by tedi via service binding)
		 * POST /tedi-approvals
		 */
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create approval request",
				description:
					"Create a new pending approval request. Called by tedis when governance policy requires human approval.",
				tags: ["tedi-approvals", "internal"],
				successStatus: 201,
			})
			.input(
				z.object({
					tediId: z.uuid(),
					orgId: z.uuid(),
					actionType: z.string().min(1),
					description: z.string().min(1).max(2000),
					payload: z.record(z.string(), z.unknown()),
					ttlHours: z.number().min(1).max(168).default(24),
				}),
			)
			.output(ApprovalRequestSchema),

		/**
		 * List approval requests (user auth — Tedix OS Activity)
		 * GET /tedi-approvals
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List approval requests",
				description:
					"List approval requests for the current organization with optional filters",
			})
			.input(
				z
					.object({
						tediId: z.uuid().optional(),
						status: z
							.enum(["pending", "approved", "rejected", "cancelled", "expired"])
							.optional(),
						actionType: z.string().optional(),
					})
					.extend(PaginationSchema.shape)
					.optional(),
			)
			.output(
				z.object({
					data: z.array(ApprovalRequestSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get a single approval request by ID (user or tedi auth)
		 * GET /tedi-approvals/{id}
		 */
		getById: oc
			.route({
				method: "GET",
				path: "/{id}",
				summary: "Get approval request",
			})
			.input(z.object({ id: z.uuid() }))
			.output(ApprovalRequestSchema),

		getProvenance: oc
			.route({
				method: "GET",
				path: "/{approvalRequestId}/provenance",
				summary: "Inspect immutable approval predictions and observed receipts",
			})
			.input(
				z.strictObject({
					approvalRequestId: z.uuid(),
					simulations: ApprovalProvenancePageInputSchema.default({ limit: 10 }),
					executionReceipts: ApprovalProvenancePageInputSchema.default({
						limit: 10,
					}),
				}),
			)
			.output(ApprovalProvenanceSchema),

		getReviewManifest: oc
			.route({
				method: "POST",
				path: "/review-manifest",
				summary: "Build an ordered approval review manifest",
				description:
					"Builds a server-derived, immutable review snapshot for up to 25 existing approval requests and their complete hard dependency components. Oversized or incomplete components are rejected. This grants no authority.",
			})
			.input(
				z.strictObject({
					approvalRequestIds: z.array(z.string().uuid()).min(1).max(25),
				}),
			)
			.output(ApprovalReviewManifestSchema),

		resolveReviewManifest: oc
			.route({
				method: "POST",
				path: "/review-manifest/resolve",
				summary: "Resolve explicit decisions from an approval review manifest",
				description:
					"Applies only the explicit per-action approve or veto decisions bound to the exact server-expanded manifest and action hashes. Vetoes settle before any approval executes.",
			})
			.input(
				z.strictObject({
					approvalRequestIds: z.array(z.string().uuid()).min(1).max(25),
					expectedManifestHash: Sha256Schema,
					decisions: z
						.array(
							z.strictObject({
								approvalRequestId: z.string().uuid(),
								expectedCanonicalInputHash: Sha256Schema,
								decision: z.enum(["approve", "veto"]),
								resolution: z
									.string()
									.max(2000)
									.optional()
									.describe(
										"Optional operator rationale; omission records the explicit decision without a free-text explanation.",
									),
							}),
						)
						.min(1)
						.max(25),
				}),
			)
			.output(
				z.object({
					manifest: ApprovalReviewManifestSchema,
					results: z.array(ApprovalReviewDecisionResultSchema),
				}),
			),

		/**
		 * Resolve an approval request (approve or reject)
		 * POST /tedi-approvals/{id}/resolve
		 */
		resolve: oc
			.route({
				method: "POST",
				path: "/{id}/resolve",
				summary: "Resolve approval request",
				description:
					"Approve or reject a pending approval request. Only pending requests can be resolved.",
			})
			.input(
				z.object({
					id: z.uuid(),
					status: z.enum(["approved", "rejected"]),
					resolution: z.string().max(2000).optional(),
				}),
			)
			.output(ApprovalRequestSchema),

		/**
		 * Cancel a pending approval request (tedi withdraws its own request)
		 * POST /tedi-approvals/{id}/cancel
		 */
		cancel: oc
			.route({
				method: "POST",
				path: "/{id}/cancel",
				summary: "Cancel approval request",
				description:
					"Cancel a pending approval request. Only the requesting tedi or an org member can cancel.",
			})
			.input(
				z.object({
					id: z.uuid(),
					reason: z.string().max(2000).optional(),
				}),
			)
			.output(ApprovalRequestSchema),
	});

export type TediApprovalsContract = typeof tediApprovalsContract;
