/**
 * oRPC Tedi Approvals Router
 * Human-in-the-loop approval queue for tedi governance
 *
 * REST Endpoints:
 * POST   /tedi-approvals                  - Create approval request (internal/service)
 * GET    /tedi-approvals                  - List approval requests (user auth)
 * GET    /tedi-approvals/{id}             - Get approval request (user auth)
 * POST   /tedi-approvals/{id}/resolve     - Resolve approval request (user auth)
 */

import { implement } from "@orpc/server";
import {
	ApprovalProvenanceSchema,
	type ApprovalReviewManifest,
	type ApprovalRequest,
	type ProvisionalOutcome,
	tediApprovalsContract,
} from "@tedix/api-contract/contracts/tedi-approvals";
import {
	hasApprovalProvenanceRequest,
	listApprovalSimulationPage,
	listApprovalExecutionReceiptPage,
	invalidateApprovalDependency,
	listActiveApprovalDependencies,
	listApprovalExecutionReceipts,
} from "@tedix/db/queries/approval-simulations";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import {
	resolveRuntimeApprovalTimeout,
	runtimeApprovalAuditAction,
	runtimeApprovalReviewSemantics,
} from "@tedix/api-contract/utils/approval-policy";
import {
	createApprovalRequest,
	createProvisionalOutcome,
	ensureProvisionalPromotionApprovalRequest,
	getApprovalRequestById,
	getProvisionalOutcomeById,
	listApprovalRequests,
	listProvisionalOutcomes,
	resolveApprovalRequest,
	rollbackProvisionalOutcome,
} from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type {
	TediApprovalRequest as DbApprovalRequest,
	TediProvisionalOutcome as DbProvisionalOutcome,
} from "@tedix/db/schema/approvals";
import { toJsonRecord } from "@tedix/db/utils/json";
import { canonicalDigest } from "../../lib/blueprint-digest";
import { recordObservedLearningInteraction } from "../../services/learning-interaction-recorder";
import {
	executeApprovedProvisionalPromotion,
	isApprovedProvisionalPromotion,
	provisionalOutcomeRecordHash,
	provisionalPromotionApprovalRequestId,
} from "../../services/provisional-outcome-promotion";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withServiceAuth,
	withTediAuth,
} from "../orpc";
import { settleHomeToolWriteApproval } from "./kernel/write-approval-settlement";
import { requireOrgId } from "../org-scope";

// =============================================================================
// IMPLEMENTER
// =============================================================================

const approvalsOs = implement(tediApprovalsContract).$context<BaseContext>();
const authedOs = approvalsOs.use(withAuth);
const tediOs = approvalsOs.use(withTediAuth);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get org ID from context (user auth) or return null (service binding).
 * Service binding callers verify ownership via the record's orgId instead.
 */
function getOrganizationId(context: BaseContext): string | null {
	return context.organizationId ?? null;
}

export function canCancelOwnApproval(
	contextTediId: string | undefined,
	requestTediId: string,
): boolean {
	return Boolean(contextTediId && contextTediId === requestTediId);
}

function assertApprovalStillPending(input: {
	status: string;
	expiresAt: string;
}): void {
	const timeout = resolveRuntimeApprovalTimeout(input);
	if (!timeout.expired) return;
	throw createError(
		ErrorCodes.BAD_REQUEST,
		`This approval request has expired; timeout policy defaulted to deny (${timeout.reason})`,
	);
}

function parseApprovalPayload(value: unknown): Record<string, JsonValue> {
	const parsed = JsonValueSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data === null ||
		typeof parsed.data !== "object" ||
		Array.isArray(parsed.data)
	) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Stored approval payload is not valid JSON object data",
		);
	}
	return parsed.data;
}

function normalizeApprovalRequest(row: DbApprovalRequest): ApprovalRequest {
	const payload = parseApprovalPayload(row.payload);
	return {
		id: row.id,
		tediId: row.tediId,
		orgId: row.orgId,
		actionType: row.actionType,
		description: row.description,
		payload,
		status: row.status,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		resolvedAt: row.resolvedAt,
		resolvedBy: row.resolvedBy,
		resolution: row.resolution,
		workflowId: row.workflowId,
		review: runtimeApprovalReviewSemantics({
			id: row.id,
			tediId: row.tediId,
			actionType: row.actionType,
			description: row.description,
			payload,
			status: row.status,
			expiresAt: row.expiresAt,
			workflowId: row.workflowId,
		}),
	};
}

async function approvalInputHash(row: DbApprovalRequest): Promise<string> {
	return `sha256:${await canonicalDigest({
		id: row.id,
		tediId: row.tediId,
		orgId: row.orgId,
		actionType: row.actionType,
		description: row.description,
		payload: row.payload,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		workflowId: row.workflowId,
	})}`;
}

async function collectHardDescendants(
	context: BaseContext,
	organizationId: string,
	rootId: string,
): Promise<{ approvalIds: string[]; declarationIds: string[] }> {
	const seen = new Set([rootId]);
	const approvalIds: string[] = [];
	const declarationIds: string[] = [];
	let frontier = [rootId];
	while (frontier.length > 0) {
		if (seen.size > 500) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Approval dependency cascade exceeds the supported review bound",
			);
		}
		const edges = await listActiveApprovalDependencies(context.db, {
			organizationId,
			approvalRequestIds: frontier,
			relation: "prerequisite",
		});
		const next: string[] = [];
		for (const edge of edges) {
			if (edge.dependencyKind !== "hard") continue;
			declarationIds.push(edge.id);
			if (seen.has(edge.dependentApprovalRequestId)) continue;
			seen.add(edge.dependentApprovalRequestId);
			approvalIds.push(edge.dependentApprovalRequestId);
			next.push(edge.dependentApprovalRequestId);
		}
		frontier = next;
	}
	return { approvalIds, declarationIds };
}

async function collectHardDependencyComponent(
	context: BaseContext,
	organizationId: string,
	requestedIds: string[],
): Promise<{
	approvalRequestIds: string[];
	edges: Awaited<ReturnType<typeof listActiveApprovalDependencies>>;
}> {
	const approvalIds = new Set(requestedIds);
	const edgesById = new Map<
		string,
		Awaited<ReturnType<typeof listActiveApprovalDependencies>>[number]
	>();
	let frontier = requestedIds;
	while (frontier.length > 0) {
		const edges = await listActiveApprovalDependencies(context.db, {
			organizationId,
			approvalRequestIds: frontier,
			relation: "either",
		});
		const next = new Set<string>();
		for (const edge of edges) {
			edgesById.set(edge.id, edge);
			if (edge.dependencyKind !== "hard") continue;
			for (const id of [
				edge.prerequisiteApprovalRequestId,
				edge.dependentApprovalRequestId,
			]) {
				if (approvalIds.has(id)) continue;
				if (approvalIds.size >= 25) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Hard approval dependency component exceeds the 25-action review limit",
					);
				}
				approvalIds.add(id);
				next.add(id);
			}
		}
		frontier = [...next];
	}
	return {
		approvalRequestIds: [...approvalIds],
		edges: [...edgesById.values()],
	};
}

function orderApprovalsByDependencies(
	approvals: DbApprovalRequest[],
	edges: Awaited<ReturnType<typeof listActiveApprovalDependencies>>,
): DbApprovalRequest[] {
	const byId = new Map(approvals.map((approval) => [approval.id, approval]));
	const prerequisiteIds = new Map(
		approvals.map((approval) => [approval.id, new Set<string>()]),
	);
	const dependentIds = new Map(
		approvals.map((approval) => [approval.id, new Set<string>()]),
	);
	for (const edge of edges) {
		if (
			edge.dependencyKind !== "hard" ||
			!byId.has(edge.prerequisiteApprovalRequestId) ||
			!byId.has(edge.dependentApprovalRequestId)
		)
			continue;
		prerequisiteIds
			.get(edge.dependentApprovalRequestId)
			?.add(edge.prerequisiteApprovalRequestId);
		dependentIds
			.get(edge.prerequisiteApprovalRequestId)
			?.add(edge.dependentApprovalRequestId);
	}
	const compare = (left: DbApprovalRequest, right: DbApprovalRequest) =>
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id);
	const ready = approvals
		.filter((approval) => prerequisiteIds.get(approval.id)?.size === 0)
		.sort(compare);
	const ordered: DbApprovalRequest[] = [];
	while (ready.length > 0) {
		const approval = ready.shift();
		if (!approval) break;
		ordered.push(approval);
		for (const dependentId of dependentIds.get(approval.id) ?? []) {
			const remaining = prerequisiteIds.get(dependentId);
			remaining?.delete(approval.id);
			if (remaining?.size === 0) {
				const dependent = byId.get(dependentId);
				if (dependent) ready.push(dependent);
				ready.sort(compare);
			}
		}
	}
	if (ordered.length !== approvals.length) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Approval dependency graph contains a cycle",
		);
	}
	return ordered;
}

export async function buildApprovalReviewManifest(
	context: BaseContext,
	organizationId: string,
	approvalRequestIds: string[],
): Promise<ApprovalReviewManifest> {
	const uniqueIds = [...new Set(approvalRequestIds)];
	if (uniqueIds.length !== approvalRequestIds.length)
		throw createError(ErrorCodes.BAD_REQUEST, "Approval ids must be unique");
	const requestedIds = new Set(uniqueIds);
	const component = await collectHardDependencyComponent(
		context,
		organizationId,
		uniqueIds,
	);
	const rows = await Promise.all(
		component.approvalRequestIds.map((id) =>
			getApprovalRequestById(context.db, id),
		),
	);
	if (
		rows.some(
			(row, index) =>
				requestedIds.has(component.approvalRequestIds[index]!) &&
				(!row || row.orgId !== organizationId),
		)
	) {
		throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
	}
	if (rows.some((row) => !row || row.orgId !== organizationId)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Hard approval dependency component is incomplete",
		);
	}
	const edges = component.edges;
	const approvals = orderApprovalsByDependencies(
		rows as DbApprovalRequest[],
		edges,
	);
	const actions = await Promise.all(
		approvals.map(async (approval, order) => {
			const [receipts, cascade] = await Promise.all([
				listApprovalExecutionReceipts(context.db, {
					organizationId,
					approvalRequestId: approval.id,
				}),
				collectHardDescendants(context, organizationId, approval.id),
			]);
			const executableInputHash =
				approval.payload.kind === "home_tool_write"
					? `sha256:${await canonicalDigest(approval.payload)}`
					: null;
			const receipt = executableInputHash
				? receipts.findLast(
						(candidate) => candidate.canonicalInputHash === executableInputHash,
					)
				: receipts.at(-1);
			const executionState = receipt
				? receipt.outcome === "succeeded"
					? "succeeded"
					: "failed"
				: approval.status === "approved"
					? "unknown"
					: "none";
			return {
				order,
				inclusion: requestedIds.has(approval.id)
					? ("requested" as const)
					: ("hard_dependency_component" as const),
				canonicalInputHash: await approvalInputHash(approval),
				approval: normalizeApprovalRequest(approval),
				dependencies: edges
					.filter((edge) => edge.dependentApprovalRequestId === approval.id)
					.map((edge) => ({
						declarationEventId: edge.id,
						prerequisiteApprovalRequestId: edge.prerequisiteApprovalRequestId,
						kind: edge.dependencyKind,
						enforcement: "unsupported_baseline_verifier" as const,
					})),
				vetoCascadeApprovalRequestIds: cascade.approvalIds.sort(),
				execution: {
					state: executionState as "none" | "succeeded" | "failed" | "unknown",
					receiptId: receipt?.id ?? null,
				},
			};
		}),
	);
	const snapshot = { actions };
	return {
		manifestHash: `sha256:${await canonicalDigest(snapshot)}`,
		generatedAt: new Date().toISOString(),
		actions,
	};
}

export function normalizeProvisionalOutcome(
	row: DbProvisionalOutcome,
): ProvisionalOutcome {
	return {
		id: row.id,
		tediId: row.tediId,
		orgId: row.orgId,
		conversationId: row.conversationId,
		runId: row.runId,
		kind: row.kind,
		state: row.state,
		title: row.title,
		payload: parseApprovalPayload(row.payload),
		createdAt: row.createdAt,
		promotionApprovalRequestId: row.promotionApprovalRequestId,
		promotedAt: row.promotedAt,
		promotedBy: row.promotedBy,
		rolledBackAt: row.rolledBackAt,
		rolledBackBy: row.rolledBackBy,
		rollbackReason: row.rollbackReason,
	};
}

/** Wake the durable continuation after D1 records the resolution latch. */
export async function signalApprovalWorkflow(
	context: BaseContext,
	approval: DbApprovalRequest,
): Promise<void> {
	if (!approval.workflowId) return;
	try {
		const instance = await context.env.APPROVAL_WORKFLOW.get(
			approval.workflowId,
		);
		await instance.sendEvent({
			type: "approval-resolution",
			payload: {
				approvalRequestId: approval.id,
				status: approval.status,
			},
		});
	} catch (error) {
		// D1 is canonical and the Workflow also polls it after event timeouts.
		// A failed event only adds latency; it never loses the resolution.
		console.error("Failed to signal approval workflow:", error);
	}
}

// =============================================================================
// PROCEDURES
// =============================================================================

const createProvisionalOutcomeProcedure = approvalsOs.createProvisionalOutcome
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const tedi = await getTediByIdForOrganization(
			context.db,
			input.tediId,
			input.orgId,
		);
		if (!tedi) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Tedi is outside this organization",
			);
		}
		const created = await createProvisionalOutcome(context.db, {
			...input,
			id: crypto.randomUUID(),
			payload: toJsonRecord(input.payload),
			createdAt: new Date().toISOString(),
		});
		await insertAuditEvent(context.db, {
			organizationId: input.orgId,
			actorId: input.tediId,
			actorType: "tedi",
			action: "provisional_outcome.recorded",
			resourceType: "provisional_outcome",
			resourceId: created.id,
			metadata: { kind: input.kind },
		});
		return normalizeProvisionalOutcome(created);
	});

const listProvisionalOutcomesProcedure = authedOs.listProvisionalOutcomes
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context, "provisional outcomes");
		if (input.tediId) {
			const tedi = await getTediByIdForOrganization(
				context.db,
				input.tediId,
				orgId,
			);
			if (!tedi) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Tedi is outside this organization",
				);
			}
		}
		const rows = await listProvisionalOutcomes(context.db, {
			orgId,
			tediId: input.tediId,
			limit: input.limit,
		});
		return { data: rows.map(normalizeProvisionalOutcome) };
	});

const requestProvisionalOutcomePromotionProcedure =
	approvalsOs.requestProvisionalOutcomePromotion
		.use(withServiceAuth)
		.handler(async ({ input, context }) => {
			const outcome = await getProvisionalOutcomeById(context.db, input.id);
			if (
				!outcome ||
				outcome.orgId !== input.orgId ||
				outcome.tediId !== input.tediId
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Provisional outcome is outside the requested organization or tedi",
				);
			}
			if (outcome.state !== "provisional") {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Only a provisional outcome can request promotion",
				);
			}
			const now = new Date();
			const approvalRequestId = await provisionalPromotionApprovalRequestId(
				outcome.id,
			);
			const workflowId = `approval-${approvalRequestId}`;
			const ensured = await ensureProvisionalPromotionApprovalRequest(
				context.db,
				{
					id: approvalRequestId,
					provisionalOutcomeId: outcome.id,
					provisionalOutcomeHash: await provisionalOutcomeRecordHash(outcome),
					tediId: outcome.tediId,
					orgId: outcome.orgId,
					description: `Promote provisional ${outcome.kind}: ${outcome.title}`,
					createdAt: now.toISOString(),
					expiresAt: new Date(
						now.getTime() + input.ttlHours * 60 * 60 * 1000,
					).toISOString(),
					workflowId,
				},
			);
			if (ensured.created) {
				try {
					await context.env.APPROVAL_WORKFLOW.create({
						id: workflowId,
						params: {
							approvalRequestId,
							tediId: outcome.tediId,
							orgId: outcome.orgId,
							ttlHours: input.ttlHours,
						},
					});
				} catch (error) {
					console.error("Failed to start approval workflow:", error);
				}
				await insertAuditEvent(context.db, {
					organizationId: outcome.orgId,
					actorId: outcome.tediId,
					actorType: "tedi",
					action: "approval.requested",
					resourceType: "approval_request",
					resourceId: approvalRequestId,
					metadata: {
						actionType: "provisional_outcome_promotion",
						provisionalOutcomeId: outcome.id,
					},
				});
			}
			return normalizeApprovalRequest(ensured.request);
		});

const promoteProvisionalOutcomeProcedure = authedOs.promoteProvisionalOutcome
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context, "provisional outcome promotion");
		const [outcome, approval] = await Promise.all([
			getProvisionalOutcomeById(context.db, input.id),
			getApprovalRequestById(context.db, input.approvalRequestId),
		]);
		if (!outcome || outcome.orgId !== orgId)
			throw createError(ErrorCodes.NOT_FOUND, "Provisional outcome not found");
		if (
			!approval ||
			!isApprovedProvisionalPromotion(
				approval,
				outcome,
				await provisionalOutcomeRecordHash(outcome),
			)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"An approved typed promotion request for this outcome is required",
			);
		const actorId =
			context.user?.sub ??
			context.gatewayEndUserId ??
			context.authType ??
			"unknown";
		const promotion = await executeApprovedProvisionalPromotion(context.db, {
			approval,
			actorId,
		});
		if (!promotion)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a provisional outcome can be promoted",
			);
		if (!promotion.replayed) {
			await insertAuditEvent(context.db, {
				organizationId: orgId,
				actorId,
				actorType: "user",
				action: "provisional_outcome.promoted",
				resourceType: "provisional_outcome",
				resourceId: outcome.id,
				metadata: {
					approvalRequestId: approval.id,
					executionReceiptId: promotion.receiptId,
				},
			});
		}
		return normalizeProvisionalOutcome(promotion.outcome);
	});

const rollbackProvisionalOutcomeProcedure = authedOs.rollbackProvisionalOutcome
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context, "provisional outcome rollback");
		const actorId =
			context.user?.sub ??
			context.gatewayEndUserId ??
			context.authType ??
			"unknown";
		const rolledBack = await rollbackProvisionalOutcome(context.db, {
			id: input.id,
			orgId,
			actorId,
			at: new Date().toISOString(),
			reason: input.reason,
		});
		if (!rolledBack)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a promoted outcome in this organization can be rolled back",
			);
		await insertAuditEvent(context.db, {
			organizationId: orgId,
			actorId,
			actorType: "user",
			action: "provisional_outcome.rolled_back",
			resourceType: "provisional_outcome",
			resourceId: input.id,
			metadata: { reason: input.reason },
		});
		return normalizeProvisionalOutcome(rolledBack);
	});

/**
 * Create an approval request (internal — called by tedi via service binding or workflow)
 */
const createApprovalProcedure = approvalsOs.create
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + input.ttlHours * 60 * 60 * 1000);
		const id = crypto.randomUUID();
		const workflowId = `approval-${id}`;

		const request = await createApprovalRequest(context.db, {
			id,
			tediId: input.tediId,
			orgId: input.orgId,
			actionType: input.actionType,
			description: input.description,
			payload: toJsonRecord(input.payload),
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			workflowId,
		});

		// The row exists before the Workflow can read it, closing the startup race.
		try {
			await context.env.APPROVAL_WORKFLOW.create({
				id: workflowId,
				params: {
					approvalRequestId: id,
					tediId: input.tediId,
					orgId: input.orgId,
					ttlHours: input.ttlHours,
				},
			});
		} catch (error) {
			console.error("Failed to start approval workflow:", error);
		}

		// Emit audit event
		await insertAuditEvent(context.db, {
			organizationId: input.orgId,
			actorId: input.tediId,
			actorType: "tedi",
			action: "approval.requested",
			resourceType: "approval_request",
			resourceId: id,
			metadata: {
				actionType: input.actionType,
				description: input.description,
				ttlHours: input.ttlHours,
			},
		});
		return normalizeApprovalRequest(request);
	});

/**
 * List approval requests (user auth — Tedix OS Activity)
 */
const listApprovalsProcedure = authedOs.list
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);

		// Service binding calls must filter by tediId (no org context available)
		if (!orgId && !input?.tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required for service binding calls",
			);
		}

		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;

		const { data, total } = await listApprovalRequests(context.db, {
			orgId: orgId ?? undefined,
			tediId: input?.tediId,
			status: input?.status,
			actionType: input?.actionType,
			limit,
			offset,
		});

		return {
			data: data.map(normalizeApprovalRequest),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Get a single approval request by ID
 */
const getByIdProcedure = authedOs.getById
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);

		const request = await getApprovalRequestById(context.db, input.id);
		if (!request) {
			throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
		}

		// Verify org ownership for user auth callers
		if (orgId && request.orgId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Access denied to this approval request",
			);
		}

		return normalizeApprovalRequest(request);
	});

const getProvenanceProcedure = authedOs.getProvenance
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) => {
		const scope = {
			organizationId: requireOrgId(context, "approval provenance"),
			approvalRequestId: input.approvalRequestId,
		};
		if (!(await hasApprovalProvenanceRequest(context.db, scope))) {
			throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
		}
		const [simulations, executionReceipts] = await Promise.all([
			listApprovalSimulationPage(context.db, scope, input.simulations),
			listApprovalExecutionReceiptPage(
				context.db,
				scope,
				input.executionReceipts,
			),
		]);
		return ApprovalProvenanceSchema.parse({
			approvalRequestId: input.approvalRequestId,
			simulations,
			executionReceipts: {
				...executionReceipts,
				records: executionReceipts.records.map((receipt) => ({
					...receipt,
					evidenceKind: "execution_receipt",
				})),
			},
		});
	});

const getReviewManifestProcedure = authedOs.getReviewManifest
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) =>
		buildApprovalReviewManifest(
			context,
			requireOrgId(context, "approval manifest review"),
			input.approvalRequestIds,
		),
	);

const resolveReviewManifestProcedure = authedOs.resolveReviewManifest
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context, "approval manifest review");
		const manifest = await buildApprovalReviewManifest(
			context,
			organizationId,
			input.approvalRequestIds,
		);
		if (manifest.manifestHash !== input.expectedManifestHash) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Approval review changed; reload the manifest before deciding",
			);
		}
		const actionById = new Map(
			manifest.actions.map((action) => [action.approval.id, action]),
		);
		if (
			new Set(input.decisions.map((decision) => decision.approvalRequestId))
				.size !== input.decisions.length ||
			input.decisions.some(
				(decision) =>
					!actionById.has(decision.approvalRequestId) ||
					actionById.get(decision.approvalRequestId)?.canonicalInputHash !==
						decision.expectedCanonicalInputHash,
			)
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Approval decisions do not match the reviewed manifest",
			);
		}
		const principalByApprovalId = new Map<string, string>();
		const idsToValidate = new Set(
			input.decisions.flatMap((decision) => {
				const action = actionById.get(decision.approvalRequestId);
				return [
					decision.approvalRequestId,
					...(decision.decision === "veto"
						? (action?.vetoCascadeApprovalRequestIds ?? [])
						: []),
				];
			}),
		);
		for (const approvalRequestId of idsToValidate) {
			const row = await getApprovalRequestById(context.db, approvalRequestId);
			if (!row || row.orgId !== organizationId) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Approval review changed; reload the manifest before deciding",
				);
			}
			const reviewed = actionById.get(approvalRequestId);
			if (
				reviewed &&
				(await approvalInputHash(row)) !== reviewed.canonicalInputHash
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Approval review changed; reload the manifest before deciding",
				);
			}
			principalByApprovalId.set(
				approvalRequestId,
				resolveApprovalPrincipal(context, row),
			);
		}
		const results: Array<{
			approvalRequestId: string;
			outcome:
				| "approved"
				| "vetoed"
				| "cascade_cancelled"
				| "blocked"
				| "failed"
				| "unknown"
				| "conflict";
			reason: string;
		}> = [];

		// Vetoes are durable before the first approval can execute.
		for (const decision of input.decisions.filter(
			(decision) => decision.decision === "veto",
		)) {
			const resolvedBy = principalByApprovalId.get(decision.approvalRequestId);
			if (!resolvedBy) throw new Error("Missing validated approval principal");
			const row = await getApprovalRequestById(
				context.db,
				decision.approvalRequestId,
			);
			const rejected = await resolveApprovalRequest(
				context.db,
				decision.approvalRequestId,
				{
					status: "rejected",
					resolvedBy,
					resolution: decision.resolution,
				},
			);
			if (!row || !rejected) {
				results.push({
					approvalRequestId: decision.approvalRequestId,
					outcome: "conflict",
					reason: "Approval was no longer pending",
				});
				continue;
			}
			await signalApprovalWorkflow(context, rejected);
			await settleHomeToolWriteApproval(context, {
				approval: rejected,
				status: "rejected",
			});
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: resolvedBy,
				actorType: context.authType === "service-binding" ? "service" : "user",
				action: runtimeApprovalAuditAction({ status: "rejected" }),
				resourceType: "approval_request",
				resourceId: rejected.id,
				metadata: toJsonRecord({
					tediId: rejected.tediId,
					actionType: rejected.actionType,
					resolution: decision.resolution,
					reviewManifestHash: input.expectedManifestHash,
				}),
			});
			results.push({
				approvalRequestId: rejected.id,
				outcome: "vetoed",
				reason: decision.resolution ?? "Operator vetoed the action",
			});

			let frontier = [rejected.id];
			const seen = new Set(frontier);
			while (frontier.length > 0) {
				if (seen.size > 500) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Approval dependency cascade exceeds the supported review bound",
					);
				}
				const edges = await listActiveApprovalDependencies(context.db, {
					organizationId,
					approvalRequestIds: frontier,
					relation: "prerequisite",
				});
				const next: string[] = [];
				for (const edge of edges.filter(
					(candidate) => candidate.dependencyKind === "hard",
				)) {
					const dependent = await getApprovalRequestById(
						context.db,
						edge.dependentApprovalRequestId,
					);
					if (!dependent || dependent.orgId !== organizationId) {
						results.push({
							approvalRequestId: edge.dependentApprovalRequestId,
							outcome: "conflict",
							reason: "Dependent approval could not be safely loaded",
						});
						continue;
					}
					if (dependent?.status === "pending") {
						const cascadeResolvedBy = principalByApprovalId.get(dependent.id);
						if (!cascadeResolvedBy)
							throw new Error("Missing validated cascade principal");
						const cancelled = await resolveApprovalRequest(
							context.db,
							dependent.id,
							{
								status: "cancelled",
								resolvedBy: cascadeResolvedBy,
								resolution: `Cancelled because prerequisite ${rejected.id} was vetoed`,
							},
						);
						if (cancelled) {
							await signalApprovalWorkflow(context, cancelled);
							await settleHomeToolWriteApproval(context, {
								approval: cancelled,
								status: "cancelled",
							});
							results.push({
								approvalRequestId: cancelled.id,
								outcome: "cascade_cancelled",
								reason: `Hard prerequisite ${rejected.id} was vetoed`,
							});
							await insertAuditEvent(context.db, {
								organizationId,
								actorId: cascadeResolvedBy,
								actorType:
									context.authType === "service-binding" ? "service" : "user",
								action: runtimeApprovalAuditAction({ status: "cancelled" }),
								resourceType: "approval_request",
								resourceId: cancelled.id,
								metadata: toJsonRecord({
									tediId: cancelled.tediId,
									actionType: cancelled.actionType,
									vetoedApprovalRequestId: rejected.id,
									reviewManifestHash: input.expectedManifestHash,
								}),
							});
						} else {
							results.push({
								approvalRequestId: dependent.id,
								outcome: "conflict",
								reason:
									"Dependent approval changed before cascade cancellation",
							});
							continue;
						}
					} else if (dependent.status === "approved") {
						results.push({
							approvalRequestId: dependent.id,
							outcome: "conflict",
							reason: "Dependent approval was already approved before the veto",
						});
						continue;
					}
					// Invalidate only after cancellation is durable. A crash before this
					// point leaves the active hard edge blocking every legacy resolver.
					await invalidateApprovalDependency(context.db, {
						id: crypto.randomUUID(),
						organizationId,
						dependentApprovalRequestId: edge.dependentApprovalRequestId,
						declarationEventId: edge.id,
						reason: `Prerequisite ${rejected.id} was vetoed`,
						recordHash: `sha256:${await canonicalDigest({ edgeId: edge.id, vetoedApprovalRequestId: rejected.id })}`,
						createdAt: new Date().toISOString(),
					});
					if (!seen.has(edge.dependentApprovalRequestId)) {
						seen.add(edge.dependentApprovalRequestId);
						next.push(edge.dependentApprovalRequestId);
					}
				}
				frontier = next;
			}
		}

		for (const action of manifest.actions) {
			const decision = input.decisions.find(
				(candidate) =>
					candidate.approvalRequestId === action.approval.id &&
					candidate.decision === "approve",
			);
			if (!decision) continue;
			const resolvedBy = principalByApprovalId.get(action.approval.id);
			if (!resolvedBy) throw new Error("Missing validated approval principal");
			if (
				action.dependencies.some((dependency) => dependency.kind === "hard")
			) {
				results.push({
					approvalRequestId: action.approval.id,
					outcome: "blocked",
					reason: "Hard dependency has no supported baseline verifier",
				});
				continue;
			}
			const row = await getApprovalRequestById(context.db, action.approval.id);
			if (!row) continue;
			const approved = await resolveApprovalRequest(context.db, row.id, {
				status: "approved",
				resolvedBy,
				resolution: decision.resolution,
			});
			if (!approved) {
				results.push({
					approvalRequestId: row.id,
					outcome: "conflict",
					reason: "Approval was no longer pending or is blocked",
				});
				continue;
			}
			await signalApprovalWorkflow(context, approved);
			await settleHomeToolWriteApproval(context, {
				approval: approved,
				status: "approved",
			});
			let promotionFailed = false;
			if (approved.actionType === "provisional_outcome_promotion") {
				try {
					const promotion = await executeApprovedProvisionalPromotion(
						context.db,
						{
							approval: approved,
							actorId: resolvedBy,
						},
					);
					if (!promotion) {
						promotionFailed = true;
					} else if (!promotion.replayed) {
						await insertAuditEvent(context.db, {
							organizationId: approved.orgId,
							actorId: resolvedBy,
							actorType: "user",
							action: "provisional_outcome.promoted",
							resourceType: "provisional_outcome",
							resourceId: promotion.outcome.id,
							metadata: {
								approvalRequestId: approved.id,
								executionReceiptId: promotion.receiptId,
							},
						});
					}
				} catch (error) {
					console.error("Failed to settle provisional promotion:", error);
					promotionFailed = true;
				}
			}
			await insertAuditEvent(context.db, {
				organizationId,
				actorId: resolvedBy,
				actorType: context.authType === "service-binding" ? "service" : "user",
				action: runtimeApprovalAuditAction({ status: "approved" }),
				resourceType: "approval_request",
				resourceId: approved.id,
				metadata: toJsonRecord({
					tediId: approved.tediId,
					actionType: approved.actionType,
					reviewManifestHash: input.expectedManifestHash,
				}),
			});
			results.push({
				approvalRequestId: approved.id,
				outcome: promotionFailed ? "failed" : "approved",
				reason: promotionFailed
					? "Approval was recorded but provisional promotion failed"
					: "Approval was recorded and settlement was invoked",
			});
		}
		const settledManifest = await buildApprovalReviewManifest(
			context,
			organizationId,
			input.approvalRequestIds,
		);
		for (const result of results) {
			if (result.outcome !== "approved") continue;
			const settled = settledManifest.actions.find(
				(action) => action.approval.id === result.approvalRequestId,
			);
			if (settled?.approval.payload.kind !== "home_tool_write") continue;
			if (settled.execution.state === "failed") {
				result.outcome = "failed";
				result.reason = "The approved provider write recorded a failed receipt";
			} else if (settled.execution.state !== "succeeded") {
				result.outcome = "unknown";
				result.reason =
					"Approval ownership was recorded but no successful receipt exists; the provider call will not be retried automatically";
			}
		}
		return {
			manifest: settledManifest,
			results,
		};
	});

/**
 * Resolve an approval request (approve or reject)
 */
export function resolveApprovalPrincipal(
	context: Pick<
		BaseContext,
		"authType" | "gatewayEndUserId" | "tediId" | "user"
	>,
	request: Pick<DbApprovalRequest, "payload">,
): string {
	if (
		request.payload.kind === "product_motion_rig_admission_v1" ||
		request.payload.kind === "payment_budget_override"
	) {
		if (context.authType !== "user" || context.tediId || !context.user?.sub) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This approval requires an authenticated human approver",
			);
		}
		return `user:${context.user.sub}`;
	}
	if (context.gatewayEndUserId) return `user:${context.gatewayEndUserId}`;
	return context.user?.sub ?? context.authType ?? "unknown";
}

// The same interned guard the approval-rules manage/sweep surface uses:
// os:approve (or settings:manage) for humans, mcp:memory.admin for machines.
// `approvalRules.apply` invokes this procedure per match, so the two guards
// must stay identical.
const resolveProcedure = authedOs.resolve
	.use(AUTHZ.osApprove)
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);

		const existing = await getApprovalRequestById(context.db, input.id);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
		}
		if (orgId && existing.orgId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Access denied to this approval request",
			);
		}
		if (
			existing.actionType === "payment_budget_override" &&
			orgId !== existing.orgId
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Budget override review requires membership in its organization",
			);
		}
		if (existing.status !== "pending") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Cannot resolve request with status "${existing.status}"`,
			);
		}

		assertApprovalStillPending(existing);

		const resolvedBy = resolveApprovalPrincipal(context, existing);

		const resolved = await resolveApprovalRequest(context.db, input.id, {
			status: input.status,
			resolvedBy,
			resolution: input.resolution,
		});

		if (!resolved) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Failed to resolve request. It may have already been resolved.",
			);
		}

		// Emit audit event
		await insertAuditEvent(context.db, {
			organizationId: orgId ?? existing.orgId,
			actorId: resolvedBy,
			actorType: context.authType === "service-binding" ? "service" : "user",
			action: runtimeApprovalAuditAction({ status: input.status }),
			resourceType: "approval_request",
			resourceId: input.id,
			metadata: toJsonRecord({
				tediId: resolved.tediId,
				actionType: resolved.actionType,
				resolution: input.resolution,
			}),
		});
		await signalApprovalWorkflow(context, resolved);

		// Home tool-write execution hook (v1): an approved "home_tool_write"
		// approval executes the SERVER-STORED call exactly once; a rejection
		// closes the Home run without executing. No-op for every other payload
		// kind. This runs strictly AFTER the pending→resolved transition above
		// (the exactly-once latch) and is fail-soft — execution failures land on
		// the Home run, never on this resolve response.
		await settleHomeToolWriteApproval(context, {
			approval: resolved,
			status: input.status,
		});
		if (
			input.status === "approved" &&
			resolved.actionType === "provisional_outcome_promotion"
		) {
			try {
				const promotion = await executeApprovedProvisionalPromotion(
					context.db,
					{
						approval: resolved,
						actorId: resolvedBy,
					},
				);
				if (promotion && !promotion.replayed) {
					await insertAuditEvent(context.db, {
						organizationId: resolved.orgId,
						actorId: resolvedBy,
						actorType: "user",
						action: "provisional_outcome.promoted",
						resourceType: "provisional_outcome",
						resourceId: promotion.outcome.id,
						metadata: {
							approvalRequestId: resolved.id,
							executionReceiptId: promotion.receiptId,
						},
					});
				}
			} catch (error) {
				console.error("Failed to settle provisional promotion:", error);
			}
		}
		await recordObservedLearningInteraction(context, {
			organizationId: orgId ?? existing.orgId,
			clientEventId: `approval:${resolved.id}:${input.status}`,
			signalClass: "governance",
			eventKind: input.status === "approved" ? "accepted" : "rejected",
			surface: "tedi-approvals",
			tediId: resolved.tediId,
			issueKey: `approval:${resolved.actionType}`,
			targetType: "approval_request",
			targetId: resolved.id,
			runId: resolved.workflowId ?? undefined,
			metadata: {
				actionType: resolved.actionType,
				status: input.status,
				hadResolution: Boolean(input.resolution),
			},
		});

		return normalizeApprovalRequest(resolved);
	});

/**
 * Cancel a pending approval request (tedi withdraws its own request)
 */
const cancelProcedure = tediOs.cancel.handler(async ({ input, context }) => {
	const orgId = getOrganizationId(context);

	const existing = await getApprovalRequestById(context.db, input.id);
	if (!existing) {
		throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
	}
	// Org-scope guard — mirror `resolveProcedure`. Without it any authenticated
	// tedi who learns an approval UUID from another org could cancel it,
	// closing that org's Home run before its gated write executes (cross-org DoS).
	if (orgId && existing.orgId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Access denied to this approval request",
		);
	}
	if (!canCancelOwnApproval(context.tediId, existing.tediId)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the requesting tedi can cancel this approval request",
		);
	}
	if (existing.status !== "pending") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Cannot cancel request with status "${existing.status}"`,
		);
	}

	const cancelledBy = context.user?.sub ?? context.authType ?? "unknown";

	const cancelled = await resolveApprovalRequest(context.db, input.id, {
		status: "cancelled",
		resolvedBy: cancelledBy,
		resolution: input.reason
			? `Cancelled: ${input.reason}`
			: "Cancelled by requester",
	});
	if (cancelled) {
		await recordObservedLearningInteraction(context, {
			organizationId: orgId ?? existing.orgId,
			clientEventId: `approval:${cancelled.id}:cancelled`,
			signalClass: "governance",
			eventKind: "undone",
			surface: "tedi-approvals",
			tediId: cancelled.tediId,
			issueKey: `approval:${cancelled.actionType}`,
			targetType: "approval_request",
			targetId: cancelled.id,
			runId: cancelled.workflowId ?? undefined,
			metadata: {
				actionType: cancelled.actionType,
				status: "cancelled",
				hadReason: Boolean(input.reason),
			},
		});
	}

	if (!cancelled) {
		throw createError(ErrorCodes.BAD_REQUEST, "Failed to cancel request");
	}

	await insertAuditEvent(context.db, {
		organizationId: existing.orgId,
		actorId: cancelledBy,
		actorType: context.authType === "service-binding" ? "service" : "user",
		action: runtimeApprovalAuditAction({ status: "cancelled" }),
		resourceType: "approval_request",
		resourceId: input.id,
		metadata: toJsonRecord({
			tediId: existing.tediId,
			actionType: existing.actionType,
			reason: input.reason,
		}),
	});
	await signalApprovalWorkflow(context, cancelled);

	// A cancelled "home_tool_write" approval closes the Home run without
	// executing — same non-execution path as a rejection.
	await settleHomeToolWriteApproval(context, {
		approval: cancelled,
		status: "cancelled",
	});

	return normalizeApprovalRequest(cancelled);
});

// =============================================================================
// CONTRACT ROUTER
// =============================================================================

export const tediApprovalsContractRouter = approvalsOs.router({
	createProvisionalOutcome: createProvisionalOutcomeProcedure,
	listProvisionalOutcomes: listProvisionalOutcomesProcedure,
	requestProvisionalOutcomePromotion:
		requestProvisionalOutcomePromotionProcedure,
	promoteProvisionalOutcome: promoteProvisionalOutcomeProcedure,
	rollbackProvisionalOutcome: rollbackProvisionalOutcomeProcedure,
	create: createApprovalProcedure,
	list: listApprovalsProcedure,
	getById: getByIdProcedure,
	getReviewManifest: getReviewManifestProcedure,
	getProvenance: getProvenanceProcedure,
	resolveReviewManifest: resolveReviewManifestProcedure,
	resolve: resolveProcedure,
	cancel: cancelProcedure,
});
