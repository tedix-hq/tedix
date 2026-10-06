import { createRouterClient } from "@orpc/server";
import { LOCAL_DEMO_PROJECT_ID } from "@tedix/auth/local-demo";
import * as skillCrudQueries from "@tedix/db/queries/cognitive/skill-crud";
import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import {
	findWorkItemsBlockedBy,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import {
	auditEvents,
	chatDispatchIdempotency,
	harnessSubjectTraceBundles,
	harnessSubjectVersions,
	kernelConversationGrants,
	kernelConversations,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelToolResults,
	runtimeSubmissionAttempts,
	runtimeSubmissions,
	tediApprovalRequests,
	tediArtifacts,
	tediRuntimeEvents,
	tedis,
	workItemComments,
	workAttempts,
	workEvents,
	workItemRelations,
	workItems,
} from "@tedix/db/schema";
import { policyPacks } from "@tedix/db/schema/control-plane";
import { tediApprovalExecutionReceipts } from "@tedix/db/schema/approval-simulations";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { assembleHomeContext } from "./kernel/context-assembly";
import {
	insertKernelRuntimeEvent,
	normalizeHomeRunRecord,
} from "./kernel/run-store";
import { createDelegationWorkItem } from "./kernel/delegation-work-item";
import type { KernelResult } from "./kernel/index";
import {
	clampPlanObjective,
	detectsHomePlanningRequest,
	type HomePlanningTarget,
	selectedHomePlanTargets,
} from "./kernel/plan-dispatch";
import type { KernelRouteDecision } from "./kernel/route-schema";
import { SKILL_REFERENCE_VERB } from "@tedix/api-contract/utils/skill-reference";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { resolveKernelWorkstationAttachWorkOrder } from "./kernel-runtime/control-proposals";
import { readChildRunStatuses } from "./kernel-runtime/run-reads-streams";
import { respondKernelDelegationRecommendationApprovalCore } from "./kernel-runtime/approval-control";
import { predictAgentRunId } from "./kernel/runtime-shared";
import { remainingKernelTurnBudgetMs } from "./kernel-runtime/policy-normalization";
import {
	augmentTreeWithFanoutChildren,
	buildFanoutChildNodes,
	readSingleChildRunSummary,
} from "./kernel/child-run-reads";
import {
	detectOperatorSlashCommand,
	explicitDelegationNeedsEmbodiedSurface,
	kernelRuntimeTestHooks,
} from "./kernel-runtime/policy-normalization";
import { kernelRuntimeContractRouter } from "./kernel-runtime";
import {
	proposeCodemodeExecuteImpl,
	proposeRepoCommitImpl,
} from "./kernel-runtime/control-proposals";
import {
	setKernelToolResultRetainerForTest,
	settleHomeToolWriteApproval,
} from "./kernel/write-approval-settlement";

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			expiresAt: new Date(
				Date.parse(input.now) + input.leaseTtlMs,
			).toISOString(),
			decision: "admitted" as const,
		})),
	};
});

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/attempts")
		>();
	return {
		...original,
		startWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					admissionId: string;
					executor: { type: "tedi" | "external_agent"; id: string };
					expiresAt?: string;
					metadata?: Record<string, unknown>;
					orgId: string;
					runId?: string;
					startedAt?: string;
					workItemId: string;
				},
			) => {
				const fake = db as {
					workAttemptRows: WorkAttemptRow[];
					workItemRows: WorkItemRow[];
				};
				const workItem = fake.workItemRows.find(
					(row) => row.id === input.workItemId,
				);
				if (!workItem) throw new Error(`Missing Work Item ${input.workItemId}`);
				const startedAt = input.startedAt ?? new Date().toISOString();
				const attempt = {
					id: crypto.randomUUID(),
					admissionId: input.admissionId,
					workItemId: input.workItemId,
					orgId: input.orgId,
					executorType: input.executor.type,
					executorId: input.executor.id,
					executorSessionId: null,
					externalSessionKey: null,
					runId: input.runId ?? null,
					runtimeState: "running",
					outcome: null,
					attemptNumber: fake.workAttemptRows.length + 1,
					startedAt,
					heartbeatAt: startedAt,
					expiresAt: input.expiresAt ?? null,
					finishedAt: null,
					summary: null,
					version: 1,
					metadata: input.metadata ?? {},
				} as WorkAttemptRow;
				fake.workAttemptRows.push(attempt);
				return { workItem, attempt, resumed: false };
			},
		),
		settleWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					attemptId: string;
					outcome: "succeeded" | "failed" | "cancelled";
					settledAt?: string;
					summary?: string;
				},
			) => {
				const fake = db as { workAttemptRows: WorkAttemptRow[] };
				const attempt = fake.workAttemptRows.find(
					(row) => row.id === input.attemptId,
				);
				if (!attempt)
					throw new Error(`Missing Work attempt ${input.attemptId}`);
				attempt.outcome = input.outcome;
				attempt.runtimeState =
					input.outcome === "succeeded"
						? "finished"
						: input.outcome === "failed"
							? "failed"
							: "cancelled";
				attempt.finishedAt = input.settledAt ?? new Date().toISOString();
				attempt.summary = input.summary ?? null;
				attempt.version += 1;
				return attempt;
			},
		),
	};
});

vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	submitWorkItemEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as { workEvidenceRows: Array<Record<string, any>> };
			const evidence = {
				id: crypto.randomUUID(),
				attemptId: input.attemptId ?? null,
				claimKey: input.claimKey,
				digest: input.digest ?? null,
				disposition: "pending",
				kind: input.kind,
				metadata: input.metadata ?? {},
				uri: input.uri,
				workItemId: input.workItemId,
			};
			fake.workEvidenceRows.push(evidence);
			return evidence;
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/projections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/projections")
	>()),
	listOrgWorkEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as {
				workEvidenceRows: Array<Record<string, any>>;
				workItemRows: WorkItemRow[];
			};
			return {
				data: fake.workEvidenceRows
					.filter(
						(row) =>
							row.workItemId === input.workItemId &&
							row.attemptId === input.attemptId,
					)
					.map((evidence) => ({
						evidence,
						workItem: fake.workItemRows.find(
							(item) => item.id === evidence.workItemId,
						),
					})),
				nextCursor: null,
				observedAt: new Date().toISOString(),
			};
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	completeWorkItem: vi.fn(async (db: unknown, input: Record<string, any>) => {
		const fake = db as { workItemRows: WorkItemRow[] };
		const item = fake.workItemRows.find((row) => row.id === input.workItemId);
		if (!item) throw new Error(`Missing Work Item ${input.workItemId}`);
		item.disposition = "completed";
		return item;
	}),
}));

const ORG_ID = "org-1";
const NATIVE_EXECUTION_REQUIREMENT: ExecutionRequirement = {
	surface: "native",
	requiredCapabilities: ["repository_read"],
	fallbackSurface: "workstation",
	prohibitedSurfaces: [],
	satisfiable: true,
	reason: "The test work order is executable on the native agent surface.",
};
const WORKSTATION_EXECUTION_REQUIREMENT: ExecutionRequirement = {
	surface: "workstation",
	requiredCapabilities: ["process"],
	fallbackSurface: null,
	prohibitedSurfaces: [],
	satisfiable: true,
	reason: "The test work order requires an interactive process.",
};

type KernelRuntimeEventRow = typeof kernelRuntimeEvents.$inferSelect;
type KernelRuntimeEventInsert = typeof kernelRuntimeEvents.$inferInsert;
type KernelRuntimeRunRow = typeof kernelRuntimeRuns.$inferSelect;
type KernelRuntimeRunInsert = typeof kernelRuntimeRuns.$inferInsert;
type KernelConversationGrantRow = typeof kernelConversationGrants.$inferSelect;
type KernelConversationRow = typeof kernelConversations.$inferSelect;
type KernelConversationInsert = typeof kernelConversations.$inferInsert;
type TediApprovalRequestRow = typeof tediApprovalRequests.$inferSelect;
type TediApprovalRequestInsert = typeof tediApprovalRequests.$inferInsert;
type WorkItemRow = typeof workItems.$inferSelect;
type WorkItemInsert = typeof workItems.$inferInsert;
type WorkItemCommentRow = typeof workItemComments.$inferSelect;
type WorkItemCommentInsert = typeof workItemComments.$inferInsert;
type WorkItemRelationRow = typeof workItemRelations.$inferSelect;
type WorkAttemptRow = typeof workAttempts.$inferSelect;
type WorkEventRow = typeof workEvents.$inferSelect;
type WorkEventInsert = typeof workEvents.$inferInsert;
type WorkItemRelationInsert = typeof workItemRelations.$inferInsert;
type HarnessSubjectVersionRow = typeof harnessSubjectVersions.$inferSelect;
type HarnessSubjectVersionInsert = typeof harnessSubjectVersions.$inferInsert;
type HarnessSubjectTraceBundleRow =
	typeof harnessSubjectTraceBundles.$inferSelect;
type HarnessSubjectTraceBundleInsert =
	typeof harnessSubjectTraceBundles.$inferInsert;
type TediRow = Pick<
	typeof tedis.$inferSelect,
	| "runtimeStatus"
	| "displayName"
	| "id"
	| "name"
	| "organizationId"
	| "repoConfig"
	| "runtimeKind"
	| "slug"
>;
type ChatDispatchIdempotencyRow = typeof chatDispatchIdempotency.$inferSelect;

const columnKeyByName: Record<string, string> = {
	archived_at: "archivedAt",
	conversation_id: "conversationId",
	created_at: "createdAt",
	deleted_at: "deletedAt",
	delegated_tedi_id: "delegatedTediId",
	child_run_id: "childRunId",
	from_work_item_id: "fromWorkItemId",
	id: "id",
	idempotency_key: "idempotencyKey",
	kind: "kind",
	last_message_at: "lastMessageAt",
	org_id: "orgId",
	organization_id: "organizationId",
	pinned_at: "pinnedAt",
	grantee_descope_user_id: "granteeDescopeUserId",
	relation_type: "relationType",
	run_id: "runId",
	status: "status",
	subject_id: "subjectId",
	subject_kind: "subjectKind",
	source_intent_id: "sourceIntentId",
	tedi_id: "tediId",
	to_work_item_id: "toWorkItemId",
	updated_at: "updatedAt",
	harness_version_id: "harnessVersionId",
	promotion_status: "promotionStatus",
	work_item_id: "workItemId",
};

function stringChunkValue(chunk: unknown): string {
	const value = (chunk as { value?: unknown }).value;
	return Array.isArray(value) ? value.join("") : "";
}

function sqlChunkText(chunk: unknown): string {
	const candidate = chunk as {
		name?: unknown;
		queryChunks?: unknown[];
		value?: unknown;
	};
	if (typeof candidate.name === "string" && !candidate.queryChunks) {
		return candidate.name;
	}
	if (Array.isArray(candidate.queryChunks)) {
		return candidate.queryChunks.map(sqlChunkText).join("");
	}
	return stringChunkValue(chunk);
}

function collectWhereConditions(
	value: unknown,
	conditions: Array<{ key: string; op: "=" | "<"; value: unknown }> = [],
) {
	const chunks = (value as { queryChunks?: unknown[] } | undefined)
		?.queryChunks;
	if (!Array.isArray(chunks)) return conditions;
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index] as { name?: unknown; queryChunks?: unknown[] };
		if (chunk?.queryChunks) {
			collectWhereConditions(chunk, conditions);
			continue;
		}
		if (typeof chunk?.name !== "string") continue;
		const op = stringChunkValue(chunks[index + 1]).trim();
		const param = chunks[index + 2] as { value?: unknown } | undefined;
		const key = columnKeyByName[chunk.name];
		if (!key || !param || !("value" in param)) continue;
		if (op === "=" || op === "<") {
			conditions.push({ key, op, value: param.value });
		}
	}
	return conditions;
}

function applyWhere<Row extends Record<string, unknown>>(
	rows: Row[],
	whereClause: unknown,
): Row[] {
	const conditions = collectWhereConditions(whereClause);
	if (conditions.length === 0) return rows;
	const equalsByKey = new Map<string, Set<unknown>>();
	const lessThan: Array<{ key: string; value: unknown }> = [];
	for (const condition of conditions) {
		if (condition.op === "=") {
			const values = equalsByKey.get(condition.key) ?? new Set<unknown>();
			values.add(condition.value);
			equalsByKey.set(condition.key, values);
		} else {
			lessThan.push(condition);
		}
	}
	return rows.filter((row) => {
		for (const [key, values] of equalsByKey) {
			if (!values.has(row[key] ?? null)) return false;
		}
		for (const condition of lessThan) {
			const rowValue = row[condition.key];
			if (typeof rowValue !== "string" || typeof condition.value !== "string") {
				return false;
			}
			if (!(rowValue < condition.value)) return false;
		}
		return true;
	});
}

function isDescOrder(orderByClause: unknown): boolean {
	const chunks = (orderByClause as { queryChunks?: unknown[] } | undefined)
		?.queryChunks;
	return Array.isArray(chunks)
		? chunks.some((chunk) => stringChunkValue(chunk).includes(" desc"))
		: false;
}

/**
 * Structured WHERE evaluator for the work_item_relations select. queryWorkItemBlockers
 * / findWorkItemsBlockedBy use `or(and(eq,eq), and(eq,eq))`, which the generic
 * `applyWhere` flattens (losing the and/or nesting and collapsing both queries to the
 * same impossible conjunction). This walks the drizzle SQL tree honoring and/or so a
 * relation row is matched exactly as D1 would. Returns true on an unrecognized node so
 * a partial parse never drops rows silently.
 */
function evalRelationWhere(
	row: Record<string, unknown>,
	node: unknown,
): boolean {
	const chunks = (node as { queryChunks?: unknown[] } | undefined)?.queryChunks;
	if (!Array.isArray(chunks)) return true;
	// Leaf comparison: a column chunk followed by " = " and a bound param value.
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index] as { name?: unknown; queryChunks?: unknown[] };
		if (typeof chunk?.name === "string" && !chunk.queryChunks) {
			const op = stringChunkValue(chunks[index + 1]).trim();
			const param = chunks[index + 2] as { value?: unknown } | undefined;
			if (op === "=" && param && "value" in param) {
				const key = columnKeyByName[chunk.name];
				if (!key) return true;
				return (row[key] ?? null) === param.value;
			}
		}
	}
	// Composite: gather child SQL nodes and the and/or joiner between them.
	const subNodes: unknown[] = [];
	let joiner: "and" | "or" | null = null;
	for (const chunk of chunks) {
		if (
			chunk &&
			typeof chunk === "object" &&
			Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)
		) {
			subNodes.push(chunk);
			continue;
		}
		const separator = stringChunkValue(chunk).trim();
		if (separator === "and") joiner = "and";
		else if (separator === "or") joiner = "or";
	}
	if (subNodes.length === 0) return true;
	if (subNodes.length === 1) return evalRelationWhere(row, subNodes[0]);
	return joiner === "or"
		? subNodes.some((sub) => evalRelationWhere(row, sub))
		: subNodes.every((sub) => evalRelationWhere(row, sub));
}

/**
 * Structured WHERE evaluator for `kernel_conversations` selects. The indexed
 * page read uses `and(eq, ne, or(lt, and(eq, lt)))` (keyset cursor + sentinel
 * exclusion), which the flat `applyWhere` collapses into an impossible
 * conjunction. Walks the drizzle SQL tree honoring and/or with `=`, `<`, and
 * `<>` leaves. Returns true on an unrecognized node so a partial parse never
 * drops rows silently.
 */
function evalConversationIndexWhere(
	row: Record<string, unknown>,
	node: unknown,
): boolean {
	if (node === undefined) return true;
	const chunks = (node as { queryChunks?: unknown[] } | undefined)?.queryChunks;
	if (!Array.isArray(chunks)) return true;
	// Leaf comparison: a column chunk followed by an operator and a bound param.
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index] as { name?: unknown; queryChunks?: unknown[] };
		if (typeof chunk?.name === "string" && !chunk.queryChunks) {
			const op = stringChunkValue(chunks[index + 1]).trim();
			const trailingSql = chunks
				.slice(index + 1, index + 4)
				.map(sqlChunkText)
				.join("")
				.trim();
			if (op === "is null" || trailingSql.startsWith("is null")) {
				const key = columnKeyByName[chunk.name];
				return key ? (row[key] ?? null) === null : true;
			}
			const param = chunks[index + 2] as { value?: unknown } | undefined;
			if (
				(op === "=" || op === "<" || op === "<>") &&
				param &&
				"value" in param
			) {
				const key = columnKeyByName[chunk.name];
				if (!key) return true;
				const rowValue = row[key] ?? null;
				if (op === "=") return rowValue === param.value;
				if (op === "<>") return rowValue !== param.value;
				return (
					typeof rowValue === "string" &&
					typeof param.value === "string" &&
					rowValue < param.value
				);
			}
		}
	}
	// Composite: gather child SQL nodes and the and/or joiner between them.
	const subNodes: unknown[] = [];
	let joiner: "and" | "or" | null = null;
	for (const chunk of chunks) {
		if (
			chunk &&
			typeof chunk === "object" &&
			Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)
		) {
			subNodes.push(chunk);
			continue;
		}
		const separator = stringChunkValue(chunk).trim();
		if (separator === "and") joiner = "and";
		else if (separator === "or") joiner = "or";
	}
	if (subNodes.length === 0) return true;
	if (subNodes.length === 1)
		return evalConversationIndexWhere(row, subNodes[0]);
	return joiner === "or"
		? subNodes.some((sub) => evalConversationIndexWhere(row, sub))
		: subNodes.every((sub) => evalConversationIndexWhere(row, sub));
}

function normalizeKernelConversationInsert(
	input: KernelConversationInsert,
): KernelConversationRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		title: input.title ?? null,
		titleSource: input.titleSource ?? null,
		channel: input.channel ?? null,
		origin: input.origin ?? null,
		workspaceId: input.workspaceId ?? null,
		workpieceKind: input.workpieceKind ?? null,
		workpieceId: input.workpieceId ?? null,
		lastMessageAt: input.lastMessageAt,
		messageCount: input.messageCount ?? 0,
		deletedAt: input.deletedAt ?? null,
		archivedAt: input.archivedAt ?? null,
		pinnedAt: input.pinnedAt ?? null,
		createdAt: input.createdAt ?? "2026-06-06T08:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-06-06T08:00:00.000Z",
	};
}

function normalizeKernelRuntimeEventInsert(
	input: KernelRuntimeEventInsert,
): KernelRuntimeEventRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId ?? null,
		messageId: input.messageId ?? null,
		causeEventId: input.causeEventId ?? null,
		delegatedTediId: input.delegatedTediId ?? null,
		childRunId: input.childRunId ?? null,
		sequence: input.sequence ?? null,
		delta: input.delta ?? null,
		payload: input.payload ?? null,
		runtimeBackend: input.runtimeBackend ?? "custom",
		runtimeExternalId: input.runtimeExternalId ?? null,
		runtimeExternalUrl: input.runtimeExternalUrl ?? null,
		runtimeMetadata: input.runtimeMetadata ?? null,
		createdAt: input.createdAt ?? "2026-06-06T08:00:00.000Z",
	};
}

function normalizeKernelRuntimeRunInsert(
	input: KernelRuntimeRunInsert,
): KernelRuntimeRunRow {
	return {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: input.status ?? "queued",
		inputMessageId: input.inputMessageId ?? null,
		outputMessageId: input.outputMessageId ?? null,
		delegatedTediId: input.delegatedTediId ?? null,
		childRunId: input.childRunId ?? null,
		childConversationId: input.childConversationId ?? null,
		progressValue: input.progressValue ?? null,
		progressLabel: input.progressLabel ?? null,
		progressDetail: input.progressDetail ?? null,
		latestEventKind: input.latestEventKind ?? null,
		latestEventAt: input.latestEventAt ?? null,
		preview: input.preview ?? null,
		runtimeBackend: input.runtimeBackend ?? "custom",
		runtimeExternalId: input.runtimeExternalId ?? null,
		runtimeExternalUrl: input.runtimeExternalUrl ?? null,
		runtimeMetadata: input.runtimeMetadata ?? null,
		metadata: input.metadata ?? null,
		startedAt: input.startedAt ?? null,
		completedAt: input.completedAt ?? null,
		createdAt: input.createdAt ?? "2026-06-06T08:00:00.000Z",
		updatedAt:
			input.updatedAt ?? input.completedAt ?? "2026-06-06T08:00:00.000Z",
	};
}

function normalizeTediApprovalRequestInsert(
	input: TediApprovalRequestInsert,
): TediApprovalRequestRow {
	return {
		id: input.id,
		tediId: input.tediId,
		orgId: input.orgId,
		actionType: input.actionType,
		description: input.description,
		payload: input.payload,
		status: input.status ?? "pending",
		createdAt: input.createdAt,
		expiresAt: input.expiresAt,
		resolvedAt: input.resolvedAt ?? null,
		resolvedBy: input.resolvedBy ?? null,
		resolution: input.resolution ?? null,
		workflowId: input.workflowId ?? null,
	};
}

function normalizeWorkItemInsert(input: WorkItemInsert): WorkItemRow {
	return {
		id: input.id,
		orgId: input.orgId,
		title: input.title,
		description: input.description ?? null,
		disposition: input.disposition ?? "proposed",
		workKind: input.workKind ?? "other",
		riskLevel: input.riskLevel ?? "medium",
		acceptanceContract: input.acceptanceContract ?? null,
		requiredCapabilities: input.requiredCapabilities ?? [],
		requiredAuthorities: input.requiredAuthorities ?? [],
		resourceScopes: input.resourceScopes ?? [],
		budgetLimitMicros: input.budgetLimitMicros ?? null,
		priority: input.priority ?? "medium",
		accountableOwnerType: input.accountableOwnerType ?? null,
		accountableOwnerId: input.accountableOwnerId ?? null,
		stewardType: input.stewardType ?? null,
		stewardId: input.stewardId ?? null,
		reviewerType: input.reviewerType ?? null,
		reviewerId: input.reviewerId ?? null,
		objectiveId: input.objectiveId ?? null,
		workClass: input.workClass ?? null,
		purposeExceptionExpiresAt: input.purposeExceptionExpiresAt ?? null,
		projectId: input.projectId ?? null,
		parentWorkItemId: input.parentWorkItemId ?? null,
		sourceSessionKey: input.sourceSessionKey ?? null,
		sourceIntentId: input.sourceIntentId ?? null,
		dueDate: input.dueDate ?? null,
		deadline: input.deadline ?? null,
		provenance: input.provenance ?? {},
		metadata: input.metadata ?? {},
		createdAt: input.createdAt,
		updatedAt: input.updatedAt ?? null,
		acceptedAt: input.acceptedAt ?? null,
		completedAt: input.completedAt ?? null,
		cancelledAt: input.cancelledAt ?? null,
		version: input.version ?? 1,
	};
}

function runningWorkAttempt(
	workItemId: string,
	executorId: string,
	runId: string,
): WorkAttemptRow {
	return {
		id: crypto.randomUUID(),
		workItemId,
		orgId: ORG_ID,
		executorType: "tedi",
		executorId,
		executorSessionId: null,
		externalSessionKey: null,
		runId,
		runtimeState: "running",
		outcome: null,
		attemptNumber: 1,
		startedAt: "2026-06-06T08:00:00.000Z",
		heartbeatAt: "2026-06-06T08:00:00.000Z",
		expiresAt: null,
		finishedAt: null,
		summary: null,
		version: 1,
		metadata: {},
	};
}

function normalizeWorkItemCommentInsert(
	input: WorkItemCommentInsert,
): WorkItemCommentRow {
	return {
		id: input.id,
		workItemId: input.workItemId,
		orgId: input.orgId,
		authorType: input.authorType,
		authorId: input.authorId ?? null,
		body: input.body,
		eventType: input.eventType ?? "comment",
		metadata: input.metadata ?? {},
		createdAt: input.createdAt,
	};
}

type PolicyPackRow = {
	definition: Record<string, unknown> | null;
	organizationId?: string;
	status?: string;
};

function createKernelRuntimeDb(opts?: {
	grantRows?: KernelConversationGrantRow[];
	policyPackRows?: PolicyPackRow[];
}) {
	const events: KernelRuntimeEventRow[] = [];
	const runs: KernelRuntimeRunRow[] = [];
	const grantRows: KernelConversationGrantRow[] = [...(opts?.grantRows ?? [])];
	const approvals: TediApprovalRequestRow[] = [];
	const approvalExecutionReceipts: (typeof tediApprovalExecutionReceipts.$inferSelect)[] =
		[];
	const auditRows: Array<Record<string, unknown>> = [];
	const workItemRows: WorkItemRow[] = [];
	const workItemCommentRows: WorkItemCommentRow[] = [];
	// Cross-tedi dependency edges (createHomePlanDependencyRelations →
	// addWorkItemRelation). queryWorkItemBlockers/findWorkItemsBlockedBy read these.
	const workItemRelationRows: WorkItemRelationRow[] = [];
	const workAttemptRows: WorkAttemptRow[] = [];
	const workEvidenceRows: Array<Record<string, any>> = [];
	const workEventRows: WorkEventRow[] = [];
	const harnessSubjectVersionRows: HarnessSubjectVersionRow[] = [];
	const harnessSubjectTraceBundleRows: HarnessSubjectTraceBundleRow[] = [];
	// Records each committed update payload issued against workItems so tests can
	// assert atomic specification transitions.
	const workItemUpdateSets: Array<Record<string, unknown>> = [];
	const runtimeEvents: Array<typeof tediRuntimeEvents.$inferSelect> = [];
	const runtimeSubmissionRows: Array<Record<string, unknown>> = [];
	const artifacts: Array<typeof tediArtifacts.$inferSelect> = [];
	// Durable Home conversation index (`kernel_conversations`) projection rows.
	const conversationIndexRows: KernelConversationRow[] = [];
	const controls: {
		artifactSelectError: Error | null;
		childRuntimeSelectError: Error | null;
		kernelEventInsertError: Error | null;
		kernelRuntimeSelectError: Error | null;
	} = {
		artifactSelectError: null,
		childRuntimeSelectError: null,
		kernelEventInsertError: null,
		kernelRuntimeSelectError: null,
	};
	// Tracks submission settle calls (update on runtimeSubmissions). Each entry
	// records the submissionId and outcome so tests can assert in-band settlement
	// without a live D1 (the update still returns [] / settled:false, which is
	// idempotent — the real settled:true path needs a live row, but we only need
	// to verify the call was made with the right id+outcome).
	const submissionSettleCalls: Array<{
		submissionId: string;
		outcome: string;
	}> = [];
	// Tracks durable abort-intent stamps (update on runtimeSubmissions setting
	// abort_requested_at) so tests can assert cancel paths record the intent.
	const submissionAbortStamps: Array<{ submissionId: string }> = [];
	const idempotencyMappings: ChatDispatchIdempotencyRow[] = [];
	// Default organizationId and status so applyWhere's eq() filter matches them.
	const policyPackRows: PolicyPackRow[] = (opts?.policyPackRows ?? []).map(
		(row) => ({
			organizationId: ORG_ID,
			status: "active",
			...row,
		}),
	);
	const tediRows: TediRow[] = [
		{
			runtimeStatus: null,
			displayName: "CPO",
			id: "tedi-cpo",
			name: "CPO",
			organizationId: ORG_ID,
			repoConfig: null,
			runtimeKind: "agent",
			slug: "cpo",
		},
		{
			runtimeStatus: null,
			displayName: "Echo (Isolate)",
			id: "tedi-echo",
			name: "Echo",
			organizationId: ORG_ID,
			repoConfig: null,
			runtimeKind: "agent",
			slug: "echo",
		},
		{
			runtimeStatus: null,
			displayName: "CTO",
			id: "tedi-cto",
			name: "CTO",
			organizationId: ORG_ID,
			repoConfig: null,
			runtimeKind: "agent",
			slug: "cto",
		},
		{
			runtimeStatus: null,
			displayName: "CTO Agent (Embodied)",
			id: "tedi-cto-agent",
			name: "CTO Agent",
			organizationId: ORG_ID,
			repoConfig: { repoUrl: "https://github.com/acme/ops" },
			runtimeKind: "agent",
			slug: "cto-agent",
		},
	];

	return {
		events,
		runs,
		grantRows,
		approvals,
		approvalExecutionReceipts,
		auditRows,
		runtimeEvents,
		artifacts,
		idempotencyMappings,
		policyPackRows,
		workItemRows,
		workItemCommentRows,
		workItemRelationRows,
		workAttemptRows,
		workEvidenceRows,
		workEventRows,
		harnessSubjectVersionRows,
		harnessSubjectTraceBundleRows,
		workItemUpdateSets,
		controls,
		tediRows,
		submissionSettleCalls,
		submissionAbortStamps,
		conversationIndexRows,
		batch(queries: PromiseLike<unknown>[]) {
			// Drizzle builders in this fake apply their mutations while building the
			// query; resolving them together models the D1 batch result shape used by
			// terminal Work Item + checkout settlement.
			return Promise.all(queries);
		},
		delete(table: unknown) {
			let whereClause: unknown;
			const builder = {
				where(value: unknown) {
					whereClause = value;
					return builder;
				},
				execute() {
					const prune = <T extends Record<string, unknown>>(rows: T[]) => {
						const kept = rows.filter(
							(row) => !applyWhere([row], whereClause).length,
						);
						rows.splice(0, rows.length, ...kept);
					};
					if (table === kernelRuntimeEvents)
						prune(events as unknown as Array<Record<string, unknown>>);
					else if (table === kernelRuntimeRuns)
						prune(runs as unknown as Array<Record<string, unknown>>);
					else if (table === kernelConversationGrants)
						prune(grantRows as unknown as Array<Record<string, unknown>>);
					else if (table === kernelConversations)
						prune(
							conversationIndexRows as unknown as Array<
								Record<string, unknown>
							>,
						);
					else if (table === chatDispatchIdempotency)
						prune(
							idempotencyMappings as unknown as Array<Record<string, unknown>>,
						);
					else if (table === harnessSubjectTraceBundles)
						prune(
							harnessSubjectTraceBundleRows as unknown as Array<
								Record<string, unknown>
							>,
						);
					return Promise.resolve({ rowsAffected: 0 });
				},
				then<TResult1 = unknown, TResult2 = never>(
					onfulfilled?:
						| ((value: unknown) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return builder.execute().then(onfulfilled, onrejected);
				},
			};
			return builder;
		},
		insert(table: unknown) {
			if (table === tediApprovalExecutionReceipts) {
				let pending: (typeof tediApprovalExecutionReceipts.$inferInsert)[] = [];
				let ignoreConflicts = false;
				const builder = {
					values(value: typeof tediApprovalExecutionReceipts.$inferInsert) {
						pending = [value];
						return builder;
					},
					onConflictDoNothing() {
						ignoreConflicts = true;
						return builder;
					},
					async returning() {
						const inserted: typeof approvalExecutionReceipts = [];
						for (const row of pending) {
							const duplicate = approvalExecutionReceipts.some(
								(existing) =>
									existing.id === row.id ||
									(existing.organizationId === row.organizationId &&
										existing.approvalRequestId === row.approvalRequestId &&
										existing.idempotencyKey === row.idempotencyKey),
							);
							if (duplicate) {
								if (ignoreConflicts) continue;
								throw new Error("D1_ERROR: UNIQUE approval execution receipt");
							}
							const normalized = {
								simulationId: null,
								observedResult: null,
								observedError: null,
								...row,
							} as (typeof approvalExecutionReceipts)[number];
							approvalExecutionReceipts.push(normalized);
							inserted.push(normalized);
						}
						return inserted;
					},
				};
				return builder;
			}
			if (table === workAttempts) {
				let source: PromiseLike<unknown[]> | undefined;
				const builder = {
					select(value: PromiseLike<unknown[]>) {
						source = value;
						return builder;
					},
					async returning() {
						const selected = source ? await source : [];
						const inserted = selected.map((raw, index) => {
							const item = raw as WorkItemRow;
							const executorId = item.accountableOwnerId ?? "tedi-cto";
							const provenance = item.provenance as {
								homeRunId?: string;
								source?: string;
							};
							const runId =
								provenance.source === "kernelRuntime.approvePlanAssignments" &&
								provenance.homeRunId
									? `${executorId}:mcp:${provenance.homeRunId}_plan_${workAttemptRows.length + index + 1}_delegate_${executorId}`
									: item.sourceIntentId;
							return {
								id: crypto.randomUUID(),
								workItemId: item.id,
								orgId: item.orgId,
								executorType: "tedi",
								executorId,
								executorSessionId: null,
								externalSessionKey: null,
								runId,
								runtimeState: "running",
								outcome: null,
								attemptNumber: index + 1,
								startedAt: item.createdAt,
								heartbeatAt: item.createdAt,
								expiresAt: null,
								finishedAt: null,
								summary: null,
								version: 1,
								metadata: {},
							} as WorkAttemptRow;
						});
						workAttemptRows.push(...inserted);
						return inserted;
					},
					then: (resolve: (value: WorkAttemptRow[]) => unknown) =>
						builder.returning().then(resolve),
				};
				return builder;
			}
			if (table === workEvents) {
				let pending: WorkEventInsert[] = [];
				const builder = {
					values(value: WorkEventInsert | WorkEventInsert[]) {
						pending = Array.isArray(value) ? value : [value];
						return builder;
					},
					select() {
						return {
							then: (resolve: (value: WorkEventRow[]) => unknown) =>
								Promise.resolve([] as WorkEventRow[]).then(resolve),
						};
					},
					returning() {
						const inserted = pending.map((row, index) => ({
							sequence: workEventRows.length + index + 1,
							attemptId: null,
							actorSessionId: null,
							payload: {},
							...row,
						})) as WorkEventRow[];
						workEventRows.push(...inserted);
						return Promise.resolve(inserted);
					},
					then: (resolve: (value: WorkEventRow[]) => unknown) =>
						builder.returning().then(resolve),
				};
				return builder;
			}
			if (table === kernelConversations) {
				// Durable Home conversation index. The real merge upserts use sql``
				// case clauses the fake cannot evaluate; the fake inserts missing
				// rows and, on an id conflict in onConflictDoUpdate mode, applies
				// only the plain-value set fields (sql fragments are skipped). Full
				// merge semantics are covered against real SQLite in
				// kernel/conversation-index.test.ts; router tests seed projection
				// state directly.
				let pendingRows: KernelConversationInsert[] = [];
				let conflictSet: Record<string, unknown> | undefined;
				let conflictMode: "throw" | "ignore" | "update" = "throw";
				const builder = {
					values(value: KernelConversationInsert | KernelConversationInsert[]) {
						pendingRows = Array.isArray(value) ? value : [value];
						return builder;
					},
					onConflictDoNothing() {
						conflictMode = "ignore";
						return builder;
					},
					onConflictDoUpdate(config?: { set?: Record<string, unknown> }) {
						conflictMode = "update";
						conflictSet = config?.set;
						return builder;
					},
					returning() {
						const inserted: KernelConversationRow[] = [];
						for (const row of pendingRows) {
							const existing = conversationIndexRows.find(
								(candidate) => candidate.id === row.id,
							);
							if (existing) {
								if (conflictMode === "ignore") continue;
								if (conflictMode === "update") {
									for (const [key, value] of Object.entries(
										conflictSet ?? {},
									)) {
										if (
											value === null ||
											typeof value === "string" ||
											typeof value === "number"
										) {
											(existing as unknown as Record<string, unknown>)[key] =
												value;
										} else if (key === "deletedAt") {
											// The canonical delete write uses SQL coalesce so deletion is
											// irreversible. Model that one expression from the inserted row;
											// the real SQLite merge semantics remain covered separately.
											existing.deletedAt ??= row.deletedAt ?? null;
										}
									}
									inserted.push(existing);
									continue;
								}
								throw new Error(
									`D1_ERROR: UNIQUE constraint failed: kernel_conversations.id (${row.id})`,
								);
							}
							const normalized = normalizeKernelConversationInsert(row);
							conversationIndexRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					},
					// Drizzle query builders are awaitable; the projection awaits this fake without returning rows.
					then<TResult1 = KernelConversationRow[], TResult2 = never>(
						onfulfilled?:
							| ((
									value: KernelConversationRow[],
							  ) => TResult1 | PromiseLike<TResult1>)
							| null,
						onrejected?:
							| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
							| null,
					) {
						return builder.returning().then(onfulfilled, onrejected);
					},
				};
				return builder;
			}
			if (table === runtimeSubmissions || table === runtimeSubmissionAttempts) {
				// Additive submission ledger: accept writes as benign no-ops. Returning
				// a populated row keeps recordKernelSubmissionStarted on its happy path
				// (no fail-soft warn); the kernel run/turn tests don't assert on it.
				let submitted: Record<string, unknown> = {};
				const builder = {
					values: (value: Record<string, unknown>) => {
						submitted = value;
						return builder;
					},
					onConflictDoNothing: () => builder,
					returning: () => {
						if (table === runtimeSubmissions) {
							if (
								runtimeSubmissionRows.some((row) => row.id === submitted.id)
							) {
								return [];
							}
							const row = { ...submitted, status: "admitted", attemptCount: 1 };
							runtimeSubmissionRows.push(row);
							return [row];
						}
						return [{ ...submitted, status: "admitted", attemptCount: 1 }];
					},
				};
				return builder;
			}
			if (table === workItemRelations) {
				// addWorkItemRelation upserts on the unique (from,to,type) index. Mirror
				// that idempotency so a re-approval refreshes metadata but never adds a
				// duplicate edge row (keeping the original id).
				let relationRows: WorkItemRelationInsert[] = [];
				return {
					values(value: WorkItemRelationInsert | WorkItemRelationInsert[]) {
						relationRows = Array.isArray(value) ? value : [value];
						return this;
					},
					onConflictDoNothing() {
						return this;
					},
					onConflictDoUpdate() {
						return this;
					},
					returning() {
						const inserted: WorkItemRelationRow[] = [];
						for (const row of relationRows) {
							const existing = workItemRelationRows.find(
								(relation) =>
									relation.fromWorkItemId === row.fromWorkItemId &&
									relation.toWorkItemId === row.toWorkItemId &&
									relation.relationType === row.relationType,
							);
							if (existing) {
								existing.metadata = row.metadata ?? {};
								inserted.push(existing);
								continue;
							}
							const normalized = {
								metadata: {},
								...row,
							} as WorkItemRelationRow;
							workItemRelationRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					},
				};
			}
			if (table === auditEvents) {
				// insertAuditEvent awaits the builder without .returning().
				return {
					values(value: unknown) {
						auditRows.push(value as Record<string, unknown>);
						return this;
					},
				};
			}
			if (table === harnessSubjectVersions) {
				let versionRows: HarnessSubjectVersionInsert[] = [];
				const builder = {
					values(
						value: HarnessSubjectVersionInsert | HarnessSubjectVersionInsert[],
					) {
						versionRows = Array.isArray(value) ? value : [value];
						return builder;
					},
					onConflictDoNothing() {
						return builder;
					},
					returning() {
						const inserted: HarnessSubjectVersionRow[] = [];
						for (const row of versionRows) {
							if (
								harnessSubjectVersionRows.some(
									(existing) => existing.id === row.id,
								)
							) {
								continue;
							}
							const normalized = {
								tediId: null,
								orgId: null,
								runtimeKind: null,
								components: {},
								parentVersionId: null,
								reason: null,
								artifactCommitSha: null,
								traceSafetyPolicyId: null,
								promotionStatus: "proposed",
								metadata: null,
								createdAt: "2026-06-06T08:00:00.000Z",
								...row,
							} as HarnessSubjectVersionRow;
							harnessSubjectVersionRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					},
					// Drizzle query builders are awaitable; the router awaits this fake.
					then<TResult1 = HarnessSubjectVersionRow[], TResult2 = never>(
						onfulfilled?:
							| ((
									value: HarnessSubjectVersionRow[],
							  ) => TResult1 | PromiseLike<TResult1>)
							| null,
						onrejected?:
							| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
							| null,
					) {
						return builder.returning().then(onfulfilled, onrejected);
					},
				};
				return builder;
			}
			if (table === harnessSubjectTraceBundles) {
				let bundleRows: HarnessSubjectTraceBundleInsert[] = [];
				const builder = {
					values(
						value:
							| HarnessSubjectTraceBundleInsert
							| HarnessSubjectTraceBundleInsert[],
					) {
						bundleRows = Array.isArray(value) ? value : [value];
						return builder;
					},
					onConflictDoNothing() {
						return builder;
					},
					returning() {
						const inserted: HarnessSubjectTraceBundleRow[] = [];
						for (const row of bundleRows) {
							if (
								harnessSubjectTraceBundleRows.some(
									(existing) => existing.id === row.id,
								)
							) {
								continue;
							}
							const normalized = {
								tediId: null,
								orgId: null,
								conversationId: null,
								eventIds: [],
								rationaleRecordIds: [],
								artifactIds: [],
								evalResultId: null,
								bundleUri: null,
								summary: null,
								outcome: null,
								metadata: null,
								createdAt: "2026-06-06T08:00:00.000Z",
								...row,
							} as HarnessSubjectTraceBundleRow;
							harnessSubjectTraceBundleRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					},
					// Drizzle query builders are awaitable; the router awaits this fake.
					then<TResult1 = HarnessSubjectTraceBundleRow[], TResult2 = never>(
						onfulfilled?:
							| ((
									value: HarnessSubjectTraceBundleRow[],
							  ) => TResult1 | PromiseLike<TResult1>)
							| null,
						onrejected?:
							| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
							| null,
					) {
						return builder.returning().then(onfulfilled, onrejected);
					},
				};
				return builder;
			}
			if (
				table !== kernelRuntimeEvents &&
				table !== kernelRuntimeRuns &&
				table !== kernelConversationGrants &&
				table !== tediApprovalRequests &&
				table !== workItems &&
				table !== workItemComments
			) {
				throw new Error("Unexpected table in kernel runtime test");
			}
			let rows: Array<
				| KernelRuntimeEventInsert
				| KernelRuntimeRunInsert
				| KernelConversationGrantRow
				| TediApprovalRequestInsert
				| WorkItemInsert
				| WorkItemCommentInsert
			> = [];
			let ignoreConflicts = false;
			let updateOnConflict = false;
			let selectedSource: PromiseLike<unknown[]> | undefined;
			const builder = {
				select(value: PromiseLike<unknown[]>) {
					selectedSource = value;
					return builder;
				},
				values(
					value:
						| KernelRuntimeEventInsert
						| KernelRuntimeRunInsert
						| KernelConversationGrantRow
						| TediApprovalRequestInsert
						| WorkItemInsert
						| WorkItemCommentInsert
						| Array<
								| KernelRuntimeEventInsert
								| KernelRuntimeRunInsert
								| KernelConversationGrantRow
								| TediApprovalRequestInsert
								| WorkItemInsert
								| WorkItemCommentInsert
						  >,
				) {
					rows = Array.isArray(value) ? value : [value];
					return builder;
				},
				onConflictDoNothing() {
					ignoreConflicts = true;
					return builder;
				},
				onConflictDoUpdate() {
					updateOnConflict = true;
					return builder;
				},
				async returning() {
					if (selectedSource) {
						rows = (await selectedSource) as typeof rows;
					}
					if (table === kernelRuntimeRuns) {
						const inserted: KernelRuntimeRunRow[] = [];
						for (const row of rows as KernelRuntimeRunInsert[]) {
							if (ignoreConflicts && runs.some((run) => run.id === row.id)) {
								continue;
							}
							const normalized = normalizeKernelRuntimeRunInsert(row);
							runs.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					if (table === kernelConversationGrants) {
						const inserted = rows as KernelConversationGrantRow[];
						grantRows.push(...inserted);
						return Promise.resolve(inserted);
					}
					if (table === tediApprovalRequests) {
						const inserted: TediApprovalRequestRow[] = [];
						for (const row of rows as TediApprovalRequestInsert[]) {
							if (
								ignoreConflicts &&
								approvals.some((approval) => approval.id === row.id)
							) {
								continue;
							}
							const normalized = normalizeTediApprovalRequestInsert(row);
							approvals.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					if (table === workItems) {
						const inserted: WorkItemRow[] = [];
						for (const row of rows as WorkItemInsert[]) {
							const existing = workItemRows.find(
								(item) =>
									item.orgId === row.orgId &&
									item.sourceIntentId === (row.sourceIntentId ?? null),
							);
							if (existing && (ignoreConflicts || updateOnConflict)) {
								Object.assign(existing, normalizeWorkItemInsert(row), {
									id: existing.id,
								});
								inserted.push(existing);
								continue;
							}
							const normalized = normalizeWorkItemInsert(row);
							workItemRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					if (table === workItemComments) {
						const inserted: WorkItemCommentRow[] = [];
						for (const row of rows as WorkItemCommentInsert[]) {
							if (
								ignoreConflicts &&
								workItemCommentRows.some((comment) => comment.id === row.id)
							) {
								continue;
							}
							const normalized = normalizeWorkItemCommentInsert(row);
							workItemCommentRows.push(normalized);
							inserted.push(normalized);
						}
						return Promise.resolve(inserted);
					}
					const inserted: KernelRuntimeEventRow[] = [];
					if (controls.kernelEventInsertError)
						throw controls.kernelEventInsertError;
					for (const row of rows) {
						if (
							ignoreConflicts &&
							events.some((event) => event.id === row.id)
						) {
							continue;
						}
						const normalized = normalizeKernelRuntimeEventInsert(
							row as KernelRuntimeEventInsert,
						);
						events.push(normalized);
						inserted.push(normalized);
					}
					return Promise.resolve(inserted);
				},
				// Drizzle insert builders are awaitable even without returning rows.
				then<TResult1 = unknown[], TResult2 = never>(
					onfulfilled?:
						| ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return builder.returning().then(onfulfilled, onrejected);
				},
			};
			return builder;
		},
		$count(table: unknown, whereClause: unknown) {
			if (table === tediRuntimeEvents) {
				return Promise.resolve(
					applyWhere([...runtimeEvents], whereClause).length,
				);
			}
			if (table === kernelRuntimeEvents) {
				return Promise.resolve(applyWhere([...events], whereClause).length);
			}
			throw new Error("Unexpected count table in kernel runtime test");
		},
		select(selection?: Record<string, unknown>) {
			let selectedRows: Array<
				| KernelRuntimeEventRow
				| KernelRuntimeRunRow
				| KernelConversationGrantRow
				| typeof tediRuntimeEvents.$inferSelect
				| typeof tediArtifacts.$inferSelect
				| TediApprovalRequestRow
				| TediRow
				| WorkItemRow
				| WorkAttemptRow
				| WorkItemCommentRow
				| ChatDispatchIdempotencyRow
				| HarnessSubjectVersionRow
				| HarnessSubjectTraceBundleRow
			> = [];
			let selectedTable: unknown;
			let whereClause: unknown;
			let orderByClause: unknown;
			let rowLimit: number | undefined;
			let rowOffset: number | undefined;
			return {
				from(table: unknown) {
					selectedTable = table;
					const isKernelEventAlias = Object.getOwnPropertySymbols(
						table as object,
					).some(
						(symbol) =>
							(table as Record<symbol, unknown>)[symbol] ===
							"kernel_runtime_events",
					);
					if (table === kernelRuntimeEvents || isKernelEventAlias) {
						selectedRows = [...events];
						return this;
					}
					if (table === kernelRuntimeRuns) {
						selectedRows = [...runs];
						return this;
					}
					if (table === kernelConversationGrants) {
						selectedRows = [...grantRows];
						return this;
					}
					if (table === kernelConversations) {
						selectedRows = [...conversationIndexRows] as typeof selectedRows;
						return this;
					}
					if (table === tediRuntimeEvents) {
						selectedRows = [...runtimeEvents];
						return this;
					}
					if (table === tediArtifacts) {
						selectedRows = [...artifacts];
						return this;
					}
					if (table === tedis) {
						selectedRows = [...tediRows];
						return this;
					}
					if (table === workItems) {
						// getWorkItemById / resolveDelegationWorkItemId read work items by
						// id (or orgId+sourceIntentId). applyWhere matches the eq() chunks.
						selectedRows = [...workItemRows] as typeof selectedRows;
						return this;
					}
					if (table === workItemComments) {
						selectedRows = [...workItemCommentRows] as typeof selectedRows;
						return this;
					}
					if (table === workAttempts) {
						selectedRows = [...workAttemptRows] as typeof selectedRows;
						return this;
					}
					if (table === workItemRelations) {
						// queryWorkItemBlockers/findWorkItemsBlockedBy filter via an or/and
						// tree (handled by evalRelationWhere + projection in execute()).
						selectedRows = [...workItemRelationRows] as typeof selectedRows;
						return this;
					}
					if (table === tediApprovalRequests) {
						selectedRows = [...approvals];
						return this;
					}
					if (table === tediApprovalExecutionReceipts) {
						selectedRows = [
							...approvalExecutionReceipts,
						] as unknown as typeof selectedRows;
						return this;
					}
					if (table === chatDispatchIdempotency) {
						selectedRows = [...idempotencyMappings];
						return this;
					}
					if (table === harnessSubjectVersions) {
						selectedRows = [...harnessSubjectVersionRows];
						return this;
					}
					if (table === harnessSubjectTraceBundles) {
						selectedRows = [...harnessSubjectTraceBundleRows];
						return this;
					}
					if (table === policyPacks) {
						selectedRows = [...policyPackRows] as typeof selectedRows;
						return this;
					}
					if (table === runtimeSubmissions) {
						// The crash-safe settle pre-reads the submission via getSubmissionById;
						// execute() synthesizes an admitted row from the WHERE id so the
						// two-step reserve→finalize proceeds.
						selectedRows = [...runtimeSubmissionRows] as typeof selectedRows;
						return this;
					}
					throw new Error("Unexpected table in kernel runtime test");
				},
				where(value: unknown) {
					whereClause = value;
					return this;
				},
				innerJoin() {
					return this;
				},
				orderBy(value: unknown) {
					orderByClause = value;
					return this;
				},
				limit(value: number) {
					rowLimit = value;
					return this;
				},
				offset(value: number) {
					rowOffset = value;
					return this;
				},
				execute() {
					if (
						selectedTable === kernelRuntimeEvents &&
						controls.kernelRuntimeSelectError
					) {
						throw controls.kernelRuntimeSelectError;
					}
					if (
						selection &&
						"causeEventId" in selection &&
						selectedTable !== kernelRuntimeEvents
					) {
						const source = selectedRows[0] as
							| Record<string, unknown>
							| undefined;
						if (!source) return [];
						return [
							Object.fromEntries(
								Object.entries(selection).map(([key, field]) => {
									if (key === "causeEventId") return [key, source.id];
									if (
										typeof field === "object" &&
										field !== null &&
										"name" in field &&
										field.name === "id"
									)
										return [key, source.id];
									const sqlValue = (
										field as {
											sql?: { queryChunks?: unknown[] };
										}
									).sql?.queryChunks?.[1];
									if (
										(key === "payload" || key === "runtimeMetadata") &&
										typeof sqlValue === "string"
									)
										return [key, JSON.parse(sqlValue)];
									return [key, sqlValue];
								}),
							),
						] as unknown as typeof selectedRows;
					}
					if (
						selectedTable === kernelRuntimeRuns &&
						controls.kernelRuntimeSelectError
					) {
						throw controls.kernelRuntimeSelectError;
					}
					if (
						selectedTable === tediRuntimeEvents &&
						controls.childRuntimeSelectError
					) {
						throw controls.childRuntimeSelectError;
					}
					if (selectedTable === tediArtifacts && controls.artifactSelectError) {
						throw controls.artifactSelectError;
					}
					if (selectedTable === runtimeSubmissions) {
						// Synthesize a non-terminal admitted row keyed by the WHERE id so
						// getSubmissionById (the settle pre-read) resolves and the two-step
						// reserve→finalize runs.
						const conditions = collectWhereConditions(whereClause);
						const idCondition = conditions.find((c) => c.key === "id");
						const id =
							typeof idCondition?.value === "string"
								? idCondition.value
								: "sub:test";
						const stored = runtimeSubmissionRows.find((row) => row.id === id);
						return [
							stored ?? {
								id,
								organizationId: ORG_ID,
								status: "admitted",
								currentAttemptId: null,
								metadata: null,
							},
						] as unknown as typeof selectedRows;
					}
					if (selectedTable === kernelConversations) {
						// Keyset cursor where-tree (or/and with < / <>) needs the
						// structured evaluator; order by last_message_at DESC with the
						// conversation_id DESC tiebreak, exactly like the real index read.
						let output = (
							selectedRows as unknown as KernelConversationRow[]
						).filter((row) =>
							evalConversationIndexWhere(
								row as unknown as Record<string, unknown>,
								whereClause,
							),
						);
						output = [...output].sort(
							(a, b) =>
								b.lastMessageAt.localeCompare(a.lastMessageAt) ||
								b.conversationId.localeCompare(a.conversationId),
						);
						if (rowLimit !== undefined) output = output.slice(0, rowLimit);
						return output as unknown as typeof selectedRows;
					}
					if (selectedTable === workItemRelations) {
						// Honor the or/and tree, then project to the aliased columns both
						// queries read: queryWorkItemBlockers selects {id:from, to, type};
						// findWorkItemsBlockedBy selects {from, to, type}. Emitting both `id`
						// and `from` (= fromWorkItemId) satisfies each without re-parsing.
						const conditions = collectWhereConditions(whereClause);
						const inverse = conditions.some(
							(condition) => condition.key === "fromWorkItemId",
						);
						return (selectedRows as unknown as WorkItemRelationRow[])
							.filter((relation) =>
								evalRelationWhere(
									relation as unknown as Record<string, unknown>,
									whereClause,
								),
							)
							.map((relation) => {
								const relatedId = inverse
									? relation.toWorkItemId
									: relation.fromWorkItemId;
								const related = workItemRows.find(
									(item) => item.id === relatedId,
								);
								return {
									id: relatedId,
									from: relation.fromWorkItemId,
									to: relation.toWorkItemId,
									title: related?.title ?? "",
									disposition: related?.disposition ?? "proposed",
									relationType: relation.relationType,
								};
							}) as unknown as typeof selectedRows;
					}
					let output = applyWhere(selectedRows, whereClause);
					if (orderByClause) {
						const direction = isDescOrder(orderByClause) ? -1 : 1;
						output = [...output].sort(
							(a, b) =>
								direction *
								String(
									("updatedAt" in a ? a.updatedAt : null) ?? a.createdAt,
								).localeCompare(
									String(
										("updatedAt" in b ? b.updatedAt : null) ?? b.createdAt,
									),
								),
						);
					}
					if (rowOffset !== undefined && rowOffset > 0) {
						output = output.slice(rowOffset);
					}
					if (rowLimit !== undefined) output = output.slice(0, rowLimit);
					return output;
				},
				// Drizzle query builders are awaitable; the router awaits this fake.
				then<TResult1 = KernelRuntimeEventRow[], TResult2 = never>(
					onfulfilled?:
						| ((
								value: Array<
									| KernelRuntimeEventRow
									| KernelRuntimeRunRow
									| KernelConversationGrantRow
									| typeof tediRuntimeEvents.$inferSelect
									| typeof tediArtifacts.$inferSelect
									| TediApprovalRequestRow
									| TediRow
									| WorkItemRow
									| ChatDispatchIdempotencyRow
									| HarnessSubjectVersionRow
									| HarnessSubjectTraceBundleRow
								>,
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
				},
			};
		},
		update(table: unknown) {
			if (table === runtimeSubmissions || table === runtimeSubmissionAttempts) {
				// Additive submission ledger: track settle calls on runtimeSubmissions
				// so tests can assert in-band settlement (returning [] keeps
				// settleKernelSubmission on its not-settled path; the real settled:true
				// transition needs a live row, but we only need to verify the call).
				// submissionId is derived from runId via kernelSubmissionId("sub:<runId>").
				let pendingOutcome: string | undefined;
				let pendingAbortStamp = false;
				const builder = {
					set(value: Record<string, unknown>) {
						if (
							table === runtimeSubmissions &&
							typeof value.status === "string" &&
							// The reserve latch is an intermediate, non-terminal status; only
							// the finalize (terminal) transition counts as a settle call.
							value.status !== "reserved"
						) {
							pendingOutcome = value.status;
						}
						if (
							table === runtimeSubmissions &&
							typeof value.abortRequestedAt === "string"
						) {
							pendingAbortStamp = true;
						}
						return builder;
					},
					where(whereValue: unknown) {
						// Extract submissionId from the WHERE conditions alongside outcome.
						if (table === runtimeSubmissions && pendingOutcome) {
							const conditions = collectWhereConditions(whereValue);
							const idCondition = conditions.find((c) => c.key === "id");
							submissionSettleCalls.push({
								submissionId:
									typeof idCondition?.value === "string"
										? idCondition.value
										: "unknown",
								outcome: pendingOutcome,
							});
						}
						if (table === runtimeSubmissions && pendingAbortStamp) {
							const conditions = collectWhereConditions(whereValue);
							const idCondition = conditions.find((c) => c.key === "id");
							submissionAbortStamps.push({
								submissionId:
									typeof idCondition?.value === "string"
										? idCondition.value
										: "unknown",
							});
						}
						return builder;
					},
					// Return a truthy row so the crash-safe two-step settle proceeds past
					// the reserve CAS into finalize (where the terminal outcome is recorded).
					returning: () =>
						[
							{ id: "submission", status: pendingOutcome ?? "reserved" },
						] as unknown[],
					// Drizzle query builders are awaitable; the router awaits this fake.
					then: (res: (v: unknown[]) => unknown) =>
						res([{ id: "submission", status: pendingOutcome ?? "reserved" }]),
				};
				return builder;
			}
			if (
				table !== kernelRuntimeRuns &&
				table !== workItems &&
				table !== workAttempts &&
				table !== tediApprovalRequests &&
				table !== harnessSubjectVersions &&
				table !== harnessSubjectTraceBundles &&
				table !== kernelToolResults
			) {
				throw new Error("Unexpected update table in kernel runtime test");
			}
			let values: Partial<
				| KernelRuntimeRunRow
				| WorkItemRow
				| WorkAttemptRow
				| TediApprovalRequestRow
				| HarnessSubjectVersionRow
				| HarnessSubjectTraceBundleRow
			> = {};
			let whereClause: unknown;
			let matched:
				| Array<KernelRuntimeRunRow>
				| Array<WorkItemRow>
				| Array<WorkAttemptRow>
				| Array<TediApprovalRequestRow>
				| Array<HarnessSubjectVersionRow>
				| Array<HarnessSubjectTraceBundleRow> = [];
			return {
				set(
					value: Partial<
						| KernelRuntimeRunRow
						| WorkItemRow
						| TediApprovalRequestRow
						| HarnessSubjectVersionRow
						| HarnessSubjectTraceBundleRow
					>,
				) {
					values = value;
					return this;
				},
				where(value: unknown) {
					whereClause = value;
					const targetRows =
						table === kernelRuntimeRuns
							? runs
							: table === tediApprovalRequests
								? approvals
								: table === workAttempts
									? workAttemptRows
									: table === harnessSubjectVersions
										? harnessSubjectVersionRows
										: table === harnessSubjectTraceBundles
											? harnessSubjectTraceBundleRows
											: table === kernelToolResults
												? []
												: workItemRows;
					if (table === workItems) {
						// Snapshot the committed set() keys so atomicity assertions can see
						// whether the counter-advance rode the same statement as the status
						// transition (vs. a separate trailing metadata-only write).
						workItemUpdateSets.push({ ...(values as Record<string, unknown>) });
					}
					matched = applyWhere(targetRows, whereClause) as
						| Array<KernelRuntimeRunRow>
						| Array<WorkItemRow>
						| Array<TediApprovalRequestRow>
						| Array<HarnessSubjectVersionRow>
						| Array<HarnessSubjectTraceBundleRow>;
					for (const row of matched) {
						Object.assign(row, values);
					}
					return this;
				},
				returning() {
					return Promise.resolve(matched);
				},
				// Drizzle query builders are awaitable; the router awaits this fake.
				then<
					TResult1 = Array<
						| KernelRuntimeRunRow
						| WorkItemRow
						| TediApprovalRequestRow
						| HarnessSubjectVersionRow
						| HarnessSubjectTraceBundleRow
					>,
					TResult2 = never,
				>(
					onfulfilled?:
						| ((
								value: Array<
									| KernelRuntimeRunRow
									| WorkItemRow
									| TediApprovalRequestRow
									| HarnessSubjectVersionRow
									| HarnessSubjectTraceBundleRow
								>,
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.resolve(matched).then(onfulfilled, onrejected);
				},
			};
		},
	};
}

function createMissingKernelRuntimeTableDb() {
	return {
		insert() {
			return {
				values() {
					return this;
				},
				onConflictDoNothing() {
					return this;
				},
				returning() {
					return Promise.reject(
						new Error("D1_ERROR: no such table: kernel_conversations"),
					);
				},
			};
		},
		select() {
			return {
				from() {
					return this;
				},
				where() {
					return this;
				},
				// The router aggregates on this read path, so the fake has to
				// carry groupBy like every other chainable step. Without it the
				// chain returned undefined and the failure surfaced as
				// "db.select(...).from(...).where(...).groupBy is not a function"
				// rather than as the migration-fallback behaviour under test.
				groupBy() {
					return this;
				},
				orderBy() {
					return this;
				},
				limit() {
					return this;
				},
				offset() {
					return this;
				},
				// Drizzle query builders are awaitable; the router awaits this fake.
				then<TResult1 = KernelRuntimeEventRow[], TResult2 = never>(
					_onfulfilled?:
						| ((
								value: KernelRuntimeEventRow[],
						  ) => TResult1 | PromiseLike<TResult1>)
						| null,
					onrejected?:
						| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
						| null,
				) {
					return Promise.reject(
						new Error("D1_ERROR: no such table: kernel_conversations"),
					).then(undefined, onrejected);
				},
			};
		},
	};
}

function createContext(
	db: ReturnType<typeof createKernelRuntimeDb>,
	overrides?: { env?: Record<string, unknown>; userSub?: string },
): BaseContext {
	const waitUntilPromises: Promise<unknown>[] = [];
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: db as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			...overrides?.env,
		} as CloudflareEnv,
		...(overrides?.userSub
			? { user: { sub: overrides.userSub } as BaseContext["user"] }
			: {}),
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/kernel-runtime"),
		waitUntil: (promise) => {
			waitUntilPromises.push(promise);
		},
		waitUntilPromises,
	} as BaseContext & { waitUntilPromises: Promise<unknown>[] };
}

function createKernelRuntimeClient(context: BaseContext) {
	return createRouterClient(kernelRuntimeContractRouter, { context });
}

function childRuntimeEvent(input: {
	approvalRequestId?: string | null;
	artifactId?: string | null;
	createdAt: string;
	delta?: string | null;
	id: string;
	kind: typeof tediRuntimeEvents.$inferSelect.kind;
	messageId?: string | null;
	payload?: Record<string, unknown> | null;
	runId: string;
	tediId: string;
	toolCallId?: string | null;
}): typeof tediRuntimeEvents.$inferSelect {
	return {
		artifactId: input.artifactId ?? null,
		approvalRequestId: input.approvalRequestId ?? null,
		conversationId: "agent:main:main",
		createdAt: input.createdAt,
		delta: input.delta ?? null,
		id: input.id,
		kind: input.kind,
		messageId: input.messageId ?? null,
		organizationId: ORG_ID,
		payload: input.payload ?? { status: "running" },
		runId: input.runId,
		runtimeBackend: "cloudflare-agents",
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		runtimeMetadata: null,
		sequence: null,
		tediId: input.tediId,
		toolCallId: input.toolCallId ?? null,
	};
}

function grantRow(input: {
	access: KernelConversationGrantRow["access"];
	conversationId: string;
	userId: string;
}): KernelConversationGrantRow {
	return {
		id: `grant:${input.conversationId}:${input.userId}`,
		organizationId: ORG_ID,
		conversationId: input.conversationId,
		granteeDescopeUserId: input.userId,
		access: input.access,
		createdByDescopeUserId: "owner-1",
		createdAt: "2026-06-06T08:00:00.000Z",
		updatedAt: "2026-06-06T08:00:00.000Z",
	};
}

function planAssignmentSeed(input: {
	id: string;
	ownerTediId: string;
	ownerLabel: string;
}) {
	return {
		id: input.id,
		ownerTediId: input.ownerTediId,
		ownerLabel: input.ownerLabel,
		routeKind: "agent" as const,
		objective: `Own ${input.ownerLabel}'s slice of the request.`,
		expectedEvidence: [],
		risk: "medium" as const,
		confidence: 0.9,
		requiresApproval: true,
		required: true,
		status: "proposed" as const,
	};
}

/**
 * Seed a run row carrying a proposed Home plan with explicit inferred dependency
 * edges (the propose-time snapshot Step 3 persists), so approvePlanAssignments
 * runs the real Step 4/5 relation-materialization path against it.
 */
function seedDependencyPlanRun(
	db: ReturnType<typeof createKernelRuntimeDb>,
	input: {
		runId: string;
		assignments: ReturnType<typeof planAssignmentSeed>[];
		dependencies: Array<{
			fromOwnerTediId: string;
			toOwnerTediId: string;
			reason: string;
		}>;
	},
) {
	db.runs.push(
		normalizeKernelRuntimeRunInsert({
			id: input.runId,
			organizationId: ORG_ID,
			conversationId: "home:test",
			status: "requires_approval",
			metadata: {
				homePlan: {
					id: `${input.runId}:plan`,
					status: "proposed",
					summary: "Seeded dependency plan",
					source: "kernelRuntime.plan.v1",
					createdAt: "2026-06-06T08:00:00.000Z",
					assignments: input.assignments,
					attentionRoutes: [],
					dependencies: input.dependencies,
				},
			},
		}),
	);
}

describe("kernel runtime router", () => {
	it("maps invalid causal event references to CONFLICT", async () => {
		const db = createKernelRuntimeDb();
		await expect(
			insertKernelRuntimeEvent(createContext(db), {
				id: "causal-child",
				organizationId: ORG_ID,
				kind: "run.started",
				conversationId: "home:causal",
				causeEventId: "missing-cause",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("refuses explicit local delegation before creating execution state", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, {
				env: {
					TEDIX_LOCAL_DEMO_ENABLED: "true",
					DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
				},
			}),
		);
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		await expect(
			client.enqueueMessage({
				content: "Review the supplier proposal",
				delegateToTediId: "tedi-cpo",
				idempotencyKey: "local-delegation",
			}),
		).rejects.toThrow("This local installation does not run tedis");
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(db.approvals).toHaveLength(0);
		expect(db.workItemRows).toHaveLength(0);
		expect(db.runs).toHaveLength(0);
		expect(db.approvals).toHaveLength(0);
		expect(db.events).toHaveLength(0);
	});

	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(null);
		kernelRuntimeTestHooks.setChildStopperForTest(null);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(null);
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
		setKernelToolResultRetainerForTest(null);
	});

	it("preserves org-wide Home access until a conversation has explicit grants", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));

		await expect(
			client.enqueueMessage({
				conversationId: "home:open",
				content: "org-wide by default",
				idempotencyKey: "grant-open-1",
			}),
		).resolves.toMatchObject({
			conversationId: "home:open",
		});
	});

	it("replays an authorized delegated child from canonical tedi runtime events", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-stream-1",
				organizationId: ORG_ID,
				conversationId: "home:child-stream",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-stream-1",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-07-18T10:00:00.000Z",
				id: "child-tool",
				kind: "tool.completed",
				payload: { name: "work.list_work_items" },
				runId: "child-stream-1",
				tediId: "tedi-cto",
				toolCallId: "tool-call-1",
			}),
			childRuntimeEvent({
				approvalRequestId: "approval-1",
				createdAt: "2026-07-18T10:00:01.000Z",
				id: "child-approval",
				kind: "approval.requested",
				payload: { description: "Approve the write" },
				runId: "child-stream-1",
				tediId: "tedi-cto",
			}),
			childRuntimeEvent({
				createdAt: "2026-07-18T10:00:02.000Z",
				id: "child-terminal",
				kind: "run.completed",
				messageId: "message-1",
				runId: "child-stream-1",
				tediId: "tedi-cto",
			}),
		);

		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunEvents({
			runId: "home-child-stream-1",
			childRunId: "child-stream-1",
			delegatedTediId: "tedi-cto",
			offset: 0,
		});

		expect(result.events.map((event) => event.id)).toEqual([
			"child-tool",
			"child-approval",
			"child-terminal",
		]);
		expect(result.events[0]).toMatchObject({ toolCallId: "tool-call-1" });
		expect(result.events[1]).toMatchObject({
			approvalRequestId: "approval-1",
		});
		expect(result.events[2]).toMatchObject({ messageId: "message-1" });
		expect(result.stream).toMatchObject({
			streamId: "home:home-child-stream-1:child:child-stream-1",
			offset: 0,
			nextOffset: 3,
			closed: true,
			terminalEventId: "child-terminal",
		});
	});

	it("attempts settlement repair for an admitted terminal parent with no receipt", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-missed-settlement",
				organizationId: ORG_ID,
				conversationId: "home:missed-settlement",
				status: "completed",
				completedAt: "2026-07-19T20:41:24.082Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "home-admitted",
				organizationId: ORG_ID,
				kind: "submission.admitted",
				conversationId: "home:missed-settlement",
				runId: "home-missed-settlement",
				payload: { submissionId: "sub:home-missed-settlement" },
				createdAt: "2026-07-19T20:40:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "home-completed",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:missed-settlement",
				runId: "home-missed-settlement",
				createdAt: "2026-07-19T20:41:24.082Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		await client.readRunEvents({
			runId: "home-missed-settlement",
			offset: 0,
		});

		expect(db.submissionSettleCalls).toContainEqual({
			submissionId: "sub:home-missed-settlement",
			outcome: "settled",
		});
	});

	it("rejects child selectors that are not referenced by the authorized parent", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-child-stream-auth",
				organizationId: ORG_ID,
				conversationId: "home:child-stream-auth",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "allowed-child",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		await expect(
			client.readRunEvents({
				runId: "home-child-stream-auth",
				childRunId: "other-child",
				delegatedTediId: "tedi-cto",
			}),
		).rejects.toThrow(/Delegated child run not found/);
		await expect(
			client.readRunEvents({
				runId: "home-child-stream-auth",
				childRunId: "allowed-child",
				delegatedTediId: "tedi-cpo",
			}),
		).rejects.toThrow(/Delegated child run not found/);
	});

	it("requires edit grants for Home turn posting after a conversation opts in", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					access: "read",
					conversationId: "home:locked",
					userId: "operator-1",
				}),
			],
		});
		const reader = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			reader.enqueueMessage({
				conversationId: "home:locked",
				content: "should not post",
				idempotencyKey: "grant-denied-1",
			}),
		).rejects.toThrow(/Access denied/);

		db.grantRows[0].access = "edit";
		await expect(
			reader.enqueueMessage({
				conversationId: "home:locked",
				content: "can post now",
				idempotencyKey: "grant-allowed-1",
			}),
		).resolves.toMatchObject({
			conversationId: "home:locked",
		});
	});

	it("returns a read-only child-run tree for delegated Home runs", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:tree",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto", childRunStatus: "running" },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.readChildRunTree({
			conversationId: "home:tree",
		});

		expect(result.tree).toMatchObject({
			conversationId: "home:tree",
			activeNodeId: "child:tedi-cto:child-run-1",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					label: "cto",
					status: "running",
					active: true,
					children: [],
				},
			],
		});
	});

	it("routes a plain Home turn through the Kernel when it returns a decision", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const kernel = vi.fn(async () => ({
			assistantContent: "ROUTED:gmail",
			route: {
				routeKind: "delegate_tedi" as const,
				rationale: "Operator wants Gmail read by its accountable tedi.",
				risk: "low" as const,
				confidence: 0.78,
				toolIntent: {
					appSlug: "gmail",
					capability: "gmail.read",
					connectionStatus: "connected" as const,
				},
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "check my gmail messages",
			idempotencyKey: "kernel-route-1",
		});
		const causalEvents = (await db.select().from(kernelRuntimeEvents)).filter(
			(event) => event.runId === result.run.id,
		);
		const inputEvent = causalEvents.find(
			(event) => event.kind === "message.received",
		);
		const startEvent = causalEvents.find(
			(event) => event.kind === "run.started",
		);
		expect(startEvent?.causeEventId).toBe(inputEvent?.id);
		expect(inputEvent?.id).toBe(
			homeRuntimeEventId({
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				runId: result.run.id,
				messageId: `${result.run.id}:input`,
			}),
		);
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(kernel).toHaveBeenCalledTimes(1);
		expect(kernel.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			content: "check my gmail messages",
			// Kernel conversational memory seam: the turn body threads the
			// conversation id (bounded history scope) and the current turn's
			// already-persisted user message id (excluded from history).
			conversationId: "home:test",
			currentUserMessageId: "kernel-route-1:input",
		});
		// The kernel's assistantContent replaces the generic heuristic text.
		expect(result.assistantMessage?.content).toBe("ROUTED:gmail");
		const persistedAssistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		expect(persistedAssistant?.content).toBe("ROUTED:gmail");
		// The typed route decision is carried on the run metadata.
		expect(result.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "delegate_tedi" },
		});
	});

	it("preserves a legacy null Home run-start cause on HTTP replay", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "ok",
				route: {
					routeKind: "answer" as const,
					rationale: "answer",
					risk: "low" as const,
					confidence: 1,
				},
			})),
		);
		const runId = "legacy-causal-run";
		const messageId = `${runId}:input`;
		await db.insert(kernelRuntimeEvents).values({
			id: homeRuntimeEventId({
				organizationId: ORG_ID,
				kind: "run.started",
				conversationId: "home:legacy-cause",
				runId,
				messageId,
			}),
			organizationId: ORG_ID,
			kind: "run.started",
			conversationId: "home:legacy-cause",
			runId,
			messageId,
			causeEventId: null,
		});
		await client.enqueueMessage({
			conversationId: "home:legacy-cause",
			content: "retry",
			idempotencyKey: runId,
		});
		const start = (await db.select().from(kernelRuntimeEvents)).find(
			(event) =>
				event.id.includes("event:run.started") && event.runId === runId,
		);
		expect(start?.causeEventId).toBeNull();
	});

	it("auto-dispatches an authorized Kernel delegate_tedi route and links the child run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db, {
			userSub: "operator-1",
		});
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(
			async (input: {
				childRunId: string;
				metadata: Record<string, unknown>;
			}) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO owns this. Dispatching the work order.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product coding tasks.",
					risk: "medium" as const,
					confidence: 0.98,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: "Return the workstation proof.",
				},
				delegation: {
					workOrder: {
						objective: "Run a bounded CPO workstation proof.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract:
							"Return the marker, pwd, git status, and gh version.",
						toolGuidance: ["Use the workstation tools."],
						boundaries: ["Do not write files or push."],
						sourceContent: "Ask CPO to run the workstation proof.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason:
							"authorized operator delegating to an active in-scope target with no high-risk signal",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to run the workstation proof.",
			idempotencyKey: "home-auto-deleg-1",
		});

		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			delegateToTediId: "tedi-cpo",
			metadata: {
				source: "kernelRuntime.autoDispatch",
				homeRunId: "home-auto-deleg-1",
				homeConversationId: "home:test",
				homeMessageId: "home-auto-deleg-1:input",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
		});
		expect(result).toMatchObject({
			status: "queued",
			run: {
				id: "home-auto-deleg-1",
				status: "queued",
				delegatedTediId: "tedi-cpo",
				childRunId: "home-auto-deleg-1:auto:tedi-cpo",
				completedAt: null,
				metadata: {
					childRunId: "home-auto-deleg-1:auto:tedi-cpo",
					delegatedTediId: "tedi-cpo",
					homeAutoDispatch: {
						childRunId: "home-auto-deleg-1:auto:tedi-cpo",
						delegatedTediId: "tedi-cpo",
						status: "queued",
					},
					homeDelegation: {
						decision: { mode: "auto", canAutoDispatch: true },
					},
				},
			},
		});
		expect(db.runs[0]).toMatchObject({
			id: "home-auto-deleg-1",
			status: "queued",
			delegatedTediId: "tedi-cpo",
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			completedAt: null,
		});
		expect(db.events.at(-1)).toMatchObject({
			kind: "run.completed",
			delegatedTediId: "tedi-cpo",
			childRunId: "home-auto-deleg-1:auto:tedi-cpo",
			payload: {
				status: "queued",
				childRunId: "home-auto-deleg-1:auto:tedi-cpo",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
			runtimeMetadata: {
				delegationStatus: "queued",
				delegationWorkOrder: {
					objective: "Run a bounded CPO workstation proof.",
				},
			},
		});
	});

	it("observe-only preserves a delegate route while suppressing its dispatch", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO would own this task.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product work.",
					risk: "medium" as const,
					confidence: 0.98,
					targetTediId: "tedi-cpo",
				},
				delegation: {
					workOrder: {
						objective: "Run the task.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract: "Return proof.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Run it.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason: "authorized",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:observe",
			content: "Who should run this?",
			idempotencyKey: "observe-delegate-1",
			executionPolicy: "observe_only",
		});

		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.run.metadata).toMatchObject({
			executionPolicy: "observe_only",
			effectsSuppressed: true,
			kernelRoute: null,
			kernelObservation: {
				selectedRoute: { routeKind: "delegate_tedi" },
				outcome: "effects_suppressed",
			},
			homeDelegation: null,
		});
		expect(result.assistantMessage?.content).toBe(
			"Observation only: Kernel selected delegate_tedi. No tools, workflows, approvals, writes, Work Items, or delegations were executed.",
		);
		expect(result.run.childRunId).toBeNull();
		expect(
			db.events.find((event) => event.kind === "run.completed")?.payload,
		).toMatchObject({ status: "completed" });
	});

	it("observe-only rejects explicit delegation before target or Work effects", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			client.enqueueMessage({
				conversationId: "home:observe-explicit",
				content: "Delegate this",
				idempotencyKey: "observe-explicit-1",
				delegateToTediId: "tedi-cpo",
				executionPolicy: "observe_only",
			}),
		).rejects.toThrow(/cannot explicitly delegate/);
		expect(db.workItemRows).toHaveLength(0);
		expect(db.approvals).toHaveLength(0);
		await expect(
			client.enqueueMessage({
				conversationId: "home:observe-attachment",
				content: "Inspect this",
				idempotencyKey: "observe-attachment-1",
				executionPolicy: "observe_only",
				attachments: [
					{
						content: "SGVsbG8=",
						fileName: "evidence.txt",
						mimeType: "text/plain",
						type: "file",
					},
				],
			}),
		).rejects.toThrow(/cannot include attachments/);
	});

	it("threads conversation history across kernel turns and isolates conversations", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// The stub runs the real context assembly against the fake D1 ledger
		// with exactly the args the turn body threads through — pinning the
		// persist-first transcript → history seam end to end.
		const histories: Array<Array<{ role: string; content: string }>> = [];
		kernelRuntimeTestHooks.setKernelForTest(async (args) => {
			const ctx = await assembleHomeContext(args.db, args.organizationId, {
				conversationId: args.conversationId,
				excludeMessageId: args.currentUserMessageId,
			});
			histories.push(ctx.history);
			return {
				assistantContent: "Noted.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "memory turn",
					risk: "low" as const,
					confidence: 0.9,
					effortClass: "single_read" as const,
					answer: "Noted.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			};
		});

		await client.enqueueMessage({
			conversationId: "home:memory-a",
			content: "remember my codename is BLUEFALCON-7919",
			idempotencyKey: "memory-a-1",
		});
		await client.enqueueMessage({
			conversationId: "home:memory-a",
			content: "what's my codename?",
			idempotencyKey: "memory-a-2",
		});
		await client.enqueueMessage({
			conversationId: "home:memory-b",
			content: "unrelated turn in another conversation",
			idempotencyKey: "memory-b-1",
		});

		expect(histories).toHaveLength(3);
		// Turn 1: brand-new conversation — its own in-flight user message is
		// already persisted (persist-first) but excluded, so history is empty.
		expect(histories[0]).toEqual([]);
		// Turn 2 (same conversation): sees turn 1's user message and the
		// kernel's answer, oldest → newest — and not its own in-flight message.
		expect(histories[1]?.map((message) => message.content)).toEqual([
			"remember my codename is BLUEFALCON-7919",
			"Noted.",
		]);
		// Cross-conversation isolation: a turn in conversation B sees none of A.
		expect(histories[2]).toEqual([]);
	});

	it("generates a runId when idempotencyKey is omitted (ask ergonomics)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const kernel = vi.fn(async () => ({
			assistantContent: "ROUTED:no-key",
			route: {
				routeKind: "answer_in_home" as const,
				rationale: "Simple question answered in Home.",
				risk: "low" as const,
				confidence: 0.9,
				answer: "ROUTED:no-key",
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		// No idempotencyKey supplied — the MCP ask path relies on this.
		const result = await client.enqueueMessage({
			conversationId: "home:nokey",
			content: "what's our status?",
		});

		expect(result.idempotencyKey).toBeTruthy();
		expect(result.run.id).toBe(result.idempotencyKey);
		expect(kernel).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage?.content).toBe("ROUTED:no-key");
	});

	it("reads one Home run by id via readRun", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(vi.fn(async () => null));

		const created = await client.enqueueMessage({
			conversationId: "home:readrun",
			content: "hello",
			idempotencyKey: "home-readrun-1",
		});
		const read = await client.readRun({ runId: created.run.id });

		expect(read.run.id).toBe("home-readrun-1");
		expect(read.run.conversationId).toBe("home:readrun");
	});

	it("persists the turn BEFORE the kernel resolves and patches the route after (caller-disconnect protection)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:durable",
			content: "check my gmail inbox",
			idempotencyKey: "home-durable-1",
		});
		// Flush the pre-kernel persistence (events + run row) while the kernel
		// is still in flight.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const mid = await client.readRun({ runId: "home-durable-1" });
		expect(mid.run.status).toBe("running");
		expect(mid.run.metadata).toMatchObject({ kernelRoute: null });
		// The kernel work is registered with waitUntil: a disconnected caller
		// no longer cancels the route decision or loses the turn.
		expect(context.waitUntilPromises.length).toBeGreaterThan(0);

		resolveKernel({
			assistantContent: "ROUTED:durable",
			route: {
				routeKind: "answer_in_home",
				rationale: "Answer the operator.",
				risk: "low",
				confidence: 0.8,
				toolIntent: {
					appSlug: "gmail",
					capability: "gmail.read",
					connectionStatus: "connected",
				},
			},
		});
		const result = await pending;
		expect(result.assistantMessage?.content).toBe("ROUTED:durable");
		expect(result.run.status).toBe("completed");

		const read = await client.readRun({ runId: "home-durable-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "answer_in_home" },
			kernelEvidence: null,
		});
	});

	it("a cancel that lands mid-kernel wins over the completion patch (running → completed guard)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:cancel-race",
			content: "slow kernel turn",
			idempotencyKey: "home-cancel-race-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Operator cancels while the kernel is still planning. The run is
		// non-terminal ("running"), so cancelRun accepts it.
		const canceled = await client.cancelRun({
			runId: "home-cancel-race-1",
			reason: "operator changed their mind",
		});
		expect(canceled.run.status).toBe("canceled");

		resolveKernel({
			assistantContent: "ROUTED:too-late",
			route: {
				routeKind: "answer_in_home",
				rationale: "Late kernel result.",
				risk: "low",
				confidence: 0.9,
				answer: "ROUTED:too-late",
			},
		});
		await pending;

		const read = await client.readRun({ runId: "home-cancel-race-1" });
		expect(read.run.status).toBe("canceled");
		expect(read.run.metadata).toMatchObject({ kernelRoute: null });
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "api-key-1",
				actorType: "api_key",
				action: "kernel.run.canceled",
				resourceType: "kernel_run",
				resourceId: "home-cancel-race-1",
				metadata: expect.objectContaining({
					source: "kernelRuntime.cancelRun",
					conversationId: "home:cancel-race",
					reason: "operator changed their mind",
				}),
			}),
		);
	});

	it("steers an active Home run and preserves the steering through kernel completion", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		let resolveKernel!: (value: {
			assistantContent: string;
			route: Record<string, unknown>;
		}) => void;
		const gate = new Promise<{
			assistantContent: string;
			route: Record<string, unknown>;
		}>((resolve) => {
			resolveKernel = resolve;
		});
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(() => gate) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const pending = client.enqueueMessage({
			conversationId: "home:steer-race",
			content: "slow kernel turn",
			idempotencyKey: "home-steer-race-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const steered = await client.steerRun({
			runId: "home-steer-race-1",
			instruction: "Focus on Acme evidence first.",
		});
		expect(steered.run.status).toBe("running");
		expect(steered.run.metadata).toMatchObject({
			latestSteeringInstruction: "Focus on Acme evidence first.",
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "message.received" &&
					event.messageId?.startsWith("home-steer-race-1:steer:") &&
					(event.payload as { content?: string } | null)?.content ===
						"Focus on Acme evidence first.",
			),
		).toBe(true);

		resolveKernel({
			assistantContent: "ROUTED:after-steer",
			route: {
				routeKind: "answer_in_home",
				rationale: "Late kernel result.",
				risk: "low",
				confidence: 0.9,
				answer: "ROUTED:after-steer",
			},
		});
		await pending;

		const read = await client.readRun({ runId: "home-steer-race-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			latestSteeringInstruction: "Focus on Acme evidence first.",
			kernelRoute: { routeKind: "answer_in_home" },
		});
		const instructions = (read.run.metadata as Record<string, unknown>)
			.steeringInstructions as Array<Record<string, unknown>>;
		expect(instructions.at(-1)).toMatchObject({
			instruction: "Focus on Acme evidence first.",
			source: "kernelRuntime.steerRun",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "api-key-1",
				actorType: "api_key",
				action: "kernel.run.steered",
				resourceType: "kernel_run",
				resourceId: "home-steer-race-1",
				metadata: expect.objectContaining({
					source: "kernelRuntime.steerRun",
					conversationId: "home:steer-race",
					instructionLength: "Focus on Acme evidence first.".length,
					instructionPreview: "Focus on Acme evidence first.",
				}),
			}),
		);
	});

	it("settles the turn failed (model unavailable) when the Kernel returns null — no heuristic answer", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const kernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(kernel);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Capture this idea for the quarterly planning review",
			idempotencyKey: "kernel-null-1",
		});
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(kernel).toHaveBeenCalledTimes(1);
		// LLM-only kernel: no route decision is a hard failure, not a fabricated
		// answer. The operator sees a clear model-unavailable notice.
		expect(result.status).toBe("failed");
		expect(result.run.status).toBe("failed");
		expect(result.assistantMessage?.content).toContain(
			"configured model did not produce a valid route decision",
		);
		const persistedAssistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		expect(persistedAssistant?.content).toContain(
			"configured model did not produce a valid route decision",
		);
		expect(result.run.metadata).toMatchObject({ kernelRoute: null });
	});

	it("records Home turns against the organization subject instead of a hidden tedi", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// LLM-only kernel: provide a real answer_in_home route so the turn settles
		// normally (the org-subject assertions below are the point of this test).
		kernelRuntimeTestHooks.setKernelForTest(async () => ({
			assistantContent: "Captured against the org subject.",
			route: {
				routeKind: "answer_in_home" as const,
				rationale: "home subject smoke",
				risk: "low" as const,
				confidence: 0.9,
				effortClass: "single_read" as const,
				answer: "Captured against the org subject.",
				targetTediId: null,
				targetTediLabel: null,
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
			},
			evidence: null,
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Validate the Home subject",
			idempotencyKey: "home-smoke-1",
		});
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result).toMatchObject({
			conversationId: "home:test",
			status: "needs_delegation",
			run: {
				delegatedTediId: null,
				runtime: {
					backend: "custom",
				},
			},
		});
		expect(result.assistantMessage?.content).toContain(
			"Captured against the org subject.",
		);
		expect(messages.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(db.events.every((event) => event.organizationId === ORG_ID)).toBe(
			true,
		);
		expect(db.events.every((event) => event.delegatedTediId === null)).toBe(
			true,
		);
	});

	it("drafts a multi-assignment Home plan for CPO and Echo before dispatch", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn(async (input) => ({
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the product checklist while Echo validates evidence and gaps.",
			idempotencyKey: "home-plan-1",
		});

		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.status).toBe("needs_delegation");
		expect(result.run.delegatedTediId).toBeNull();
		expect(result.homePlan).toMatchObject({
			id: "home-plan-1:plan",
			status: "proposed",
			assignments: [
				{
					ownerTediId: "tedi-cpo",
					ownerLabel: "CPO",
					routeKind: "agent",
					status: "proposed",
				},
				{
					ownerTediId: "tedi-echo",
					ownerLabel: "Echo (Isolate)",
					routeKind: "agent",
					status: "proposed",
				},
			],
		});
		expect(result.assistantMessage?.content).toContain("I drafted a Home plan");
		expect(result.assistantMessage?.metadata).toMatchObject({
			metadata: {
				homePlan: {
					id: "home-plan-1:plan",
					assignments: [
						{ ownerTediId: "tedi-cpo" },
						{ ownerTediId: "tedi-echo" },
					],
				},
			},
		});
		expect(db.runs[0]?.metadata).toMatchObject({
			homePlan: {
				id: "home-plan-1:plan",
				assignments: [
					{ ownerTediId: "tedi-cpo" },
					{ ownerTediId: "tedi-echo" },
				],
			},
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "decision.recorded" &&
					event.runId === "home-plan-1" &&
					(event.payload as { homePlan?: { id?: string } } | null)?.homePlan
						?.id === "home-plan-1:plan",
			),
		).toBe(true);
		expect(db.events.every((event) => event.delegatedTediId === null)).toBe(
			true,
		);
	});

	it("plan-producing turn settles its kernel submission in-band", async () => {
		// Regression test for the plan-path in-band settle gap: a turn that parks a
		// homePlan (multi-tedi request) completes immediately with status="completed"
		// but its kernel submission was admitted by insertKernelRuntimeRun and then
		// never settled in turn-work (plan turns bypass kernelEligible). The fix adds
		// settleKernelSubmission on the plan-park path; this test asserts the call is
		// made in-band with outcome "settled" before returning.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childRunId: input.childRunId,
			status: "queued" as const,
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO takes the roadmap while Echo audits evidence.",
			idempotencyKey: "home-plan-settle-1",
		});
		await Promise.all(context.waitUntilPromises);

		// The submission id is deterministic: kernelSubmissionId("home-plan-settle-1") = "sub:home-plan-settle-1"
		const settleCall = db.submissionSettleCalls.find(
			(call) => call.submissionId === "sub:home-plan-settle-1",
		);
		expect(settleCall).toBeDefined();
		expect(settleCall?.outcome).toBe("settled");
	});

	it("approves a Home plan into Work Items and dispatches isolate assignments", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const originalRequest = `Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.\n${"Supporting detail. ".repeat(900)}\nMiddle acceptance: the independent oracle must remain unchanged.\n${"Further context. ".repeat(1000)}\nFinal acceptance: preserve both merge parents.`;
		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content: originalRequest,
			idempotencyKey: "home-plan-approve-1",
		});
		const approved = await client.approvePlanAssignments({
			runId: "home-plan-approve-1",
			approvalNote: "Approved from Home validation test",
		});
		await Promise.all(context.waitUntilPromises);

		expect(proposed.homePlan?.assignments).toHaveLength(2);
		expect(approved.homePlan.status).toBe("dispatching");
		expect(approved.assignments).toHaveLength(2);
		expect(approved.assignments.map((assignment) => assignment.status)).toEqual(
			["queued", "queued"],
		);
		expect(db.workItemRows).toHaveLength(2);
		expect(db.workItemRows.map((item) => item.accountableOwnerId)).toEqual([
			"tedi-cpo",
			"tedi-echo",
		]);
		expect(db.workItemCommentRows).toHaveLength(2);
		expect(delegateRunner).toHaveBeenCalledTimes(2);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cpo",
			metadata: {
				homePlanAssignmentId: proposed.homePlan?.assignments[0]?.id,
				workItemId: db.workItemRows[0]?.id,
			},
		});
		expect(db.workItemRows[0]?.description).toContain(
			"Assignment scope is authoritative: execute and report only the objective above.",
		);
		expect(db.workItemRows[0]?.description).toContain(
			"Original Home request (supporting context only):",
		);
		expect(db.workItemRows[0]?.description).toContain(originalRequest);
		for (const item of db.workItemRows)
			expect(item.description).toContain(originalRequest);
		for (const [dispatch] of delegateRunner.mock.calls)
			expect(dispatch.content).toContain(originalRequest);
		for (const assignment of proposed.homePlan?.assignments ?? [])
			expect(assignment.objective.length).toBeLessThanOrEqual(600);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Assignment scope is authoritative: execute and report only the objective above.",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Do not perform, summarize, or claim completion of another owner's objective",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			"Original Home request (supporting context only):",
		);
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			originalRequest,
		);
		expect(
			db.events.some(
				(event) =>
					event.kind === "decision.recorded" &&
					(event.payload as { action?: string } | null)?.action ===
						"home.plan.approved",
			),
		).toBe(true);
		expect(db.runs[0]?.metadata).toMatchObject({
			homePlan: {
				status: "dispatching",
				assignments: [
					{
						status: "queued",
						workItemId: db.workItemRows[0]?.id,
					},
					{
						status: "queued",
						workItemId: db.workItemRows[1]?.id,
					},
				],
			},
		});
	});

	it("materializes inferred plan dependencies into work_item_relations and defers the dependent on dispatch", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// CTO (blocker) must finish before CMO (dependent).
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO's deploy gate.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-1",
			approvalNote: "Approved with a CTO→CMO dependency",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		expect(ctoWorkItem).toBeDefined();
		expect(cmoWorkItem).toBeDefined();

		// (a) the inferred edge became a canonical blocks relation, blocker→dependent.
		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRelationRows[0]).toMatchObject({
			relationType: "blocks",
			fromWorkItemId: ctoWorkItem?.id,
			toWorkItemId: cmoWorkItem?.id,
		});
		expect(db.workItemRelationRows[0]?.metadata).toMatchObject({
			source: "kernelRuntime.plan.inferredDependency",
			homePlanId: "home-plan-deps-1:plan",
		});

		// (b) the shipped blocker query reads CTO as a blocker of CMO.
		const blockers = await queryWorkItemBlockers(
			db as never,
			cmoWorkItem?.id ?? "",
		);
		expect(blockers.map((blocker) => blocker.id)).toContain(ctoWorkItem?.id);
		// findWorkItemsBlockedBy is the inverse: CMO is a dependent of CTO.
		const dependents = await findWorkItemsBlockedBy(
			db as never,
			ctoWorkItem?.id ?? "",
		);
		expect(dependents.map((dependent) => dependent.id)).toContain(
			cmoWorkItem?.id,
		);

		// (c) CTO dispatches; CMO stays approved (deferred) with a blocked_by_dependency note.
		const ctoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cto",
		);
		const cmoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cmo",
		);
		expect(ctoResult?.status).toBe("queued");
		expect(cmoResult?.status).toBe("approved");
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});
		expect(
			db.workItemCommentRows.some(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
						"kernelRuntime.approvePlanAssignments" &&
					comment.workItemId === cmoWorkItem?.id,
			),
		).toBe(true);
	});

	it("a thrown child dispatch persists status 'failed' identically in the parallel and serialized fan-out paths", async () => {
		// A dispatch that throws (e.g. runtime_unavailable) must persist the same
		// assignment status regardless of whether the plan carries a cross-tedi
		// dependency edge (serialized path) or not (parallel path). Previously the
		// parallel path deferred dispatch settlement to a post-persist
		// context.waitUntil, so the run row was written with the optimistic "queued"
		// status (and a predicted childRunId that never settles) while the serialized
		// path — which awaits each child in-loop before persist — captured "failed".
		// Same failure, divergent persisted state, split only on an unrelated edge.
		// The mock is async so kernelDelegateRunner returns a rejected promise (as the
		// real runner does on a failed enqueue) that the in-code `.catch` handles.
		const throwOnCto = async (input: { delegateToTediId: string }) => {
			if (input.delegateToTediId === "tedi-cto") {
				throw new Error("runtime_unavailable");
			}
			return {
				childConversationId: "agent:main:main",
				childRunId: `child:${input.delegateToTediId}`,
				status: "queued" as const,
			};
		};

		const persistedStatusFor = (
			db: ReturnType<typeof createKernelRuntimeDb>,
			runId: string,
			ownerTediId: string,
		) => {
			const run = db.runs.find((row) => row.id === runId);
			const plan = (
				run?.metadata as {
					homePlan?: {
						assignments: Array<{
							ownerTediId: string;
							status: string;
							error?: string | null;
						}>;
					};
				} | null
			)?.homePlan;
			return plan?.assignments.find(
				(assignment) => assignment.ownerTediId === ownerTediId,
			);
		};

		// (1) Parallel path — two independent assignments, no dependency edge. Both
		// dispatch in parallel; the tedi-cto dispatch throws.
		const parallelDb = createKernelRuntimeDb();
		const parallelContext = createContext(parallelDb);
		const parallelClient = createKernelRuntimeClient(parallelContext);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(vi.fn(throwOnCto));
		seedDependencyPlanRun(parallelDb, {
			runId: "home-plan-parallel-fail-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-echo",
					ownerTediId: "tedi-echo",
					ownerLabel: "Echo",
				}),
			],
			dependencies: [],
		});
		const parallelApproved = await parallelClient.approvePlanAssignments({
			runId: "home-plan-parallel-fail-1",
			approvalNote: "Approve independent fan-out",
		});
		await Promise.all(parallelContext.waitUntilPromises);

		// (2) Serialized path — same failing owner is the blocker of a dependent, so
		// the plan carries a dependency edge and dispatches sequentially. The
		// tedi-cto dispatch throws; the dependent (tedi-cmo) is deferred.
		const serialDb = createKernelRuntimeDb();
		const serialContext = createContext(serialDb);
		const serialClient = createKernelRuntimeClient(serialContext);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(vi.fn(throwOnCto));
		seedDependencyPlanRun(serialDb, {
			runId: "home-plan-serial-fail-1",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
			],
		});
		const serialApproved = await serialClient.approvePlanAssignments({
			runId: "home-plan-serial-fail-1",
			approvalNote: "Approve coordination-dependent fan-out",
		});
		await Promise.all(serialContext.waitUntilPromises);

		// Parity: the same thrown dispatch persists "failed" in both paths.
		const parallelCto = persistedStatusFor(
			parallelDb,
			"home-plan-parallel-fail-1",
			"tedi-cto",
		);
		const serialCto = persistedStatusFor(
			serialDb,
			"home-plan-serial-fail-1",
			"tedi-cto",
		);
		expect(serialCto?.status).toBe("failed");
		expect(parallelCto?.status).toBe("failed");
		expect(parallelCto?.status).toBe(serialCto?.status);
		expect(parallelCto?.error).toContain("runtime_unavailable");

		// The successful independent sibling still persists "queued" — the fix is
		// scoped to the failed dispatch, not a blanket downgrade.
		const parallelEcho = persistedStatusFor(
			parallelDb,
			"home-plan-parallel-fail-1",
			"tedi-echo",
		);
		expect(parallelEcho?.status).toBe("queued");

		// The API return value and event payload agree with the persisted plan.
		expect(
			parallelApproved.assignments.find(
				(assignment) => assignment.ownerTediId === "tedi-cto",
			)?.status,
		).toBe("failed");
		expect(
			serialApproved.assignments.find(
				(assignment) => assignment.ownerTediId === "tedi-cto",
			)?.status,
		).toBe("failed");
	});

	it("a write-bearing multi-tedi fan-out is chained, not raced (only the chain head dispatches)", async () => {
		// Three independent write-bearing assignments (no dependency edges) — the
		// "no cross-facet write races" case. shouldSerializeFanOut flags this
		// (writeBearingCount 3 > 1). The old serialized branch only `await`ed the
		// async delegate enqueue, which resolves once the child turn is queued, not
		// when its work runs — so all three still dispatched and executed concurrently
		// in their own runtimes, racing on shared state. The fix chains the fan-out
		// into one line of blocker edges so the blocker gate defers all but the single
		// chain head: exactly one child dispatches this turn and the unblock watcher
		// advances the rest one at a time. Pre-fix this expected 3 dispatches.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// A write-bearing objective (mutation verb) makes each assignment count toward
		// writeBearingCount without needing a workstation/workflow route.
		const writeBearing = (
			seed: ReturnType<typeof planAssignmentSeed>,
			objective: string,
		) => ({
			...seed,
			objective,
		});

		seedDependencyPlanRun(db, {
			runId: "home-plan-write-race",
			assignments: [
				writeBearing(
					planAssignmentSeed({
						id: "assign-cto",
						ownerTediId: "tedi-cto",
						ownerLabel: "CTO",
					}),
					"Deploy the shared config bundle",
				),
				writeBearing(
					planAssignmentSeed({
						id: "assign-cmo",
						ownerTediId: "tedi-cmo",
						ownerLabel: "CMO",
					}),
					"Update the shared campaign ledger",
				),
				writeBearing(
					planAssignmentSeed({
						id: "assign-cpo",
						ownerTediId: "tedi-cpo",
						ownerLabel: "CPO",
					}),
					"Publish the shared roadmap doc",
				),
			],
			dependencies: [],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-write-race",
			approvalNote: "Approved an independent write-bearing fan-out",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		const cpoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cpo",
		);

		// (a) The fix: exactly one child dispatches — the chain head. Pre-fix all
		// three write-bearing members dispatched and raced (this asserted 3).
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});

		// (b) the other two write-bearing members stay approved (deferred by the gate)
		// with a blocker note — they run only after the head completes.
		const statusFor = (ownerTediId: string) =>
			approved.assignments.find(
				(assignment) => assignment.ownerTediId === ownerTediId,
			)?.status;
		expect(statusFor("tedi-cto")).toBe("queued");
		expect(statusFor("tedi-cmo")).toBe("approved");
		expect(statusFor("tedi-cpo")).toBe("approved");
		for (const deferred of [cmoWorkItem, cpoWorkItem]) {
			expect(
				db.workItemCommentRows.some(
					(comment) =>
						(comment.metadata as { source?: string }).source ===
							"kernelRuntime.approvePlanAssignments" &&
						comment.workItemId === deferred?.id,
				),
			).toBe(true);
		}

		// (c) the serialization is real: two synthetic chain edges (CTO→CMO→CPO), a
		// linear extension over the otherwise edgeless set, single-thread the whole
		// fan-out through the existing blocker gate + unblock watcher.
		const chainEdges = db.workItemRelationRows.filter(
			(row) =>
				(row.metadata as { source?: string } | null)?.source ===
				"kernelRuntime.plan.serializedFanOut",
		);
		expect(chainEdges).toHaveLength(2);
		expect(chainEdges).toContainEqual(
			expect.objectContaining({
				relationType: "blocks",
				fromWorkItemId: ctoWorkItem?.id,
				toWorkItemId: cmoWorkItem?.id,
			}),
		);
		expect(chainEdges).toContainEqual(
			expect.objectContaining({
				relationType: "blocks",
				fromWorkItemId: cmoWorkItem?.id,
				toWorkItemId: cpoWorkItem?.id,
			}),
		);
	});

	it("defers the dependent even when it is listed before its blocker (pre-pass creates all relations before any gate runs)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		// Reversed listing: CMO (the dependent) is at index 0, CTO (the blocker)
		// at index 1. The inferred edge is still CTO→CMO (blocker→dependent). A
		// naive interleaved implementation that materialized relations as it
		// processed each assignment would gate CMO at index 0 before CTO's Work
		// Item / relation existed, so it would dispatch CMO. The pre-pass creates
		// all Work Items + all relations first, so the gate sees CTO blocking CMO
		// regardless of listing order.
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-reordered",
			assignments: [
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO's deploy gate.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-reordered",
			approvalNote:
				"Approved with a CTO→CMO dependency (dependent listed first)",
		});
		await Promise.all(context.waitUntilPromises);

		const ctoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cto",
		);
		const cmoWorkItem = db.workItemRows.find(
			(item) => item.accountableOwnerId === "tedi-cmo",
		);
		expect(ctoWorkItem).toBeDefined();
		expect(cmoWorkItem).toBeDefined();

		// (c) the inferred edge materialized as a canonical blocks relation,
		// blocker→dependent (CTO Work Item → CMO Work Item).
		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRelationRows[0]).toMatchObject({
			relationType: "blocks",
			fromWorkItemId: ctoWorkItem?.id,
			toWorkItemId: cmoWorkItem?.id,
		});

		// (a) only the blocker (CTO) dispatches — exactly once — even though the
		// dependent (CMO) was processed first in listing order.
		const ctoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cto",
		);
		const cmoResult = approved.assignments.find(
			(assignment) => assignment.ownerTediId === "tedi-cmo",
		);
		expect(ctoResult?.status).toBe("queued");
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			delegateToTediId: "tedi-cto",
		});

		// (b) the dependent (CMO) stays approved (deferred by the gate) and carries
		// a blocked_by_dependency note rather than dispatching.
		expect(cmoResult?.status).toBe("approved");
		expect(
			db.workItemCommentRows.some(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
						"kernelRuntime.approvePlanAssignments" &&
					comment.workItemId === cmoWorkItem?.id,
			),
		).toBe(true);
	});

	it("re-approving a dependency plan does not duplicate the work_item_relations row", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));

		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-idem",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
			],
		});

		// Explicit assignmentIds so the second pass re-selects both owners (their
		// status is no longer "proposed" after the first approval). createWorkItem
		// upserts on (orgId, sourceIntentId), so the Work Item ids are stable across
		// re-approvals — addWorkItemRelation then collides on its unique index.
		await client.approvePlanAssignments({
			runId: "home-plan-deps-idem",
			assignmentIds: ["assign-cto", "assign-cmo"],
		});
		await Promise.all(context.waitUntilPromises);
		await client.approvePlanAssignments({
			runId: "home-plan-deps-idem",
			assignmentIds: ["assign-cto", "assign-cmo"],
		});
		await Promise.all(context.waitUntilPromises);

		expect(db.workItemRelationRows).toHaveLength(1);
		expect(db.workItemRows).toHaveLength(2);
	});

	it("survives a cyclic dependency snapshot fail-soft without throwing", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued" as const,
		}));

		// The planner prunes cycles, but a corrupt/forged snapshot could carry one.
		// Both edges materialize; each owner blocks the other, so both defer — and
		// crucially the approval completes without throwing.
		seedDependencyPlanRun(db, {
			runId: "home-plan-deps-cycle",
			assignments: [
				planAssignmentSeed({
					id: "assign-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
				}),
				planAssignmentSeed({
					id: "assign-cmo",
					ownerTediId: "tedi-cmo",
					ownerLabel: "CMO",
				}),
			],
			dependencies: [
				{
					fromOwnerTediId: "tedi-cto",
					toOwnerTediId: "tedi-cmo",
					reason: "CMO waits on CTO.",
				},
				{
					fromOwnerTediId: "tedi-cmo",
					toOwnerTediId: "tedi-cto",
					reason: "CTO waits on CMO.",
				},
			],
		});

		const approved = await client.approvePlanAssignments({
			runId: "home-plan-deps-cycle",
		});
		await Promise.all(context.waitUntilPromises);

		expect(db.workItemRelationRows).toHaveLength(2);
		// Deadlocked but fail-soft: nothing dispatched, both stay approved.
		expect(
			approved.assignments.every(
				(assignment) => assignment.status === "approved",
			),
		).toBe(true);
		expect(
			db.workItemCommentRows.filter(
				(comment) =>
					(comment.metadata as { source?: string }).source ===
					"kernelRuntime.approvePlanAssignments",
			),
		).toHaveLength(2);
	});

	it("reconciles approved Home plan assignment completions into Work Items and Home messages", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: `${input.delegateToTediId}:mcp:${input.childRunId.replaceAll(":", "_")}`,
			status: "queued",
		}));

		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns launch criteria and Echo validates evidence.",
			idempotencyKey: "home-plan-terminal-1",
		});
		await client.approvePlanAssignments({
			runId: "home-plan-terminal-1",
		});
		await Promise.all(context.waitUntilPromises);
		const cpoAssignment = proposed.homePlan?.assignments[0];
		const echoAssignment = proposed.homePlan?.assignments[1];

		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-plan-cpo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "CPO launch criteria proof.",
				},
				runId: "tedi-cpo:mcp:home-plan-terminal-1_plan_1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "runtime-plan-echo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "Echo evidence validation proof.",
				},
				runId: "tedi-echo:mcp:home-plan-terminal-1_plan_2_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result.runSet.activeRunIds).toEqual(["home-plan-terminal-1"]);
		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-plan-terminal-1",
			status: "running",
			outputMessageId: "home-plan-terminal-1:assistant",
			progress: {
				current: 100,
				label: "Complete",
			},
			metadata: {
				homePlanConvergencePending: true,
				homePlan: {
					status: "completed",
					assignments: [
						{
							id: cpoAssignment?.id,
							status: "completed",
							workItemId: db.workItemRows[0]?.id,
						},
						{
							id: echoAssignment?.id,
							status: "completed",
							workItemId: db.workItemRows[1]?.id,
						},
					],
				},
			},
		});
		expect(db.workItemRows.map((item) => item.disposition)).toEqual([
			"accepted",
			"accepted",
		]);
		expect(db.workAttemptRows.map((attempt) => attempt.runtimeState)).toEqual([
			"finished",
			"finished",
		]);
		expect(
			db.workItemCommentRows.filter((comment) =>
				comment.id.includes(":home-plan-terminal:completed"),
			),
		).toHaveLength(2);
		expect(
			db.events
				.filter((event) =>
					event.messageId?.includes(":async-completion:assistant"),
				)
				.map((event) => ({
					content: (event.payload as { content?: string } | null)?.content,
					delegatedTediId: event.delegatedTediId,
				})),
		).toEqual(
			expect.arrayContaining([
				{
					content:
						"CPO finished the approved Home assignment. Latest evidence: CPO launch criteria proof.",
					delegatedTediId: "tedi-cpo",
				},
				{
					content:
						"Echo (Isolate) finished the approved Home assignment. Latest evidence: Echo evidence validation proof.",
					delegatedTediId: "tedi-echo",
				},
			]),
		);

		await client.readRunSet({ conversationId: "home:test", limit: 10 });
		expect(
			db.workItemCommentRows.filter((comment) =>
				comment.id.includes(":home-plan-terminal:completed"),
			),
		).toHaveLength(2);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 20,
		});
		expect(
			messages.messages.filter((message) =>
				message.id.includes(":async-completion:assistant"),
			),
		).toHaveLength(0);
		expect(
			messages.messages.find((message) =>
				message.id.includes(":plan-convergence:assistant"),
			),
		).toBeUndefined();
	});

	it("dedupes retries by the Home idempotency key", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "First submit",
			idempotencyKey: "home-retry-1",
		});
		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Retried submit",
			idempotencyKey: "home-retry-1",
		});

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		expect(messages.messages).toHaveLength(2);
		expect(messages.messages.map((message) => message.id)).toEqual([
			"home-retry-1:input",
			"home-retry-1:assistant",
		]);
	});

	it("delegates explicit Home turns through a linked child tedi run", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO to validate the deploy plan",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-1",
		});

		// The linked child id now comes from the settled dispatch result rather
		// than an optimistic prediction, so the run row can never reference a
		// child the runtime never minted.
		expect(result).toMatchObject({
			status: "queued",
			run: {
				delegatedTediId: "tedi-cpo",
				childRunId: "home-delegate-1:delegate:tedi-cpo",
			},
			assistantMessage: {
				content: expect.stringContaining("delegated this Home turn"),
			},
		});
		expect(
			db.events.some(
				(event) =>
					event.delegatedTediId === "tedi-cpo" &&
					event.childRunId === "home-delegate-1:delegate:tedi-cpo",
			),
		).toBe(true);
		// The directed-delegation insert synthesizes a `kernelRoute` (gated on
		// `delegateToTediId`): a directed `queued` run never runs the route planner
		// and is never patched by the `WHERE status="running"` writer-back, so this
		// is the only place the Tedix OS rail's decision chip gets a route to render.
		expect(db.runs[0]?.metadata).toMatchObject({
			delegationWorkOrder: {
				kind: "tedi.delegate",
				targetTediId: "tedi-cpo",
				executionRequirement: {
					surface: "native",
					fallbackSurface: "workstation",
				},
			},
			kernelRoute: {
				routeKind: "delegate_tedi",
				source: "explicit",
				confidence: 1,
				risk: "low",
			},
		});
	});

	it("settles the delegated isolate dispatch before returning the Home receipt", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		let finishDelegate: (() => void) | null = null;
		const delegateStarted = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			(input) =>
				new Promise((resolve) => {
					delegateStarted(input.childRunId);
					finishDelegate = () =>
						resolve({
							childConversationId: "agent:main:main",
							childRunId: input.childRunId,
							status: "queued",
						});
				}),
		);

		const pending = client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO and settle the handoff first",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-nonblocking-delegate-1",
		});

		// Let the turn run up to the dispatch, which then parks on finishDelegate.
		for (
			let tick = 0;
			tick < 50 && !delegateStarted.mock.calls.length;
			tick++
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(delegateStarted).toHaveBeenCalledWith(
			"home-nonblocking-delegate-1:delegate:tedi-cpo",
		);

		// The receipt must not resolve while that dispatch is still in flight.
		// Deferring the handoff to waitUntil is what let an isolate eviction take
		// the inject, the ledger seed-writes and the failure recorder with it
		// while the operator was told the work had been delegated.
		const settledEarly = await Promise.race([
			pending.then(() => "resolved" as const),
			new Promise<"still-pending">((resolve) =>
				setTimeout(() => resolve("still-pending"), 20),
			),
		]);
		expect(settledEarly).toBe("still-pending");

		finishDelegate?.();
		const result = await pending;

		// Only the ledger admission and the auto-title dispatch remain on the
		// background queue; the dispatch itself is no longer there.
		expect(context.waitUntilPromises).toHaveLength(1);
		expect(result).toMatchObject({
			status: "queued",
			run: {
				childRunId: "home-nonblocking-delegate-1:delegate:tedi-cpo",
			},
		});
		await Promise.all(context.waitUntilPromises);
	});

	it("reports a terminal Home failure in-band when isolate dispatch fails", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			error: "isolate dispatch unavailable",
			status: "failed",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO and surface dispatch failure",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-fail-1",
		});

		// The failure is known before the operator is answered, so the receipt
		// says "failed" instead of claiming the turn was delegated.
		expect(result.status).toBe("failed");
		await Promise.all(context.waitUntilPromises);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-fail-1",
		);
		expect(run).toMatchObject({
			id: "home-delegate-fail-1",
			status: "failed",
			progress: {
				label: "Failed",
			},
			metadata: {
				childRunStatus: "failed",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error: "isolate dispatch unavailable",
					retryable: true,
					childStillRunning: false,
				},
			},
		});

		// Summary mode: same runs, metadata bags and the
		// approval-mirror projection shed — a scanning agent keeps identity,
		// status, timing, and progress without the per-run JSON bulk.
		const compactSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
			summary: true,
		});
		const compactRun = compactSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-fail-1",
		);
		expect(compactRun).toMatchObject({
			id: "home-delegate-fail-1",
			status: "failed",
			progress: { label: "Failed" },
		});
		expect(compactRun?.metadata).toBeUndefined();
		expect(compactSet.runSet.approvalMirrors).toBeUndefined();

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		// One delegation = one row: the dispatch-failure turn's prose was a
		// template over (status, preview) and the turn ahead of it already
		// carries this child run's delegation metadata — the row Tedix OS builds the
		// receipt from — so the restatement no longer renders as its own turn.
		expect(
			messages.messages.some((message) =>
				message.id.includes("async-completion"),
			),
		).toBe(false);
		// The failure is not lost: it lands on the surviving delegation turn's
		// metadata, which is exactly what the receipt row renders (status label
		// + error + preview).
		const delegationTurn = messages.messages.find(
			(message) => message.role === "assistant" && message.childRunId != null,
		);
		expect(delegationTurn).toMatchObject({
			role: "assistant",
			delegatedTediId: "tedi-cpo",
			metadata: {
				metadata: {
					childRunStatus: "failed",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error: "isolate dispatch unavailable",
						retryable: true,
						childStillRunning: false,
					},
				},
			},
		});
		// The prose stays verbatim in the append-only ledger — only the rendered
		// transcript collapses it.
		const ledgerRow = db.events.find((event) =>
			event.id.includes("delegation-dispatch-failed"),
		);
		expect(
			(ledgerRow?.payload as { content?: string } | null)?.content,
		).toContain("assignment failed");
		expect(
			(
				(ledgerRow?.payload as { metadata?: Record<string, unknown> } | null)
					?.metadata ?? {}
			).homeNarration,
		).toBe("delegation_status_only");
	});

	it("reconciles stale delegated isolate dispatch rows into terminal Home failures", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const client = createKernelRuntimeClient(context);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO and reconcile if child dispatch never publishes",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-stale-1",
		});

		expect(result.status).toBe("queued");
		await Promise.all(context.waitUntilPromises);
		const runRow = db.runs.find((candidate) => candidate.id === result.run.id);
		expect(runRow).toBeTruthy();
		Object.assign(runRow ?? {}, {
			createdAt: "2000-01-01T00:00:00.000Z",
			startedAt: "2000-01-01T00:00:00.000Z",
			updatedAt: "2000-01-01T00:00:00.000Z",
		});

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-delegate-stale-1",
		);
		expect(run).toMatchObject({
			id: "home-delegate-stale-1",
			status: "failed",
			progress: {
				label: "Failed",
			},
			metadata: {
				childRunStatus: "failed",
				delegationFailure: {
					ok: false,
					status: "failed",
					reason: "dispatch_failed",
					error:
						"Delegated child dispatch timed out before the child runtime published events",
					retryable: true,
					childStillRunning: false,
				},
				source: "kernelRuntime.delegateDispatch",
			},
		});

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		// Prose collapsed into the receipt row; the timeout cause is carried by
		// the structured metadata the receipt renders from, not by a second
		// full-height turn restating it.
		expect(
			messages.messages.some((message) =>
				message.id.includes("async-completion"),
			),
		).toBe(false);
		expect(
			messages.messages.find(
				(message) => message.role === "assistant" && message.childRunId != null,
			),
		).toMatchObject({
			role: "assistant",
			delegatedTediId: "tedi-cpo",
			metadata: {
				metadata: {
					childRunStatus: "failed",
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error:
							"Delegated child dispatch timed out before the child runtime published events",
						retryable: true,
						childStillRunning: false,
					},
				},
			},
		});
	});

	it("enriches delegated Home messages with child runtime status", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask the CPO to validate the deploy plan",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-delegate-status-1",
		});
		// Genuine completion: both message.completed (substantive result) and
		// run.completed present so the disposition gate reports completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "runtime-child-message-status-1",
				kind: "message.completed",
				payload: { role: "assistant", content: "Deploy plan validated." },
				runId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "runtime-child-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		const assistant = messages.messages.find(
			(message) => message.role === "assistant",
		);
		const nestedMetadata = assistant?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;

		expect(nestedMetadata).toMatchObject({
			childRunId: "tedi-cpo:mcp:home-delegate-status-1_delegate_tedi-cpo",
			childRunLatestEventKind: "run.completed",
			childRunStatus: "completed",
		});
	});

	it("settles parent as completed when child has run.failed THEN run.completed (race guard)", async () => {
		// Bug A: a transient run.failed event (e.g. orphan-sweep) followed by a real
		// run.completed for the same child run_id must resolve to completed, not failed.
		// The event rows are DESC-ordered on read; run.completed (chronologically later)
		// appears first so the primary mechanism already handles this, but the race
		// guard in summarizeChildRuntimeEvents also covers the reverse DESC case.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO, expect race-guard to protect completion",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-race-guard-1",
		});
		const childRunId = "tedi-cpo:mcp:home-race-guard-1_delegate_tedi-cpo";
		// run.failed appears chronologically first (e.g. transient orphan-sweep at T1)
		// then run.completed at T2 with a real message.completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-race-failed",
				kind: "run.failed",
				payload: { error: "transient orphan sweep" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "child-race-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "CPO completed the task." },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:01.000Z",
				id: "child-race-completed",
				kind: "run.completed",
				payload: null,
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-race-guard-1",
		);
		expect(run).toMatchObject({
			id: "home-race-guard-1",
			status: "completed",
			metadata: {
				childRunStatus: "completed",
			},
		});
	});

	it("treats run.completed with no substantive result as failed (disposition gate)", async () => {
		// Bug B: a bare run.completed with no message.completed, no artifact.created,
		// and no preview (the dropped-runtime/succeededLost shape) must not surface as
		// a clean completed — it produced no answer, so it should fail so the operator
		// knows to retry rather than seeing an empty work card.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO, child drops with empty completion",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-disposition-gate-1",
		});
		const childRunId = "tedi-cpo:mcp:home-disposition-gate-1_delegate_tedi-cpo";
		// Only run.completed with no message.completed, no artifact.created, no
		// substantive payload content — the succeededLost / dropped-runtime shape.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-bare-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cpo",
			}),
		);

		const runSet = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-disposition-gate-1",
		);
		expect(run).toMatchObject({
			id: "home-disposition-gate-1",
			status: "failed",
			metadata: {
				childRunStatus: "failed",
			},
		});
	});

	it("exposes durable Home run-set membership with active child progress", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask Echo to keep working",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-run-set-1",
		});
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			delta: null,
			id: "runtime-child-started-run-set",
			kind: "run.started",
			messageId: null,
			organizationId: ORG_ID,
			payload: { status: "running" },
			runId: "tedi-echo:mcp:home-run-set-1_delegate_tedi-echo",
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			sequence: null,
			tediId: "tedi-echo",
			toolCallId: null,
		});

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result.runSet).toMatchObject({
			activeRunIds: ["home-run-set-1"],
			conversationId: "home:test",
			organizationId: ORG_ID,
			metadata: {
				model: "kernel_runtime_runs",
			},
		});
		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-run-set-1",
			status: "running",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-run-set-1_delegate_tedi-echo",
			progress: {
				current: 48,
				label: "Running",
			},
			metadata: {
				childRunLatestEventKind: "run.started",
				childRunStatus: "running",
			},
		});
	});

	it("pages durable Home runs by offset newest-first with no overlap", async () => {
		const db = createKernelRuntimeDb();
		// Seed five runs, newest updatedAt last so DESC order is run-5..run-1.
		for (let i = 1; i <= 5; i += 1) {
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: `home-page-${i}`,
					organizationId: ORG_ID,
					conversationId: "home:paged",
					status: "completed",
					createdAt: `2026-06-06T08:0${i}:00.000Z`,
					updatedAt: `2026-06-06T08:0${i}:30.000Z`,
				}),
			);
		}
		const client = createKernelRuntimeClient(createContext(db));

		// No offset = head page, identical to today's behavior.
		const head = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
		});
		expect(head.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-5",
			"home-page-4",
		]);

		// offset:0 is equivalent to omitting offset.
		const headExplicit = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 0,
		});
		expect(headExplicit.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-5",
			"home-page-4",
		]);

		// Second page picks up exactly where the head left off — no overlap.
		const second = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 2,
		});
		expect(second.runSet.runs.map((run) => run.id)).toEqual([
			"home-page-3",
			"home-page-2",
		]);

		// Third (partial) page returns the tail with no duplicates.
		const third = await client.readRunSet({
			conversationId: "home:paged",
			limit: 2,
			offset: 4,
		});
		expect(third.runSet.runs.map((run) => run.id)).toEqual(["home-page-1"]);

		// Union of all pages covers every run exactly once.
		const seen = [
			...head.runSet.runs,
			...second.runSet.runs,
			...third.runSet.runs,
		].map((run) => run.id);
		expect(new Set(seen).size).toBe(seen.length);
		expect(new Set(seen)).toEqual(
			new Set([
				"home-page-1",
				"home-page-2",
				"home-page-3",
				"home-page-4",
				"home-page-5",
			]),
		);
	});

	it("reconciles terminal child status back onto the durable Home run row", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask Echo to finish",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-run-terminal-1",
		});
		const finalAnswer =
			"Echo checked the requested data and found no discrepancies.";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:59.000Z",
				id: "runtime-child-final-terminal",
				kind: "message.completed",
				messageId: "echo-terminal-final",
				payload: { role: "assistant", content: finalAnswer },
				runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:01:00.000Z",
				delta: null,
				id: "runtime-child-started-terminal",
				kind: "run.started",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "running" },
				runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-echo",
				toolCallId: null,
			},
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: "Echo terminal proof.",
				id: "runtime-child-completed-terminal",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed", content: "Echo terminal proof." },
				runId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-echo",
				toolCallId: null,
			},
		);

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});

		expect(result.runSet.activeRunIds).toEqual([]);
		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-run-terminal-1",
			status: "completed",
			completedAt: "2026-06-06T08:02:00.000Z",
			progress: {
				current: 100,
				label: "Complete",
			},
			metadata: {
				childRunLatestEventKind: "run.completed",
				childRunPreview: finalAnswer,
				childRunStatus: "completed",
			},
		});
		expect(db.runs[0]).toMatchObject({
			id: "home-run-terminal-1",
			status: "completed",
			completedAt: "2026-06-06T08:02:00.000Z",
			latestEventKind: "run.completed",
			latestEventAt: "2026-06-06T08:02:00.000Z",
			preview: finalAnswer,
			progressLabel: "Complete",
			progressValue: 100,
		});
		expect(db.submissionSettleCalls).toContainEqual({
			submissionId: "sub:home-run-terminal-1",
			outcome: "settled",
		});
		const completionMessages = db.events.filter(
			(event) =>
				event.messageId === "home-run-terminal-1:async-completion:assistant",
		);
		expect(completionMessages).toHaveLength(1);
		expect(completionMessages[0]).toMatchObject({
			kind: "message.completed",
			conversationId: "home:test",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
			payload: {
				role: "assistant",
				content: finalAnswer,
				metadata: {
					asyncCompletion: true,
					childRunStatus: "completed",
					childRunLatestEventKind: "run.completed",
					source: "kernelRuntime.delegationCompletion",
				},
			},
		});

		expect(completionMessages[0]?.payload?.metadata).not.toHaveProperty(
			"delegationProof",
		);

		await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		expect(
			db.events.filter(
				(event) =>
					event.messageId === "home-run-terminal-1:async-completion:assistant",
			),
		).toHaveLength(1);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		expect(
			messages.messages.find(
				(message) =>
					message.id === "home-run-terminal-1:async-completion:assistant",
			),
		).toMatchObject({
			id: "home-run-terminal-1:async-completion:assistant",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-run-terminal-1_delegate_tedi-echo",
			role: "assistant",
			content: finalAnswer,
			metadata: {
				metadata: {
					asyncCompletion: true,
					childRunStatus: "completed",
				},
			},
		});
	});

	it("skips live child-evidence queries for terminal runs (fan-out bound)", async () => {
		// 20 delegation runs all in terminal state with their async-completion
		// message already durable (steady state) — none should trigger a
		// tediRuntimeEvents select: the read-repair's deterministic-event-id
		// pre-check must gate the child-evidence read per row. Only kernel-side
		// selects are expected.
		const TERMINAL_COUNT = 20;
		const db = createKernelRuntimeDb();

		// Wrap db.select to count tediRuntimeEvents hits.
		let childEvidenceSelectCount = 0;
		const originalSelect = db.select.bind(db);
		db.select = (() => {
			const builder = originalSelect();
			const originalFrom = builder.from.bind(builder);
			builder.from = (table: unknown) => {
				if (table === tediRuntimeEvents) childEvidenceSelectCount += 1;
				return originalFrom(table);
			};
			return builder;
		}) as typeof db.select;

		// Seed terminal delegation runs directly (bypass enqueueMessage to keep
		// the run rows terminal from the start — simulating a heavy history).
		for (let i = 0; i < TERMINAL_COUNT; i += 1) {
			const runId = `terminal-run-${i}`;
			const childRunId = `tedi-echo:mcp:${runId}_delegate_tedi-echo`;
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: runId,
					organizationId: ORG_ID,
					conversationId: "home:heavy",
					status: "completed",
					delegatedTediId: "tedi-echo",
					childRunId,
					preview: `Result ${i}`,
					latestEventKind: "run.completed",
					latestEventAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					completedAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					updatedAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					// Persist childRunStatus so normalizeHomeRunRecord can fall back to row.
					metadata: {
						childRunStatus: "completed",
						childRunPreview: `Result ${i}`,
					},
				}),
			);
			// Add live child events — these should not be queried for terminal runs.
			db.runtimeEvents.push(
				childRuntimeEvent({
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
					id: `child-event-${i}`,
					kind: "run.completed",
					payload: { status: "completed", content: `Result ${i}` },
					runId: childRunId,
					tediId: "tedi-echo",
				}),
			);
			// The async-completion message is already durable (the terminal
			// reconcile wrote it when the run settled) — the deterministic event id
			// is what the read-repair existence gate checks.
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: [
						"home",
						ORG_ID,
						"event",
						"message.completed",
						"home:heavy",
						runId,
						"delegation-completion",
					].join(":"),
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:heavy",
					runId,
					messageId: `${runId}:async-completion:assistant`,
					delegatedTediId: "tedi-echo",
					childRunId,
					payload: { role: "assistant", content: `Result ${i}` },
					createdAt: `2026-06-06T08:${String(i).padStart(2, "0")}:00.000Z`,
				}),
			);
		}

		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunSet({
			conversationId: "home:heavy",
			limit: TERMINAL_COUNT,
		});

		// All runs returned, all terminal.
		expect(result.runSet.runs).toHaveLength(TERMINAL_COUNT);
		expect(result.runSet.activeRunIds).toEqual([]);
		// No live child-evidence queries were issued.
		expect(childEvidenceSelectCount).toBe(0);
		// Runs use persisted row data for child fields.
		for (const run of result.runSet.runs) {
			expect(run.status).toBe("completed");
			expect(run.metadata?.childRunStatus).toBe("completed");
		}
	});

	it("repairs a missing completion message with the child's real final answer", async () => {
		// Already-terminal row whose async-completion message is missing (a prior
		// fail-soft insert failure). The read repair must pay the real content
		// path: the child's final assistant message, not the rolling preview.
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const childRunId = "tedi-echo:mcp:home-repair-content-1_delegate_tedi-echo";
		const completedAt = "2026-06-24T09:10:00.000Z";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-repair-content-1",
				organizationId: ORG_ID,
				conversationId: "home:repair-content",
				status: "completed",
				inputMessageId: "home-repair-content-1:input",
				outputMessageId: "home-repair-content-1:async-completion:assistant",
				delegatedTediId: "tedi-echo",
				childRunId,
				childConversationId: "agent:main:main",
				latestEventKind: "run.completed",
				latestEventAt: completedAt,
				preview: "Rolling activity preview.",
				metadata: { delegatedTediId: "tedi-echo" },
				completedAt,
				createdAt: "2026-06-24T09:00:00.000Z",
				updatedAt: completedAt,
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "evt-repair-content-message",
				kind: "message.completed",
				runId: childRunId,
				tediId: "tedi-echo",
				createdAt: completedAt,
				payload: {
					role: "assistant",
					content: "Here is the full audit result: 3 findings, all fixed.",
				},
			}),
			childRuntimeEvent({
				id: "evt-repair-content-completed",
				kind: "run.completed",
				runId: childRunId,
				tediId: "tedi-echo",
				createdAt: completedAt,
				payload: { status: "completed" },
			}),
		);

		await client.readRunSet({
			conversationId: "home:repair-content",
			limit: 10,
		});

		const completionMessages = db.events.filter(
			(event) =>
				event.messageId === "home-repair-content-1:async-completion:assistant",
		);
		expect(completionMessages).toHaveLength(1);
		expect(completionMessages[0]?.payload).toMatchObject({
			role: "assistant",
			content: "Here is the full audit result: 3 findings, all fixed.",
		});

		// Idempotent: a second read finds the message via the deterministic-id
		// gate and neither duplicates it nor re-reads child evidence.
		let childEvidenceSelectCount = 0;
		const originalSelect = db.select.bind(db);
		db.select = (() => {
			const builder = originalSelect();
			const originalFrom = builder.from.bind(builder);
			builder.from = (table: unknown) => {
				if (table === tediRuntimeEvents) childEvidenceSelectCount += 1;
				return originalFrom(table);
			};
			return builder;
		}) as typeof db.select;
		await client.readRunSet({
			conversationId: "home:repair-content",
			limit: 10,
		});
		expect(
			db.events.filter(
				(event) =>
					event.messageId ===
					"home-repair-content-1:async-completion:assistant",
			),
		).toHaveLength(1);
		expect(childEvidenceSelectCount).toBe(0);
	});

	it("keeps the run set readable when a historical delegation Work Item is missing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const runId = "terminal-repair-failure";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: runId,
				organizationId: ORG_ID,
				conversationId: "home:repair-failure",
				status: "completed",
				delegatedTediId: "tedi-echo",
				childRunId: "tedi-echo:mcp:terminal-repair-failure",
				preview: "Completed child result",
				metadata: {
					childRunStatus: "completed",
					workItemId: "missing-work-item",
				},
				completedAt: "2026-06-24T10:00:00.000Z",
				createdAt: "2026-06-24T09:00:00.000Z",
				updatedAt: "2026-06-24T10:00:00.000Z",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:repair-failure",
			limit: 10,
		});

		expect(result.runSet.runs.map((run) => run.id)).toContain(runId);
	});

	it("repair falls back to the preview content when the child read keeps failing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const childRunId =
			"tedi-echo:mcp:home-repair-fallback-1_delegate_tedi-echo";
		const completedAt = "2026-06-24T10:10:00.000Z";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-repair-fallback-1",
				organizationId: ORG_ID,
				conversationId: "home:repair-fallback",
				status: "completed",
				inputMessageId: "home-repair-fallback-1:input",
				outputMessageId: "home-repair-fallback-1:async-completion:assistant",
				delegatedTediId: "tedi-echo",
				childRunId,
				childConversationId: "agent:main:main",
				latestEventKind: "run.completed",
				latestEventAt: completedAt,
				preview: "Child result preview.",
				metadata: { delegatedTediId: "tedi-echo" },
				completedAt,
				createdAt: "2026-06-24T10:00:00.000Z",
				updatedAt: completedAt,
			}),
		);
		// Child evidence reads fail persistently (transport flake beyond the
		// bounded in-request retries) — the repair must fall back to the
		// preview-based content instead of failing the reconcile.
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);

		const result = await client.readRunSet({
			conversationId: "home:repair-fallback",
			limit: 10,
		});

		expect(result.runSet.runs[0]).toMatchObject({
			id: "home-repair-fallback-1",
			status: "completed",
		});
		const completionMessages = db.events.filter(
			(event) =>
				event.messageId === "home-repair-fallback-1:async-completion:assistant",
		);
		expect(completionMessages).toHaveLength(1);
		expect(completionMessages[0]?.payload).toMatchObject({
			role: "assistant",
			content:
				"The delegated tedi finished the assignment. Latest evidence: Child result preview.",
		});
	});

	it("keeps concurrent delegated CPO and Echo runs separated in one Home conversation", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO for a launch checklist",
			delegateToTediId: "tedi-cpo",
			idempotencyKey: "home-multi-cpo",
		});
		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask Echo for a data check",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-multi-echo",
		});
		const cpoFinal =
			"Launch checklist: confirm ownership, schedule rollout, and monitor adoption.";
		const echoFinal =
			"Data check: all requested records match the source totals.";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:59.000Z",
				id: "runtime-multi-cpo-final",
				kind: "message.completed",
				messageId: "cpo-launch-final",
				payload: { role: "assistant", content: cpoFinal },
				runId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:59.000Z",
				id: "runtime-multi-echo-final",
				kind: "message.completed",
				messageId: "echo-data-final",
				payload: { role: "assistant", content: echoFinal },
				runId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-multi-cpo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "CPO launch checklist proof.",
				},
				runId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "runtime-multi-echo-completed",
				kind: "run.completed",
				payload: {
					status: "completed",
					content: "Echo data check proof.",
				},
				runId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
				tediId: "tedi-echo",
			}),
		);

		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const runsById = new Map(result.runSet.runs.map((run) => [run.id, run]));

		expect(result.runSet.activeRunIds).toEqual([]);
		expect(runsById.get("home-multi-cpo")).toMatchObject({
			status: "completed",
			delegatedTediId: "tedi-cpo",
			childRunId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
			metadata: {
				childRunPreview: cpoFinal,
			},
		});
		expect(runsById.get("home-multi-echo")).toMatchObject({
			status: "completed",
			delegatedTediId: "tedi-echo",
			childRunId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
			metadata: {
				childRunPreview: echoFinal,
			},
		});

		const completionMessages = db.events
			.filter((event) =>
				event.messageId?.includes(":async-completion:assistant"),
			)
			.map((event) => ({
				childRunId: event.childRunId,
				content: (event.payload as { content?: string } | null)?.content,
				delegatedTediId: event.delegatedTediId,
				messageId: event.messageId,
			}));

		expect(completionMessages).toHaveLength(2);
		expect(completionMessages).toEqual(
			expect.arrayContaining([
				{
					childRunId: "tedi-cpo:mcp:home-multi-cpo_delegate_tedi-cpo",
					content: cpoFinal,
					delegatedTediId: "tedi-cpo",
					messageId: "home-multi-cpo:async-completion:assistant",
				},
				{
					childRunId: "tedi-echo:mcp:home-multi-echo_delegate_tedi-echo",
					content: echoFinal,
					delegatedTediId: "tedi-echo",
					messageId: "home-multi-echo:async-completion:assistant",
				},
			]),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});
		const renderedCompletions = messages.messages
			.filter((message) => message.id.endsWith(":async-completion:assistant"))
			.map((message) => ({
				childRunId: message.childRunId,
				content: message.content,
				delegatedTediId: message.delegatedTediId,
				messageId: message.id,
			}));
		expect(renderedCompletions).toHaveLength(2);
		expect(renderedCompletions).toEqual(
			expect.arrayContaining(completionMessages),
		);
	});

	it("reads delegated child run evidence from the runtime owner ledger", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.runtimeEvents.push(
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				delta: null,
				id: "runtime-child-started",
				kind: "run.started",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "running" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: "artifact-1",
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:01:00.000Z",
				delta: null,
				id: "runtime-child-artifact",
				kind: "artifact.created",
				messageId: null,
				organizationId: ORG_ID,
				payload: { text: "Evidence bundle ready" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
			{
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: null,
				id: "runtime-child-completed",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed" },
				runId: "child-run-evidence",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			},
		);
		db.artifacts.push({
			accessClassification: "runtime_private",
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-1",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-evidence",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-parent-with-work-item",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-evidence",
				metadata: {
					workItemId: "wi-child-evidence",
				},
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-evidence",
			delegatedTediId: "tedi-cpo",
			workItemId: "wi-child-evidence",
			status: "completed",
			latestEventKind: "run.completed",
			terminalAt: "2026-06-06T08:02:00.000Z",
			terminalEventKind: "run.completed",
			control: {
				canStop: false,
				state: "terminal",
			},
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-child-completed",
			"runtime-child-artifact",
			"runtime-child-started",
		]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-1",
		]);
		expect(result.evidence.artifacts[0]?.uri).toBeUndefined();
		expect(result.evidence.artifacts[0]?.metadata).toBeUndefined();
	});

	it("does not expose child run evidence for a tedi outside the organization", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.tediRows.push({
			id: "tedi-outside",
			organizationId: "org-outside",
			runtimeKind: "agent",
		});

		await expect(
			client.readChildRunEvidence({
				childRunId: "outside-run",
				delegatedTediId: "tedi-outside",
			}),
		).rejects.toThrow("Delegated tedi not found");
	});

	it("returns workstation process log artifact rows as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.artifacts.push(
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:03:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:evidence",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "evidence",
					traceId: "trace-workstation-1",
				},
				mimeType: "application/json",
				name: "workstation_process/install-deps/evidence.json",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/evidence.json",
			},
			{
				conversationId: "cto:agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "child-run-workstation:artifact:workstation_process:install-deps:stdout",
				kind: "log",
				messageId: null,
				metadata: {
					source: "workstation_process",
					subKind: "workstation_process",
					processId: "install-deps",
					refType: "stdout",
					traceId: "trace-workstation-1",
				},
				mimeType: "text/plain; charset=utf-8",
				name: "workstation_process/install-deps/stdout.log",
				organizationId: ORG_ID,
				runId: "child-run-workstation",
				sizeBytes: null,
				tediId: "tedi-cto",
				uri: "r2://tedix-tedi-production/orgs/org-1/tedis/cto/workstations/general/processes/install-deps/terminal/stdout.log",
			},
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-workstation",
			delegatedTediId: "tedi-cto",
		});

		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"child-run-workstation:artifact:workstation_process:install-deps:evidence",
			"child-run-workstation:artifact:workstation_process:install-deps:stdout",
		]);
		expect(result.evidence.artifacts[0]).toMatchObject({
			kind: "log",
			name: "workstation_process/install-deps/evidence.json",
			metadata: {
				source: "workstation_process",
				processId: "install-deps",
				refType: "evidence",
			},
		});
	});

	it("keeps child run evidence readable when runtime event reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		db.artifacts.push({
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			id: "artifact-flaky-events",
			kind: "document",
			messageId: null,
			metadata: { source: "test" },
			mimeType: "text/markdown",
			name: "Evidence bundle",
			organizationId: ORG_ID,
			runId: "child-run-flaky-events",
			sizeBytes: 2048,
			tediId: "tedi-cpo",
			uri: "r2://tedix/evidence.md",
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-events",
			delegatedTediId: "tedi-cpo",
			status: "queued",
			latestEventAt: null,
		});
		expect(result.evidence.events).toEqual([]);
		expect(result.evidence.artifacts.map((artifact) => artifact.id)).toEqual([
			"artifact-flaky-events",
		]);
	});

	it("keeps child run evidence readable when artifact reads flake", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.artifactSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		// Genuine completion: include message.completed so the disposition gate
		// reports completed even when artifact reads flake.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "runtime-flaky-artifacts-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "Artifact run complete." },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				id: "runtime-flaky-artifacts-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: "child-run-flaky-artifacts",
				tediId: "tedi-cpo",
			}),
		);

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence).toMatchObject({
			childRunId: "child-run-flaky-artifacts",
			delegatedTediId: "tedi-cpo",
			status: "completed",
			latestEventKind: "run.completed",
		});
		expect(result.evidence.events.map((event) => event.id)).toEqual([
			"runtime-flaky-artifacts-completed",
			"runtime-flaky-artifacts-message",
		]);
		expect(result.evidence.artifacts).toEqual([]);
	});

	it("surfaces workstation.egress.deny events stored under kernel run id as child run evidence", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// The kernel delegation row: id is the kernel run id; childRunId is the
		// tedi-runtime run id. Egress events carry runId = kernelRunId (id), not
		// childRunId — that is the gap this fix addresses.
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "kernel-run-egress",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-egress",
			}),
		);
		// Egress event recorded by tedi-workstation-runtime with runId = kernel run id.
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:01:00.000Z",
			delta: null,
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			messageId: null,
			organizationId: ORG_ID,
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				method: "GET",
				protocol: "https",
				reason: "not_in_allowlist",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
				adapter: "cloudflare-sandbox-workstation",
				leaseId: null,
				profileId: null,
				traceBundleId: null,
				traceId: null,
				workItemId: null,
				containerId: "ws-1",
				className: "WorkstationDO",
				loggingMode: "all",
			},
			runId: "kernel-run-egress",
			runtimeBackend: "custom",
			runtimeExternalId: "ws-1",
			runtimeExternalUrl: null,
			runtimeMetadata: {
				adapter: "cloudflare-sandbox-workstation",
				kernelRunId: "kernel-run-egress",
				workstationId: "ws-1",
			},
			sequence: null,
			tediId: "tedi-cpo",
			toolCallId: null,
		});

		const result = await client.readChildRunEvidence({
			childRunId: "child-run-egress",
			delegatedTediId: "tedi-cpo",
		});

		expect(result.evidence.events.map((event) => event.id)).toContain(
			"egress-deny-1",
		);
		const egressEvent = result.evidence.events.find(
			(event) => event.id === "egress-deny-1",
		);
		expect(egressEvent).toMatchObject({
			id: "egress-deny-1",
			kind: "workstation.egress.deny",
			payload: {
				decision: "deny",
				host: "blocked.example.com",
				reason: "not_in_allowlist",
			},
		});
	});

	it("keeps Home messages readable when child runtime status enrichment fails", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.childRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "assistant-delegated",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "assistant-delegated",
				runId: "home-run",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-run-flaky",
				payload: {
					content: "I delegated this Home turn.",
					metadata: {
						childRunId: "child-run-flaky",
						delegatedTediId: "tedi-cpo",
					},
					role: "assistant",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]).toMatchObject({
			content: "I delegated this Home turn.",
			role: "assistant",
			status: "completed",
		});
		const flakyMessageMetadata = messages.messages[0]?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(flakyMessageMetadata).toMatchObject({
			childRunId: "child-run-flaky",
			delegatedTediId: "tedi-cpo",
		});
		expect(flakyMessageMetadata?.childRunStatus).toBeUndefined();
	});

	// The parent cancellation and child execution are independent facts. Cached
	// child activity must not revive the Home outcome or its message progress.
	it.each([undefined, "running"] as const)(
		"keeps a canceled Home turn canceled when its child finishes late (cached %s)",
		async (cachedChildStatus) => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const canceledPreview =
				"Home run canceled by operator: Stopped from Home composer";
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id: "home-run-canceled-late-child",
					organizationId: ORG_ID,
					conversationId: "home:test",
					status: "canceled",
					metadata: {
						childRunStatus: cachedChildStatus,
						childRunPreview: "child still working",
						childRunLatestEventAt: "2026-06-06T08:00:30.000Z",
					},
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					childConversationId: "agent:main:main",
					preview: canceledPreview,
					createdAt: "2026-06-06T08:00:00.000Z",
					completedAt: "2026-06-06T08:01:00.000Z",
					updatedAt: "2026-06-06T08:01:00.000Z",
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "assistant-ack-late-child",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:test",
					messageId: "assistant-ack-late-child",
					runId: "home-run-canceled-late-child",
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					payload: {
						content: "On it — delegating to CPO now.",
						metadata: {
							childRunId: "child-run-late",
							delegatedTediId: "tedi-cpo",
						},
						role: "assistant",
					},
					createdAt: "2026-06-06T08:00:30.000Z",
				}),
				normalizeKernelRuntimeEventInsert({
					id: "assistant-completion-late-child",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:test",
					messageId: "home-run-canceled-late-child:async-completion:assistant",
					runId: "home-run-canceled-late-child",
					delegatedTediId: "tedi-cpo",
					childRunId: "child-run-late",
					payload: {
						content: `The delegated tedi assignment was canceled. Latest evidence: ${canceledPreview}`,
						metadata: {
							asyncCompletion: true,
							childRunId: "child-run-late",
							delegatedTediId: "tedi-cpo",
						},
						role: "assistant",
					},
					createdAt: "2026-06-06T08:01:00.000Z",
				}),
			);
			// The child kept running past the parent cancel and published its own
			// terminal `run.completed` afterwards.
			db.runtimeEvents.push({
				artifactId: null,
				approvalRequestId: null,
				conversationId: "agent:main:main",
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: "Awaiting your request.",
				id: "runtime-child-completed-late",
				kind: "run.completed",
				messageId: null,
				organizationId: ORG_ID,
				payload: { status: "completed", content: "Awaiting your request." },
				runId: "child-run-late",
				runtimeBackend: "cloudflare-agents",
				runtimeExternalId: null,
				runtimeExternalUrl: null,
				runtimeMetadata: null,
				sequence: null,
				tediId: "tedi-cpo",
				toolCallId: null,
			});

			const messages = await client.readMessages({
				conversationId: "home:test",
				limit: 10,
			});

			const ack = messages.messages.find(
				(message) => message.id === "assistant-ack-late-child",
			);
			const ackMetadata = ack?.metadata?.metadata as
				| Record<string, unknown>
				| undefined;
			expect(ackMetadata?.childRunStatus).toBe(cachedChildStatus ?? "canceled");
			expect(ackMetadata?.delegationStatus).toBe("canceled");
			expect(ackMetadata?.childRunPreview).toBe(canceledPreview);
			expect(ackMetadata?.progress).toMatchObject({
				current: 100,
				label: "Stopped",
			});
			expect(ack?.status).toBe("completed");

			// The completion prose and delegation outcome agree on cancellation.
			const completion = messages.messages.find(
				(message) =>
					message.id ===
					"home-run-canceled-late-child:async-completion:assistant",
			);
			expect(completion?.content).toContain(
				"The delegated tedi assignment was canceled.",
			);
			const completionMetadata = completion?.metadata?.metadata as
				| Record<string, unknown>
				| undefined;
			expect(completionMetadata?.childRunStatus).toBe(
				cachedChildStatus ?? "canceled",
			);
			expect(completionMetadata?.delegationStatus).toBe("canceled");
			expect(completionMetadata?.progress).toMatchObject({
				current: 100,
				label: "Stopped",
			});
			const reread = await client.readMessages({
				conversationId: "home:test",
				limit: 10,
			});
			expect(reread.messages).toEqual(messages.messages);
		},
	);

	it("skips a contradictory completed child when reading a terminal Home parent directly", async () => {
		const db = createKernelRuntimeDb();
		const parent = normalizeKernelRuntimeRunInsert({
			id: "home-run-direct-terminal-guard",
			organizationId: ORG_ID,
			conversationId: "home:test",
			status: "canceled",
			delegatedTediId: "tedi-cpo",
			childRunId: "child-direct-terminal-guard",
			createdAt: "2026-06-06T08:00:00.000Z",
			completedAt: "2026-06-06T08:01:00.000Z",
			updatedAt: "2026-06-06T08:01:00.000Z",
		});
		const message = normalizeKernelRuntimeEventInsert({
			id: "direct-terminal-guard-message",
			organizationId: ORG_ID,
			kind: "message.completed",
			conversationId: "home:test",
			runId: parent.id,
			delegatedTediId: "tedi-cpo",
			childRunId: "child-direct-terminal-guard",
			createdAt: "2026-06-06T08:00:30.000Z",
		});
		db.runtimeEvents.push({
			artifactId: null,
			approvalRequestId: null,
			conversationId: "agent:main:main",
			createdAt: "2026-06-06T08:02:00.000Z",
			delta: "Child finished after parent cancellation",
			id: "direct-terminal-guard-child-completed",
			kind: "run.completed",
			messageId: null,
			organizationId: ORG_ID,
			payload: {
				status: "completed",
				content: "Child finished after parent cancellation",
			},
			runId: "child-direct-terminal-guard",
			runtimeBackend: "cloudflare-agents",
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			sequence: null,
			tediId: "tedi-cpo",
			toolCallId: null,
		});

		const context = createContext(db);
		const canceledRun = normalizeHomeRunRecord(parent);
		const canceledStatuses = await readChildRunStatuses(
			context,
			[message],
			new Map([[parent.id, canceledRun]]),
		);
		expect(canceledStatuses.size).toBe(0);

		const runningRun = normalizeHomeRunRecord({
			...parent,
			status: "running",
			completedAt: null,
		});
		const runningStatuses = await readChildRunStatuses(
			context,
			[message],
			new Map([[parent.id, runningRun]]),
		);
		expect(
			runningStatuses.get("tedi-cpo:child-direct-terminal-guard"),
		).toMatchObject({
			childRunStatus: "completed",
		});
	});

	// One delegation = one row. The delegation lifecycle used to emit up to four
	// full-height assistant turns per delegation, each restating what the 40px
	// receipt row beside them already renders (target, humanized status, clamped
	// preview). The ledger keeps every row; the rendered transcript keeps one.
	it("collapses delegation lifecycle narration to the single receipt row", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-collapse",
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "canceled",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				childConversationId: "agent:main:main",
				preview: "Home run canceled by operator",
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:01:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "collapse-ack",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-collapse:assistant",
				runId: "home-run-collapse",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				payload: {
					role: "assistant",
					content:
						"On it — delegating to CPO now. I'll bring CPO's result back here when it's done.",
					metadata: {
						childRunId: "child-collapse",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_ack",
					},
				},
				createdAt: "2026-06-06T08:00:30.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "collapse-completion",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-collapse:async-completion:assistant",
				runId: "home-run-collapse",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-collapse",
				payload: {
					role: "assistant",
					content:
						"The delegated tedi assignment was canceled. Latest evidence: Home run canceled by operator",
					metadata: {
						asyncCompletion: true,
						childRunId: "child-collapse",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_status_only",
					},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		// The terminal restatement is gone from the rendered transcript — the ack
		// row ahead of it already owns the receipt for this child run.
		expect(
			messages.messages.some(
				(message) =>
					message.id === "home-run-collapse:async-completion:assistant",
			),
		).toBe(false);
		// The ack row survives (it is the only carrier of the delegation metadata
		// Tedix OS builds the receipt from) but renders no prose.
		const ack = messages.messages.find(
			(message) => message.id === "home-run-collapse:assistant",
		);
		expect(ack).toBeDefined();
		expect(ack?.content).toBe("");
		const ackMetadata = ack?.metadata?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(ackMetadata?.delegatedTediId).toBe("tedi-cpo");
		expect(ackMetadata?.childRunId).toBe("child-collapse");
	});

	it("keeps a delegation completion that relays a real child answer", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "relay-ack",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-relay:assistant",
				runId: "home-run-relay",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-relay",
				payload: {
					role: "assistant",
					content: "On it — delegating to CPO now.",
					metadata: {
						childRunId: "child-relay",
						delegatedTediId: "tedi-cpo",
						homeNarration: "delegation_ack",
					},
				},
				createdAt: "2026-06-06T08:00:30.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "relay-completion",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "home-run-relay:async-completion:assistant",
				runId: "home-run-relay",
				delegatedTediId: "tedi-cpo",
				childRunId: "child-relay",
				// Unstamped: the child returned a final assistant message, so this
				// turn carries the delegation's actual return value.
				payload: {
					role: "assistant",
					content:
						"Outcome: succeeded\n\nThe migration shipped as repo_commit …",
					metadata: {
						asyncCompletion: true,
						childRunId: "child-relay",
						delegatedTediId: "tedi-cpo",
					},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		const completion = messages.messages.find(
			(message) => message.id === "home-run-relay:async-completion:assistant",
		);
		expect(completion?.content).toContain("Outcome: succeeded");
	});

	it("hides kernel-internal inbox-wake prompts from the Home transcript", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "wake-input",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "wake-run:input",
				runId: "wake-run",
				payload: {
					role: "user",
					content:
						"[System: 1 delegated task completed — summarize the results for the operator in this thread]",
					channel: "home",
					metadata: {
						dispatchMode: "kernel-inbox-wake",
						kernelInboxRunIds: ["child-1"],
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "operator-input",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "op-run:input",
				runId: "op-run",
				payload: {
					role: "user",
					content: "what workflows do we have?",
					channel: "home",
					metadata: {},
				},
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		// The synthetic wake prompt is kernel machinery — an operator-visible
		// user message that may never get a reply reads as a hang. Only the real
		// operator turn surfaces.
		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]).toMatchObject({
			content: "what workflows do we have?",
			role: "user",
		});
	});

	it("keeps Home reads usable when the shared D1 history query flakes", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.controls.kernelRuntimeSelectError = new Error(
			"D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.",
		);

		const conversations = await client.listConversations({ limit: 10 });
		const messages = await client.readMessages({
			conversationId: "home:test",
			limit: 10,
		});

		expect(conversations).toEqual({ conversations: [], nextCursor: null });
		expect(messages).toEqual({ messages: [], nextCursor: null });
	});

	it("paginates Home messages by message rows when run events are interleaved", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "run-newer",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:test",
				runId: "run-newer",
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-newer",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "message-newer",
				runId: "run-message-newer",
				payload: { role: "assistant", content: "newer message" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "run-middle",
				organizationId: ORG_ID,
				kind: "run.completed",
				conversationId: "home:test",
				runId: "run-middle",
				createdAt: "2026-06-06T08:03:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-older",
				organizationId: ORG_ID,
				kind: "message.received",
				conversationId: "home:test",
				messageId: "message-older",
				runId: "run-message-older",
				payload: { role: "user", content: "older message" },
				createdAt: "2026-06-06T08:02:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "message-oldest",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:test",
				messageId: "message-oldest",
				runId: "run-message-oldest",
				payload: { role: "assistant", content: "oldest message" },
				createdAt: "2026-06-06T08:01:00.000Z",
			}),
		);

		const page = await client.readMessages({
			conversationId: "home:test",
			limit: 2,
		});

		expect(page.messages.map((message) => message.id)).toEqual([
			"message-older",
			"message-newer",
		]);
		expect(page.nextCursor).toBe("2026-06-06T08:02:00.000Z");
	});

	it("serves Home conversations from the durable index once backfilled", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// Sentinel present ⇒ the projection is authoritative. No kernel events
		// are seeded at all: an old conversation aged out of any event window
		// still lists, which is the whole point of the index.
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:new`,
				organizationId: ORG_ID,
				conversationId: "home:new",
				title: "Quarterly numbers",
				titleSource: "rename",
				channel: "home",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
				messageCount: 4,
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T09:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:old`,
				organizationId: ORG_ID,
				conversationId: "home:old",
				lastMessageAt: "2026-01-01T00:00:00.000Z",
				messageCount: 2,
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10 });

		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:new",
			"home:old",
		]);
		expect(page.conversations[0]).toMatchObject({
			title: "Quarterly numbers",
			messageCount: 4,
			lastMessageAt: "2026-06-06T09:00:00.000Z",
			metadata: { titleSource: "rename" },
		});
		// Untitled index rows fall back to id-as-title — the Tedix OS's no-title signal.
		expect(page.conversations[1]?.title).toBe("home:old");
		expect(page.nextCursor).toBeNull();
	});

	it("paginates the durable index with a stable keyset cursor", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:c`,
				organizationId: ORG_ID,
				conversationId: "home:c",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
			}),
			// home:a and home:b share last_message_at — the conversation_id DESC
			// tiebreak makes the page split deterministic.
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:b`,
				organizationId: ORG_ID,
				conversationId: "home:b",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:a`,
				organizationId: ORG_ID,
				conversationId: "home:a",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const firstPage = await client.listConversations({ limit: 2 });
		expect(
			firstPage.conversations.map((conversation) => conversation.id),
		).toEqual(["home:c", "home:b"]);
		expect(firstPage.nextCursor).toBe("2026-06-06T08:00:00.000Z|home:b");

		const secondPage = await client.listConversations({
			limit: 2,
			cursor: firstPage.nextCursor ?? undefined,
		});
		expect(
			secondPage.conversations.map((conversation) => conversation.id),
		).toEqual(["home:a"]);
		expect(secondPage.nextCursor).toBeNull();
	});

	it("filters the durable index by search without breaking the read", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:alpha`,
				organizationId: ORG_ID,
				conversationId: "home:alpha",
				title: "Alpha rollout",
				titleSource: "autoTitle",
				lastMessageAt: "2026-06-06T09:00:00.000Z",
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:beta`,
				organizationId: ORG_ID,
				conversationId: "home:beta",
				title: "Beta budget",
				titleSource: "autoTitle",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10, search: "alpha" });

		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:alpha",
		]);
		expect(page.conversations[0]?.metadata?.titleSource).toBe("autoTitle");
	});

	it("enqueueMessage synchronously stamps a provisional title on the first message of a new conversation", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));
		try {
			await client.enqueueMessage({
				conversationId: "home:fresh-topic",
				content: "Audit the Q3 globex invoices! Then report back.",
				delegateToTediId: "tedi-echo",
				idempotencyKey: "home-provisional-title-1",
			});
		} finally {
			kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		}

		// The projection row exists before any settle/auto-title work: a sidebar
		// reload in the first seconds must not show "New chat".
		const row = db.conversationIndexRows.find(
			(candidate) => candidate.conversationId === "home:fresh-topic",
		);
		expect(row).toMatchObject({
			title: "Audit the Q3 globex invoices",
			titleSource: "provisional",
		});
		// Projection-only: no conversation.updated event was written, so the
		// post-settle auto-title guard (count of those events) stays unblocked.
		expect(
			db.events.filter((event) => event.kind === "conversation.updated"),
		).toHaveLength(0);
	});

	/**
	 * End-to-end origin stamp: request principal → `message.received` payload →
	 * projection column → `listConversations` output. The two directions are
	 * tested together because the failure that matters is not "agent traffic is
	 * unlabelled", it is "the operator's own chat got labelled agent".
	 */
	it("enqueueMessage stamps the conversation with the calling principal's origin", async () => {
		const machineDb = createKernelRuntimeDb();
		// The default test context authenticates as an API key — the shape an MCP
		// probe or smoke test arrives in.
		const machineClient = createKernelRuntimeClient(createContext(machineDb));
		await machineClient.enqueueMessage({
			conversationId: "home:probe",
			content: "Count Tedis via MCP",
			idempotencyKey: "home-origin-agent-1",
		});
		expect(
			machineDb.events.find(
				(event) =>
					event.kind === "message.received" &&
					event.conversationId === "home:probe",
			)?.payload,
		).toMatchObject({ origin: "agent" });
		expect(
			machineDb.conversationIndexRows.find(
				(row) => row.conversationId === "home:probe",
			),
		).toMatchObject({ origin: "agent" });

		const operatorDb = createKernelRuntimeDb();
		const operatorContext = {
			...createContext(operatorDb),
			apiKey: undefined,
			authType: "user" as const,
			user: { sub: "operator-1" } as BaseContext["user"],
			userRole: "owner",
		};
		const operatorClient = createKernelRuntimeClient(operatorContext);
		await operatorClient.enqueueMessage({
			conversationId: "home:operator",
			content: "What changed in billing yesterday?",
			idempotencyKey: "home-origin-human-1",
		});
		expect(
			operatorDb.conversationIndexRows.find(
				(row) => row.conversationId === "home:operator",
			),
		).toMatchObject({ origin: "human" });
	});

	/**
	 * Nothing was backfilled, so the projection is full of null-origin rows.
	 * The read path must resolve them to `human` rather than leaking the null
	 * to clients, or every consumer re-derives the default and one of them gets
	 * it backwards.
	 */
	it("listConversations reports an unstamped projection row as human", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			// A pre-stamp row: real history, `origin` never written.
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:legacy`,
				organizationId: ORG_ID,
				conversationId: "home:legacy",
				lastMessageAt: "2026-06-06T08:00:00.000Z",
				messageCount: 6,
			}),
		);
		const page = await client.listConversations({ limit: 10 });
		const legacy = page.conversations.find(
			(conversation) => conversation.id === "home:legacy",
		);
		expect(legacy?.origin).toBe("human");
	});

	it("deleteConversation purges the runtime ledger and leaves a hidden tombstone", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:keep`,
				organizationId: ORG_ID,
				conversationId: "home:keep",
				lastMessageAt: "2026-06-06T08:05:00.000Z",
				messageCount: 1,
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:delete-me`,
				organizationId: ORG_ID,
				conversationId: "home:delete-me",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "keep-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:keep",
				messageId: "keep-msg",
				payload: { role: "assistant", content: "keep me" },
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "delete-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:delete-me",
				messageId: "delete-msg",
				payload: { role: "assistant", content: "delete me" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		const before = await client.listConversations({ limit: 10 });
		expect(before.conversations.map((conversation) => conversation.id)).toEqual(
			["home:keep", "home:delete-me"],
		);

		const result = await client.deleteConversation({
			conversationId: "home:delete-me",
		});
		expect(result.ok).toBe(true);
		expect(result.conversationId).toBe("home:delete-me");
		expect(typeof result.deletedAt).toBe("string");
		expect(result).toMatchObject({ hardDeleted: true, canceledRunCount: 0 });
		expect(db.events.some((event) => event.id === "delete-msg")).toBe(false);
		expect(db.conversationIndexRows).toContainEqual(
			expect.objectContaining({
				conversationId: "home:delete-me",
				title: null,
				messageCount: 0,
				deletedAt: result.deletedAt,
			}),
		);

		const after = await client.listConversations({ limit: 10 });
		expect(after.conversations.map((conversation) => conversation.id)).toEqual([
			"home:keep",
		]);
	});

	it("deleteConversation is idempotent — a second call keeps the conversation hidden without throwing", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:double-delete`,
				organizationId: ORG_ID,
				conversationId: "home:double-delete",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "double-delete-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:double-delete",
				messageId: "double-delete-msg",
				payload: { role: "assistant", content: "hi" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		await client.deleteConversation({ conversationId: "home:double-delete" });
		await expect(
			client.deleteConversation({ conversationId: "home:double-delete" }),
		).resolves.toMatchObject({ ok: true });

		const page = await client.listConversations({ limit: 10 });
		expect(page.conversations.map((conversation) => conversation.id)).toEqual(
			[],
		);
	});

	it("deleteConversation cancels active parent and delegated child runs before purging them", async () => {
		const db = createKernelRuntimeDb();
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:active-delete`,
				organizationId: ORG_ID,
				conversationId: "home:active-delete",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-active-delete-run",
				organizationId: ORG_ID,
				conversationId: "home:active-delete",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-active-delete-run",
				childConversationId: "child-active-delete-conversation",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		const canceler = vi.fn(async () => true);
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(canceler);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.deleteConversation({
			conversationId: "home:active-delete",
		});

		expect(result).toMatchObject({ hardDeleted: true, canceledRunCount: 1 });
		expect(stopper).toHaveBeenCalledWith(
			expect.objectContaining({ childRunId: "child-active-delete-run" }),
		);
		expect(canceler).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "home-active-delete-run" }),
		);
		expect(db.submissionAbortStamps.map((stamp) => stamp.submissionId)).toEqual(
			["sub:home-active-delete-run", "sub:child-active-delete-run"],
		);
		expect(db.runs).toEqual([]);
		expect(db.events).toEqual([]);
	});

	it("deleteConversation refuses to delete the org's main Home thread", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.deleteConversation({ conversationId: "home:main" }),
		).rejects.toThrow(/main Home thread/);
	});

	it("pinConversation writes through pinnedAt to the canonical projection; unpin clears it", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-06-06T08:05:00.000Z"));
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			db.conversationIndexRows.push(
				normalizeKernelConversationInsert({
					id: `${ORG_ID}:home:pin-me`,
					organizationId: ORG_ID,
					conversationId: "home:pin-me",
					lastMessageAt: "2026-06-06T08:04:00.000Z",
					messageCount: 1,
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "pin-msg",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:pin-me",
					messageId: "pin-msg",
					payload: { role: "assistant", content: "pin me" },
					createdAt: "2026-06-06T08:04:00.000Z",
				}),
			);

			const pin = await client.pinConversation({
				conversationId: "home:pin-me",
				pinned: true,
			});
			expect(pin.conversation.pinnedAt).toEqual(expect.any(String));

			const pinEvent = db.events.find(
				(event) =>
					event.conversationId === "home:pin-me" &&
					event.kind === "conversation.updated",
			);
			expect(pinEvent?.payload).toMatchObject({
				conversation: { pinned: true },
				pinned: true,
				source: "kernelRuntime.pinConversation",
			});

			const pinned = await client.listConversations({ limit: 10 });
			const pinnedRow = pinned.conversations.find(
				(conversation) => conversation.id === "home:pin-me",
			);
			expect(pinnedRow?.pinnedAt).toEqual(expect.any(String));

			// Unpin (a later action) clears the overlay back to null — not sticky,
			// unlike delete.
			vi.setSystemTime(new Date("2026-06-06T08:06:00.000Z"));
			await client.pinConversation({
				conversationId: "home:pin-me",
				pinned: false,
			});
			const unpinned = await client.listConversations({ limit: 10 });
			const unpinnedRow = unpinned.conversations.find(
				(conversation) => conversation.id === "home:pin-me",
			);
			expect(unpinnedRow).toBeDefined();
			expect(unpinnedRow?.pinnedAt ?? null).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("archiveConversation hides a thread by default and restore keeps its ledger", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-06-06T08:05:00.000Z"));
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			db.conversationIndexRows.push(
				normalizeKernelConversationInsert({
					id: `${ORG_ID}:home:archive-me`,
					organizationId: ORG_ID,
					conversationId: "home:archive-me",
					lastMessageAt: "2026-06-06T08:04:00.000Z",
					messageCount: 1,
				}),
			);
			db.events.push(
				normalizeKernelRuntimeEventInsert({
					id: "archive-msg",
					organizationId: ORG_ID,
					kind: "message.completed",
					conversationId: "home:archive-me",
					messageId: "archive-msg",
					payload: { role: "assistant", content: "keep this ledger" },
					createdAt: "2026-06-06T08:04:00.000Z",
				}),
			);

			const archived = await client.archiveConversation({
				conversationId: "home:archive-me",
				archived: true,
			});
			expect(archived.conversation.status).toBe("archived");
			expect(
				(await client.listConversations({ limit: 10 })).conversations,
			).toEqual([]);
			expect(
				(
					await client.listConversations({
						limit: 10,
						includeArchived: true,
					})
				).conversations[0],
			).toMatchObject({ id: "home:archive-me", status: "archived" });
			expect(db.events.some((event) => event.id === "archive-msg")).toBe(true);

			vi.setSystemTime(new Date("2026-06-06T08:06:00.000Z"));
			const restored = await client.archiveConversation({
				conversationId: "home:archive-me",
				archived: false,
			});
			expect(restored.conversation.status).toBe("active");
			expect(
				(await client.listConversations({ limit: 10 })).conversations[0],
			).toMatchObject({ id: "home:archive-me", status: "active" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("listConversations hides ephemeral CI-smoke conversations", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:real-chat`,
				organizationId: ORG_ID,
				conversationId: "home:real-chat",
				lastMessageAt: "2026-06-06T08:05:00.000Z",
				messageCount: 1,
			}),
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:mcp-tasks-live-smoke-1783486327344`,
				organizationId: ORG_ID,
				conversationId: "home:mcp-tasks-live-smoke-1783486327344",
				lastMessageAt: "2026-06-06T08:04:00.000Z",
				messageCount: 1,
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "real-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:real-chat",
				messageId: "real-msg",
				payload: { role: "assistant", content: "keep" },
				createdAt: "2026-06-06T08:05:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "smoke-msg",
				organizationId: ORG_ID,
				kind: "message.completed",
				conversationId: "home:mcp-tasks-live-smoke-1783486327344",
				messageId: "smoke-msg",
				payload: { role: "assistant", content: "noise" },
				createdAt: "2026-06-06T08:04:00.000Z",
			}),
		);

		const page = await client.listConversations({ limit: 10 });
		expect(page.conversations.map((conversation) => conversation.id)).toEqual([
			"home:real-chat",
		]);
	});

	it("deleteConversation requires edit grants once a conversation opts into scoped access", async () => {
		const db = createKernelRuntimeDb({
			grantRows: [
				grantRow({
					access: "read",
					conversationId: "home:locked-delete",
					userId: "operator-1",
				}),
			],
		});
		const reader = createKernelRuntimeClient(
			createContext(db, { userSub: "operator-1" }),
		);
		await expect(
			reader.deleteConversation({ conversationId: "home:locked-delete" }),
		).rejects.toThrow(/Access denied/);

		db.grantRows[0].access = "edit";
		await expect(
			reader.deleteConversation({ conversationId: "home:locked-delete" }),
		).resolves.toMatchObject({ ok: true });
	});

	it("fails closed on conversation reads and writes before the shared D1 table is migrated", async () => {
		const client = createKernelRuntimeClient(
			createContext(
				createMissingKernelRuntimeTableDb() as ReturnType<
					typeof createKernelRuntimeDb
				>,
			),
		);

		await expect(client.listConversations({ limit: 10 })).rejects.toThrow(
			/no such table: kernel_conversations/,
		);
		await expect(
			client.readMessages({
				conversationId: "home:main",
				limit: 10,
			}),
		).rejects.toThrow(/Access denied/);
		await expect(
			client.enqueueMessage({
				conversationId: "home:main",
				content: "This must not bypass the unreadable ACL",
				idempotencyKey: "home-missing-table-1",
			}),
		).rejects.toThrow(/Access denied/);
	});

	it("#3 steerRun forwards the instruction to a live delegated child and records the outcome", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-1",
				childConversationId: "agent:main:main",
				metadata: {
					childRunStatus: "running",
					workItemId: "delegation-work-1",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
			childInjectRunId: "child-steer-inject-1",
		}));
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(forwarder);
		const client = createKernelRuntimeClient(createContext(db));

		const steered = await client.steerRun({
			runId: "home-steer-child-1",
			instruction: "Prioritise the Acme migration evidence.",
		});

		expect(steered.run.status).toBe("running");
		expect(forwarder).toHaveBeenCalledTimes(1);
		expect(forwarder.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId: "child-steer-1",
			childConversationId: "agent:main:main",
			workItemId: "delegation-work-1",
			instruction: "Prioritise the Acme migration evidence.",
			homeRunId: "home-steer-child-1",
		});
		expect(steered.run.metadata).toMatchObject({
			delegatedChildSteer: {
				attempted: true,
				outcome: "succeeded",
				childRunId: "child-steer-1",
				delegatedTediId: "tedi-cto",
				childInjectRunId: "child-steer-inject-1",
			},
		});
		// The run.steered runtime event carries the real forwarding outcome.
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-child-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: true,
			delegatedChildSteerOutcome: "succeeded",
			delegatedChildSteerRunId: "child-steer-inject-1",
		});
		// Audit records the forwarding outcome too.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.steered",
				resourceId: "home-steer-child-1",
				metadata: expect.objectContaining({
					delegatedChildSteerAttempted: true,
					delegatedChildSteerOutcome: "succeeded",
				}),
			}),
		);
	});

	it("#3 readRun surfaces the forwarded steering child result alongside the primary child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-result-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child-result",
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-result-primary-1",
				childConversationId: "agent:main:main",
				progressValue: 100,
				progressLabel: "Complete",
				progressDetail: "2 runtime events recorded",
				latestEventKind: "run.completed",
				latestEventAt: "2026-06-06T08:03:00.000Z",
				preview: "Primary child result without steering context.",
				metadata: {
					delegatedChildSteer: {
						attempted: true,
						outcome: "succeeded",
						childRunId: "child-steer-result-primary-1",
						delegatedTediId: "tedi-cto",
						childInjectRunId: "child-steer-result-inject-1",
						error: null,
						steeredAt: "2026-06-06T08:01:30.000Z",
					},
					latestSteeringInstruction: "Focus on Work Item evidence.",
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:03:00.000Z",
				updatedAt: "2026-06-06T08:03:00.000Z",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-steer-result-inject-message",
				kind: "message.completed",
				runId: "child-steer-result-inject-1",
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:10.000Z",
				payload: {
					role: "assistant",
					content: "Steering-aware result with Work Item evidence.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-steer-result-inject-completed",
				kind: "run.completed",
				runId: "child-steer-result-inject-1",
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:10.000Z",
				payload: { status: "completed" },
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const read = await client.readRun({ runId: "home-steer-child-result-1" });

		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			childRunId: "child-steer-result-primary-1",
			childRunPreview: "Primary child result without steering context.",
			childRunStatus: "completed",
			delegatedChildSteerResult: {
				childRunId: "child-steer-result-inject-1",
				status: "completed",
				latestEventKind: "message.completed",
				latestEventAt: "2026-06-06T08:03:10.000Z",
				terminalAt: "2026-06-06T08:03:10.000Z",
				preview: "Steering-aware result with Work Item evidence.",
			},
		});
	});

	it("#3 steerRun records a failed child forward but never blocks the parent steer", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-child-fail-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-child-fail",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-steer-fail-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn(async () => ({
			attempted: true,
			outcome: "failed" as const,
			error: "child runtime unreachable",
		}));
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(forwarder);
		const client = createKernelRuntimeClient(createContext(db));

		const steered = await client.steerRun({
			runId: "home-steer-child-fail-1",
			instruction: "Switch to the fallback plan.",
		});

		// Parent steer succeeds regardless of the child-side failure.
		expect(steered.run.status).toBe("running");
		expect(steered.run.metadata).toMatchObject({
			latestSteeringInstruction: "Switch to the fallback plan.",
			delegatedChildSteer: {
				attempted: true,
				outcome: "failed",
				error: "child runtime unreachable",
			},
		});
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-child-fail-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: true,
			delegatedChildSteerOutcome: "failed",
			delegatedChildSteerError: "child runtime unreachable",
		});
	});

	it("#3 steerRun skips child forwarding when there is no delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-steer-no-child-1",
				organizationId: ORG_ID,
				conversationId: "home:steer-no-child",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const forwarder = vi.fn();
		kernelRuntimeTestHooks.setChildSteerForwarderForTest(
			forwarder as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setChildSteerForwarderForTest
			>[0],
		);
		const client = createKernelRuntimeClient(createContext(db));

		const steered = await client.steerRun({
			runId: "home-steer-no-child-1",
			instruction: "No child to forward to.",
		});

		expect(forwarder).not.toHaveBeenCalled();
		expect(
			(steered.run.metadata as Record<string, unknown>).delegatedChildSteer,
		).toBeNull();
		const steerEvent = db.events.find(
			(event) =>
				event.kind === "message.received" &&
				event.runId === "home-steer-no-child-1" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.steerRun",
		);
		expect(steerEvent?.runtimeMetadata).toMatchObject({
			delegatedChildSteerAttempted: false,
			delegatedChildSteerOutcome: "skipped",
		});
	});

	it("#3 cancelRun cascades the stop to a live delegated child and records the outcome", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-child",
				status: "running",
				metadata: {
					childRunStatus: "running",
					childRunPreview: "child still working",
					childRunLatestEventAt: "2026-06-06T08:01:00.000Z",
				},
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-child-1",
			reason: "operator aborted the delegation",
		});

		expect(canceled.run.status).toBe("canceled");
		const persisted = db.runs.find((run) => run.id === "home-cancel-child-1")!;
		expect(canceled.run.completedAt).toBe(persisted.completedAt);
		expect(canceled.run.updatedAt).toBe(persisted.updatedAt);
		expect(canceled.run.metadata?.childRunPreview).toBe(persisted.preview);
		expect(canceled.run.progress).toMatchObject({
			current: 100,
			label: "Stopped",
		});
		for (let read = 0; read < 2; read += 1) {
			const result = await client.readRun({ runId: "home-cancel-child-1" });
			expect(result.run).toMatchObject({
				status: "canceled",
				completedAt: persisted.completedAt,
				updatedAt: persisted.updatedAt,
				progress: { current: 100, label: "Stopped" },
				metadata: { childRunPreview: persisted.preview },
			});
		}
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stopper.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId: "child-cancel-1",
			childConversationId: "agent:main:main",
			reason: "operator aborted the delegation",
		});
		expect(canceled.run.metadata).toMatchObject({
			delegatedChildStop: {
				attempted: true,
				outcome: "succeeded",
				childRunId: "child-cancel-1",
				delegatedTediId: "tedi-cto",
			},
		});
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" && event.runId === "home-cancel-child-1",
		);
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: true,
			delegatedChildStopOutcome: "succeeded",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.canceled",
				resourceId: "home-cancel-child-1",
				metadata: expect.objectContaining({
					delegatedChildStopAttempted: true,
					delegatedChildStopOutcome: "succeeded",
				}),
			}),
		);
	});

	it("#3 cancelRun also stops the live steer injection child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-steer-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-steer-child",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-primary-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedChildSteer: {
						childInjectRunId: "child-cancel-steer-1",
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn(async (input: { childRunId: string }) =>
			input.childRunId === "child-cancel-steer-1"
				? {
						attempted: true,
						outcome: "failed" as const,
						error: "steer runtime reconnecting",
					}
				: { attempted: true, outcome: "succeeded" as const },
		);
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-steer-child-1",
			reason: "operator canceled parent and steer",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(stopper).toHaveBeenCalledTimes(2);
		expect(stopper.mock.calls.map(([input]) => input.childRunId)).toEqual([
			"child-cancel-primary-1",
			"child-cancel-steer-1",
		]);
		expect(db.submissionAbortStamps.map((stamp) => stamp.submissionId)).toEqual(
			[
				"sub:home-cancel-steer-child-1",
				"sub:child-cancel-primary-1",
				"sub:child-cancel-steer-1",
			],
		);
		expect(canceled.run.metadata).toMatchObject({
			delegatedChildStop: {
				attempted: true,
				outcome: "failed",
				childRunId: "child-cancel-primary-1",
			},
			delegatedChildStops: [
				{
					attempted: true,
					outcome: "succeeded",
					childRunId: "child-cancel-primary-1",
				},
				{
					attempted: true,
					outcome: "failed",
					childRunId: "child-cancel-steer-1",
					error: "steer runtime reconnecting",
				},
			],
		});
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" &&
				event.runId === "home-cancel-steer-child-1",
		);
		expect(cancelEvent?.payload).toMatchObject({
			childRunIds: ["child-cancel-primary-1", "child-cancel-steer-1"],
		});
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: true,
			delegatedChildStopOutcome: "failed",
		});
	});

	it("cancelRun best-effort aborts the KernelDO's in-flight turn AFTER the run row is durably canceled", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const canceler = vi.fn(async (input: { runId: string }) => {
			// Assert-on-call: by the time this fires, the run row is already
			// durably canceled — the DO-abort is purely a token-burn optimization,
			// never a dependency the settle correctness relies on.
			const row = db.runs.find((r) => r.id === input.runId);
			expect(row?.status).toBe("canceled");
			return true;
		});
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(canceler);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({ runId: "home-cancel-do-1" });

		expect(canceled.run.status).toBe("canceled");
		expect(canceler).toHaveBeenCalledTimes(1);
		expect(canceler.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			runId: "home-cancel-do-1",
		});
	});

	it("cancelRun stays fail-soft when the DO turn-canceler throws — the run still settles canceled", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-2",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do-2",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setDoTurnCancelerForTest(async () => {
			throw new Error("DO unreachable — simulated");
		});
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({ runId: "home-cancel-do-2" });

		expect(canceled.run.status).toBe("canceled");
	});

	it("cancelRun resolves the DO via kernel.idFromName(organizationId) — the same identity the enqueue path uses", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-do-3",
				organizationId: ORG_ID,
				conversationId: "home:cancel-do-3",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const cancelTurnCalls: Array<{ doId: string; runId: string }> = [];
		const fakeKernelNamespace = {
			idFromName: (name: string) => name,
			get: (doId: string) => ({
				cancelTurn: async (runId: string) => {
					cancelTurnCalls.push({ doId, runId });
					return true;
				},
			}),
		};
		const client = createKernelRuntimeClient(
			createContext(db, { env: { KERNEL: fakeKernelNamespace } }),
		);

		const canceled = await client.cancelRun({ runId: "home-cancel-do-3" });

		expect(canceled.run.status).toBe("canceled");
		expect(cancelTurnCalls).toEqual([
			{ doId: ORG_ID, runId: "home-cancel-do-3" },
		]);
	});

	it("cancelRun stamps durable abort intent on the parent AND the delegated child submissions before acting", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-stamp-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-stamp",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-cancel-stamp-1",
				childConversationId: "agent:main:main",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		// The child stop RPC fails — the durable intent must already be recorded
		// for both submissions regardless (stamp-before-action). Capture the stamps
		// visible at the moment the stopper fires so the ordering is pinned, not
		// just asserted after the fact.
		let stampsWhenStopperFired: string[] = [];
		const stopper = vi.fn(async () => {
			stampsWhenStopperFired = db.submissionAbortStamps.map(
				(s) => s.submissionId,
			);
			return {
				attempted: true,
				outcome: "failed" as const,
				error: "child runtime unreachable",
			};
		});
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-stamp-1",
			reason: "operator abort",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(db.submissionAbortStamps.map((s) => s.submissionId)).toEqual([
			"sub:home-cancel-stamp-1",
			"sub:child-cancel-stamp-1",
		]);
		// Stamp-before-action: both stamps had already landed when the (failed)
		// child-stop RPC fired — a lost stop still leaves durable intent behind.
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stampsWhenStopperFired).toEqual([
			"sub:home-cancel-stamp-1",
			"sub:child-cancel-stamp-1",
		]);
	});

	it("cancelRun with no delegated child stamps only the parent submission", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-stamp-solo",
				organizationId: ORG_ID,
				conversationId: "home:cancel-stamp-solo",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-stamp-solo",
			reason: "operator abort",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(db.submissionAbortStamps.map((s) => s.submissionId)).toEqual([
			"sub:home-cancel-stamp-solo",
		]);
	});

	it("cancelRun immediately releases a reused canonical Work Item and clears execution pointers", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-reused-work-item-1";
		const childRunId = "child-cancel-reused-work-item-1";
		const workItemId = "wi-cancel-reused-work-item-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-reused-work-item",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: { workItemId },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Reusable graph task",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: "original-operator-intent",
				sourceSessionKey: "operator-session",
				metadata: {
					canonicalWorkItemReuse: true,
					homeRunId,
					childRunId,
				},
				createdAt: "2026-06-06T07:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(
			vi.fn(async () => ({
				attempted: true,
				outcome: "succeeded" as const,
			})),
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: homeRunId,
			reason: "operator preserves task for retry",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(
			db.workAttemptRows.find((attempt) => attempt.workItemId === workItemId),
		).toMatchObject({
			runtimeState: "cancelled",
			outcome: "cancelled",
			executorId: "tedi-cto",
		});
	});

	it("#3 cancelRun carries completed steering proof into the canceled Work Item disposition", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-steer-proof-1";
		const childRunId = "child-cancel-steer-proof-primary-1";
		const steerRunId = "child-cancel-steer-proof-inject-1";
		const workItemId = "wi-cancel-steer-proof-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-steer-proof",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cto",
					workItemId,
					delegatedChildSteer: {
						attempted: true,
						outcome: "succeeded",
						childRunId,
						childInjectRunId: steerRunId,
					},
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Cancel steer proof",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: childRunId,
				sourceSessionKey: "home:cancel-steer-proof",
				metadata: { homeRunId, delegatedTediId: "tedi-cto" },
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-primary-started",
				kind: "run.started",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:01:00.000Z",
				payload: { status: "queued" },
			}),
			childRuntimeEvent({
				id: "runtime-primary-context",
				kind: "context.injected",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:01:30.000Z",
				payload: { source: "compiled-directives" },
			}),
		);
		const steeringProofEvents = [
			childRuntimeEvent({
				id: "runtime-steer-proof-message",
				kind: "message.completed",
				runId: steerRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:02:00.000Z",
				payload: {
					role: "assistant",
					content:
						"Stopped. request_workstation was not reached and repo_commit was not reached.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-steer-proof-completed",
				kind: "run.completed",
				runId: steerRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:00.000Z",
				payload: { status: "completed" },
			}),
		];
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		await client.cancelRun({
			runId: homeRunId,
			reason: "operator stopped after steering proof",
		});
		db.runtimeEvents.push(...steeringProofEvents);
		await client.readRun({ runId: homeRunId });

		const terminalComment = db.workItemCommentRows.find(
			(comment) => comment.id === `${workItemId}:terminal:canceled`,
		);
		expect(terminalComment).toMatchObject({
			body: expect.stringContaining("Latest steering evidence"),
			metadata: expect.objectContaining({
				childRunId,
				childRunStatus: "canceled",
				hasProof: false,
				steeringProof: expect.objectContaining({
					childRunId: steerRunId,
					hasProof: true,
					transcriptPreview: expect.stringContaining(
						"repo_commit was not reached",
					),
				}),
			}),
		});
		expect(
			db.workItemRows.find((item) => item.id === workItemId),
		).toMatchObject({
			disposition: "cancelled",
		});
	});

	it("#3 cancelRun reconciles an already-terminal delegated child instead of overwriting it", async () => {
		const db = createKernelRuntimeDb();
		const homeRunId = "home-cancel-child-terminal-race-1";
		const childRunId = "child-cancel-terminal-race-1";
		const workItemId = "wi-cancel-terminal-race-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:cancel-child-terminal-race",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cto",
					workItemId,
				},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Cancel race proof",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto",
				sourceIntentId: childRunId,
				sourceSessionKey: "home:cancel-child-terminal-race",
				metadata: { homeRunId, delegatedTediId: "tedi-cto" },
				createdAt: "2026-06-06T08:00:00.000Z",
			}),
		);
		db.workAttemptRows.push(
			runningWorkAttempt(workItemId, "tedi-cto", childRunId),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				id: "runtime-cancel-race-message",
				kind: "message.completed",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:02:00.000Z",
				payload: {
					role: "assistant",
					content: "Completed CTO patch proposal with proof text.",
				},
			}),
			childRuntimeEvent({
				id: "runtime-cancel-race-completed",
				kind: "run.completed",
				runId: childRunId,
				tediId: "tedi-cto",
				createdAt: "2026-06-06T08:03:00.000Z",
				payload: { status: "completed" },
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const result = await client.cancelRun({
			runId: homeRunId,
			reason: "operator canceled after child completed",
		});

		expect(result.run.status).toBe("completed");
		expect(stopper).not.toHaveBeenCalled();
		expect(db.runs.find((run) => run.id === homeRunId)).toMatchObject({
			status: "completed",
			latestEventKind: "run.completed",
			outputMessageId: `${homeRunId}:async-completion:assistant`,
		});
		expect(
			db.events.some(
				(event) => event.kind === "run.canceled" && event.runId === homeRunId,
			),
		).toBe(false);
		expect(
			db.auditRows.some(
				(row) =>
					(row as Record<string, unknown>).action === "kernel.run.canceled" &&
					(row as Record<string, unknown>).resourceId === homeRunId,
			),
		).toBe(false);
		expect(
			db.workAttemptRows.find((attempt) => attempt.workItemId === workItemId),
		).toMatchObject({
			runtimeState: "finished",
			outcome: "succeeded",
		});
		expect(
			db.workItemCommentRows.find(
				(comment) => comment.id === `${workItemId}:terminal:completed`,
			),
		).toMatchObject({
			metadata: expect.objectContaining({
				childRunStatus: "completed",
				hasProof: true,
			}),
		});
	});

	it("#3 cancelRun skips the child stop cascade when there is no delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-no-child-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-no-child",
				status: "running",
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const stopper = vi.fn();
		kernelRuntimeTestHooks.setChildStopperForTest(
			stopper as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setChildStopperForTest
			>[0],
		);
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-no-child-1",
		});

		expect(canceled.run.status).toBe("canceled");
		expect(stopper).not.toHaveBeenCalled();
		expect(
			(canceled.run.metadata as Record<string, unknown>).delegatedChildStop,
		).toBeNull();
		const cancelEvent = db.events.find(
			(event) =>
				event.kind === "run.canceled" &&
				event.runId === "home-cancel-no-child-1",
		);
		expect(cancelEvent?.runtimeMetadata).toMatchObject({
			delegatedChildStopAttempted: false,
			delegatedChildStopOutcome: "skipped",
		});
	});

	it("#3 run-set reconcile stops a still-running delegated child of an already-canceled parent (post-cancel race)", async () => {
		// The exact cancel race: cancelKernelRunCore ran while childRunId was
		// still null (skipped its cascade), the dispatch then linked the child
		// onto the canceled row. The next run-set read must stop the child via
		// the same child-stop mechanism, exactly once, and keep the parent
		// canceled.
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cto:mcp:home-cancel-race-1_auto_tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-race-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-race",
				status: "canceled",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:delegation-x",
				// Cancel core saw no child → its cascade marker is null.
				metadata: { delegatedChildStop: null },
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:00:30.000Z",
				updatedAt: "2026-06-06T08:00:30.000Z",
			}),
		);
		// The zombie child is live: it started and never reached a terminal event.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-cancel-race-started",
				kind: "run.started",
				payload: { status: "running" },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		const runSet = await client.readRunSet({
			conversationId: "home:cancel-race",
			limit: 10,
		});
		const run = runSet.runSet.runs.find(
			(candidate) => candidate.id === "home-cancel-race-1",
		);
		// The parent stays canceled — never revived by live child activity.
		expect(run?.status).toBe("canceled");
		expect(stopper).toHaveBeenCalledTimes(1);
		expect(stopper.mock.calls[0]?.[0]).toMatchObject({
			delegatedTediId: "tedi-cto",
			childRunId,
			childConversationId: "agent:main:delegation-x",
			reason: "Parent Home run canceled by operator",
		});
		// Marker persisted on the run row so the stop is single-shot.
		const row = db.runs.find(
			(candidate) => candidate.id === "home-cancel-race-1",
		);
		expect(
			(row?.metadata as Record<string, unknown> | null)
				?.canceledChildStopReconcile,
		).toMatchObject({
			attempted: true,
			outcome: "succeeded",
			childRunId,
		});

		// A second read must not fire the stopper again (marker-gated).
		await client.readRunSet({ conversationId: "home:cancel-race", limit: 10 });
		expect(stopper).toHaveBeenCalledTimes(1);
	});

	it("#3 run-set reconcile records a skipped marker (no stop RPC) when the canceled parent's child already settled", async () => {
		const db = createKernelRuntimeDb();
		const childRunId = "tedi-cto:mcp:home-cancel-settled-1_auto_tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-settled-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-settled",
				status: "canceled",
				delegatedTediId: "tedi-cto",
				childRunId,
				childConversationId: "agent:main:delegation-y",
				metadata: { delegatedChildStop: null },
				createdAt: "2026-06-06T08:00:00.000Z",
				completedAt: "2026-06-06T08:00:30.000Z",
				updatedAt: "2026-06-06T08:00:30.000Z",
			}),
		);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-cancel-settled-message",
				kind: "message.completed",
				payload: { role: "assistant", content: "Done before the cancel." },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:01.000Z",
				id: "child-cancel-settled-completed",
				kind: "run.completed",
				payload: { status: "completed" },
				runId: childRunId,
				tediId: "tedi-cto",
			}),
		);
		const stopper = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		kernelRuntimeTestHooks.setChildStopperForTest(stopper);
		const client = createKernelRuntimeClient(createContext(db));

		await client.readRunSet({
			conversationId: "home:cancel-settled",
			limit: 10,
		});

		expect(stopper).not.toHaveBeenCalled();
		const row = db.runs.find(
			(candidate) => candidate.id === "home-cancel-settled-1",
		);
		expect(
			(row?.metadata as Record<string, unknown> | null)
				?.canceledChildStopReconcile,
		).toMatchObject({
			attempted: false,
			outcome: "skipped",
			childRunStatus: "completed",
		});
	});

	it("#5 surfaces intermediate child progress as an idempotent work-card event without polluting the transcript", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async (input) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued",
		}));

		await client.enqueueMessage({
			conversationId: "home:progress",
			content: "Ask Echo to keep working",
			delegateToTediId: "tedi-echo",
			idempotencyKey: "home-progress-1",
		});
		const childRunId = "tedi-echo:mcp:home-progress-1_delegate_tedi-echo";
		// A non-terminal child advance: the worker started and emitted a streaming
		// delta, but has not completed.
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-06T08:01:00.000Z",
				id: "child-progress-started",
				kind: "run.started",
				payload: { status: "running" },
				runId: childRunId,
				tediId: "tedi-echo",
			}),
			childRuntimeEvent({
				createdAt: "2026-06-06T08:02:00.000Z",
				delta: "Halfway through the migration audit.",
				id: "child-progress-delta",
				kind: "message.delta",
				payload: {
					status: "running",
					content: "Halfway through the migration audit.",
				},
				runId: childRunId,
				tediId: "tedi-echo",
			}),
		);

		await client.readRunSet({ conversationId: "home:progress", limit: 10 });

		const progressEvents = db.events.filter(
			(event) =>
				event.kind === "message.delta" &&
				(event.runtimeMetadata as { source?: string } | null)?.source ===
					"kernelRuntime.delegationProgress",
		);
		expect(progressEvents).toHaveLength(1);
		expect(progressEvents[0]).toMatchObject({
			runId: "home-progress-1",
			childRunId,
			delegatedTediId: "tedi-echo",
		});
		// The HomeRun status collapses to "running", but the richer child
		// sub-state (a streaming delta) is preserved in the event metadata.
		expect(progressEvents[0]?.runtimeMetadata).toMatchObject({
			asyncProgress: true,
			childRunStatus: "streaming",
		});

		// Idempotent: a second reconcile poll over the same child event does not
		// duplicate the progress event.
		await client.readRunSet({ conversationId: "home:progress", limit: 10 });
		expect(
			db.events.filter(
				(event) =>
					event.kind === "message.delta" &&
					(event.runtimeMetadata as { source?: string } | null)?.source ===
						"kernelRuntime.delegationProgress",
			),
		).toHaveLength(1);

		// The progress event never reaches the Home chat transcript.
		const messages = await client.readMessages({
			conversationId: "home:progress",
			limit: 50,
		});
		expect(
			messages.messages.some((message) => message.id.includes("message.delta")),
		).toBe(false);
		expect(
			messages.messages.some((message) =>
				typeof message.content === "string"
					? message.content.includes("Halfway through the migration audit.")
					: false,
			),
		).toBe(false);
	});

	it("cancelRun stamps kernelRoute from the run row onto the audit event so home-reflection-producer can mine the rationale", async () => {
		// A delegated run that already carried a kernelRoute (stamped by turn-work.ts
		// when the kernel completed its routing decision). The cancel path must forward
		// it into the audit event metadata so home-reflection-producer's
		// extractRouteRationale fires the "because:" clause.
		const db = createKernelRuntimeDb();
		const kernelRoute = {
			routeKind: "delegate_tedi",
			rationale:
				"cfo owns finance reconciliation and this is a quarterly close",
			confidence: 0.88,
			effortClass: "multi_hop_read",
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-g3-1",
				organizationId: ORG_ID,
				conversationId: "home:cancel-g3",
				status: "running",
				delegatedTediId: "tedi-cfo",
				childRunId: "child-g3-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId: "tedi-cfo",
					kernelRoute,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-g3-1",
			reason: "strategy changed",
		});

		expect(canceled.run.status).toBe("canceled");

		// The audit event must carry kernelRoute so the producer's route-rationale path fires.
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.canceled" &&
				(r as Record<string, unknown>).resourceId === "home-cancel-g3-1",
		) as Record<string, unknown> | undefined;
		expect(auditRow).toBeDefined();
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		expect(auditMeta?.kernelRoute).toMatchObject({
			routeKind: "delegate_tedi",
			rationale:
				"cfo owns finance reconciliation and this is a quarterly close",
		});
		// delegatedTediId also present (producer needs it for the tediId + clause).
		expect(auditMeta?.delegatedTediId).toBe("tedi-cfo");
	});

	it("fail-soft: cancelRun with no kernelRoute on the run → audit event carries kernelRoute null, not a thrown error", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-cancel-g3-nosig",
				organizationId: ORG_ID,
				conversationId: "home:cancel-g3-nosig",
				status: "running",
				delegatedTediId: "tedi-cfo",
				metadata: {
					delegatedTediId: "tedi-cfo",
					// no kernelRoute — producer must fall back to bare fact text
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);
		kernelRuntimeTestHooks.setChildStopperForTest(async () => ({
			attempted: false,
			outcome: "skipped" as const,
		}));
		const client = createKernelRuntimeClient(createContext(db));

		const canceled = await client.cancelRun({
			runId: "home-cancel-g3-nosig",
		});

		expect(canceled.run.status).toBe("canceled");
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.canceled" &&
				(r as Record<string, unknown>).resourceId === "home-cancel-g3-nosig",
		) as Record<string, unknown> | undefined;
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		// Absent kernelRoute → null in audit metadata (fail-soft, no throw).
		expect(auditMeta?.kernelRoute).toBeNull();
	});
});

describe("home approved-write layer (v1)", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(null);
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
	});

	const WRITE_ROUTE = {
		routeKind: "propose_tool_write" as const,
		rationale: "Operator asked to create a Globex invoice.",
		risk: "medium" as const,
		confidence: 0.82,
		toolIntent: {
			appSlug: "globex",
			capability: "globex.invoices.create",
			connectionStatus: "connected" as const,
		},
	};

	const PROPOSAL = {
		appSlug: "globex-tedix",
		toolName: "globex__create_invoice",
		args: { amount: 100, customerName: "ACME" },
		reasoning: "create the requested invoice",
		riskTier: "low" as const,
	};

	function stubWriteKernel() {
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "RECOMMEND:write",
				route: WRITE_ROUTE,
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);
	}

	async function enqueueWriteProposalTurn(
		db: ReturnType<typeof createKernelRuntimeDb>,
		runId = "home-write-1",
	) {
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		stubWriteKernel();
		const planner = vi.fn(async () => PROPOSAL);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			planner as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);
		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice over 100 euros for ACME",
			idempotencyKey: runId,
		});
		return { context, client, planner, result };
	}

	it("a planned write parks behind an approval card: approval row + requires_approval run", async () => {
		const db = createKernelRuntimeDb();
		const { planner, result } = await enqueueWriteProposalTurn(db);

		expect(planner).toHaveBeenCalledTimes(1);
		expect(planner.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			route: { routeKind: "propose_tool_write" },
			content: "create a globex invoice over 100 euros for ACME",
		});

		// The run is parked, not completed — nothing executed.
		expect(result.status).toBe("requires_approval");
		expect(result.run.status).toBe("requires_approval");
		expect(result.run.completedAt).toBeNull();

		// One approval row, deterministic uuid-shaped id, exact stored payload.
		expect(db.approvals).toHaveLength(1);
		const approval = db.approvals[0];
		expect(approval?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(approval?.status).toBe("pending");
		expect(approval?.actionType).toBe("home.tool_write");
		// FK anchor only — true attribution lives in the payload.
		expect(approval?.tediId).toBe("tedi-cpo");
		expect(approval?.payload).toEqual({
			kind: "home_tool_write",
			appSlug: "globex-tedix",
			toolName: "globex__create_invoice",
			args: { amount: 100, customerName: "ACME" },
			organizationId: ORG_ID,
			homeRunId: "home-write-1",
			conversationId: "home:write",
			initiatedByUserId: null,
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "kernel",
				actorType: "kernel",
				action: "approval.requested",
				resourceType: "approval_request",
				resourceId: approval?.id,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeToolWrite",
					actionType: "home.tool_write",
					homeRunId: "home-write-1",
					conversationId: "home:write",
					appSlug: "globex-tedix",
					toolName: "globex__create_invoice",
				}),
			}),
		);

		// Run metadata carries the approval link + the proposed call.
		expect(result.run.metadata).toMatchObject({
			approvalRequestId: approval?.id,
			kernelWriteProposal: {
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				args: { amount: 100, customerName: "ACME" },
			},
			kernelRoute: { routeKind: "propose_tool_write" },
		});

		// Card text names the tool, the target app, and the exact arguments.
		expect(result.assistantMessage?.content).toContain(
			"globex__create_invoice",
		);
		expect(result.assistantMessage?.content).toContain("globex-tedix");
		expect(result.assistantMessage?.content).toContain('"amount":100');
		expect(result.assistantMessage?.content).toContain(
			"Nothing has been executed",
		);

		// approval.requested replaces the terminal run event.
		expect(
			db.events.some(
				(event) =>
					event.kind === "approval.requested" && event.runId === "home-write-1",
			),
		).toBe(true);
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.completed" && event.runId === "home-write-1",
			),
		).toBe(false);
	});

	it("approve executes the STORED call exactly once and records evidence + transcript", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-1", status: "draft" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});

		expect(executor).toHaveBeenCalledTimes(1);
		// The executor receives only the server-stored payload.
		expect(executor.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				kind: "home_tool_write",
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				args: { amount: 100, customerName: "ACME" },
				homeRunId: "home-write-1",
			},
		});

		const run = db.runs.find((row) => row.id === "home-write-1");
		expect(run?.status).toBe("completed");
		expect(run?.metadata).toMatchObject({
			kernelWriteExecutedAt: expect.any(String),
			kernelWriteExecutionId: "INV-1",
			kernelEvidence: {
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				data: { result: { id: "INV-1", status: "draft" } },
			},
		});

		const transcript = db.events.find(
			(event) =>
				event.kind === "message.completed" &&
				event.messageId === "home-write-1:home-write:assistant",
		);
		expect(
			(transcript?.payload as { content?: string } | null)?.content,
		).toContain("Executed globex__create_invoice on globex-tedix");
		expect(
			(
				transcript?.payload as {
					metadata?: { kernelWriteExecutionId?: string };
				} | null
			)?.metadata?.kernelWriteExecutionId,
		).toBe("INV-1");
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.completed" && event.runId === "home-write-1",
			),
		).toBe(true);

		// Idempotency: a re-settle never re-executes.
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});
		expect(executor).toHaveBeenCalledTimes(1);
	});

	it("keeps the durable retained-result handle when event append fails and never redispatches", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(
			db,
			"home-write-append-fail",
		);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-DURABLE" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);
		const reference = {
			id: "f84355c3-e163-47d2-8097-d3d295e78169",
			sha256: "a".repeat(64),
			byteSize: 128,
			expiresAt: "2026-09-23T00:00:00.000Z",
		};
		setKernelToolResultRetainerForTest(async () => reference);
		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		db.controls.kernelEventInsertError = new Error("event append unavailable");

		await expect(
			settleHomeToolWriteApproval(context, {
				approval: { ...approval, status: "approved" },
				status: "approved",
			}),
		).resolves.toBe("unknown");

		expect(
			db.runs.find((row) => row.id === "home-write-append-fail"),
		).toMatchObject({
			status: "completed",
			metadata: { kernelToolResultReference: reference },
		});
		db.controls.kernelEventInsertError = null;
		await expect(
			settleHomeToolWriteApproval(context, {
				approval: { ...approval, status: "approved" },
				status: "approved",
			}),
		).resolves.toBe("unknown");
		expect(executor).toHaveBeenCalledOnce();
	});

	it("reject NEVER executes and closes the run as canceled", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-2");
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "rejected" },
			status: "rejected",
		});

		expect(executor).not.toHaveBeenCalled();
		const run = db.runs.find((row) => row.id === "home-write-2");
		expect(run?.status).toBe("canceled");
		const transcript = db.events.find(
			(event) =>
				event.kind === "message.completed" &&
				event.messageId === "home-write-2:home-write:assistant",
		);
		expect(
			(transcript?.payload as { content?: string } | null)?.content,
		).toContain("rejected — nothing was executed");
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.canceled" && event.runId === "home-write-2",
			),
		).toBe(true);

		// A late approve after the rejection settle cannot execute either
		// (the run already left requires_approval).
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
	});

	// Trusted-write tier (plan item #2) — the audit row is always created; a
	// trusted/low-risk write is just auto-resolved (resolvedBy:'policy') through
	// the same latch instead of parking behind a human card.
	function trustedPolicyDb(trustedTools: string[]) {
		return createKernelRuntimeDb({
			policyPackRows: [
				{ definition: { governancePolicy: { writeTier: { trustedTools } } } },
			],
		});
	}

	it("(a) low-risk trusted write auto-resolves WITH an audit row + resolvedBy:'policy' and executes", async () => {
		const db = trustedPolicyDb(["globex-tedix:globex__create_invoice"]);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-AUTO" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		// The audit row is still created — and auto-resolved by policy.
		expect(db.approvals).toHaveLength(1);
		const approval = db.approvals[0];
		expect(approval?.status).toBe("approved");
		expect(approval?.resolvedBy).toBe("policy");

		// Both audit events: the request and the policy-attributed approval.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "approval.requested",
				resourceId: approval?.id,
			}),
		);
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "policy",
				action: "approval.approved",
				resourceId: approval?.id,
				metadata: expect.objectContaining({
					source: "kernelRuntime.autoResolveKernelWrite",
					resolverProvenance: "policy",
					autoResolveSource: "policy",
				}),
			}),
		);

		// The per-click tax is removed: the stored call executed in-turn.
		expect(executor).toHaveBeenCalledTimes(1);
		const run = db.runs.find((row) => row.id === "home-write-1");
		expect(run?.status).toBe("completed");
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: {
				autoResolve: true,
				source: "policy",
				willAutoResolve: true,
			},
		});
	});

	it("(b) a non-trusted write still parks behind a human gate (no auto-resolve, no execution)", async () => {
		const db = trustedPolicyDb(["other-app:create_thing"]);
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(result.status).toBe("requires_approval");
		expect(db.approvals[0]?.status).toBe("pending");
		expect(db.approvals[0]?.resolvedBy).toBeNull();
		expect(executor).not.toHaveBeenCalled();
		expect(db.auditRows.some((row) => row.action === "approval.approved")).toBe(
			false,
		);
	});

	it("(c) session pre-authorization auto-resolves only an allowlisted tool", async () => {
		const db = createKernelRuntimeDb();
		// Operator pre-authorized this tool for the conversation via a prior run's
		// session allowlist — no org policy at all.
		db.runs.push({
			id: "seed-grant",
			organizationId: ORG_ID,
			conversationId: "home:write",
			createdAt: "2020-01-01T00:00:00.000Z",
			metadata: {
				sessionWriteAllowlist: ["globex-tedix:globex__create_invoice"],
			},
		} as unknown as KernelRuntimeRunRow);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-SESSION" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(db.approvals[0]?.status).toBe("approved");
		expect(db.approvals[0]?.resolvedBy).toBe("policy");
		expect(executor).toHaveBeenCalledTimes(1);
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: { autoResolve: true, source: "session" },
		});
	});

	it("(d) fail-closed default: no policy + no session => human gate, no approval.approved", async () => {
		const db = createKernelRuntimeDb();
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(result.status).toBe("requires_approval");
		expect(db.approvals[0]?.status).toBe("pending");
		expect(executor).not.toHaveBeenCalled();
		expect(db.auditRows.some((row) => row.action === "approval.approved")).toBe(
			false,
		);
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: { autoResolve: false, willAutoResolve: false },
		});
	});

	it("a failed approved write lands as run.failed with the bounded upstream error", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-3");
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			vi.fn(async () => ({
				ok: false as const,
				error: "Provider rejected the invoice payload",
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});

		const run = db.runs.find((row) => row.id === "home-write-3");
		expect(run?.status).toBe("failed");
		expect(run?.metadata).toMatchObject({
			kernelWriteError: "Provider rejected the invoice payload",
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.failed" && event.runId === "home-write-3",
			),
		).toBe(true);
	});

	it("planner failure falls back to the recommendation text (no approval, run completed)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => null),
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-fallback-1",
		});

		expect(result.status).toBe("needs_delegation");
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toBe("RECOMMEND:write");
		expect(db.approvals).toHaveLength(0);
		expect(result.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "propose_tool_write" },
		});
		expect(
			(result.run.metadata as Record<string, unknown>).kernelWriteProposal,
		).toBeUndefined();
	});

	it("a declined proposal survives into the persisted run row (kernelWriteProposalDeclined)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(
				async (args: {
					onDecline?: (declined: { stage: string; detail?: string }) => void;
				}) => {
					args.onDecline?.({
						stage: "planner_declined",
						detail: "test-detail",
					});
					return null;
				},
			) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-declined-1",
		});

		// Declined-write honesty: the operator sees an honest per-stage message,
		// not the planner's optimistic "Confirm and I'll prepare it for approval"
		// text — the write moat held and nothing was created or sent.
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toContain("write-capable");
		expect(result.assistantMessage?.content).toContain(
			"exact globex.invoices.create call",
		);
		expect(result.assistantMessage?.content).toContain("globex");
		expect(result.assistantMessage?.content).not.toContain(
			"Confirm and I'll prepare it for approval",
		);
		expect(db.approvals).toHaveLength(0);

		// Fail-soft is not fail-silent: the decline reason survives the
		// turn-work metadata merge into the persisted run row, so the why is
		// diagnosable from readRun alone (no log tails).
		const read = await client.readRun({ runId: "home-write-declined-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			kernelWriteProposalDeclined: {
				stage: "planner_declined",
				detail: "test-detail",
			},
			kernelRoute: { routeKind: "propose_tool_write" },
		});
		const metadata = read.run.metadata as Record<string, unknown>;
		// approvalRequestId is a baseline run-row field (null when no approval
		// was created); the write-proposal card fields never appear.
		expect(metadata.approvalRequestId).toBeNull();
		expect(metadata.kernelWriteProposal).toBeUndefined();
	});

	it('a planner crash persists stage "error" into the run row metadata', async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => {
				throw new Error("planner exploded");
			}) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-declined-2",
		});

		// Declined-write honesty: planner crash → honest "nothing was created or
		// sent" message, not the optimistic planner text.
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toContain(
			"nothing was created or sent",
		);
		expect(result.assistantMessage?.content).toContain("globex");
		expect(result.assistantMessage?.content).not.toContain(
			"Confirm and I'll prepare it for approval",
		);
		expect(db.approvals).toHaveLength(0);

		const read = await client.readRun({ runId: "home-write-declined-2" });
		expect(read.run.metadata).toMatchObject({
			kernelWriteProposalDeclined: {
				stage: "error",
				detail: expect.stringContaining("planner exploded"),
			},
		});
	});

	it("a delegate_tedi delegation verdict survives into the persisted run row (homeDelegation)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// Kernel stub: a delegate_tedi route that resolved a carded target →
		// KernelResult.delegation carries the work order + the fail-closed
		// dispatch verdict. Typed via the real KernelResult so a shape drift
		// in HomeDelegationEvidence/DelegationWorkOrder/DispatchDecision breaks
		// this test.
		const delegation: NonNullable<KernelResult["delegation"]> = {
			workOrder: {
				objective: "Review the product roadmap priorities for the operator.",
				executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
				outputContract: "A short summary of the top 3 priorities.",
				toolGuidance: ['Use your "mcp:apps" scope group for this work.'],
				boundaries: ["Do not exceed your assigned scopes."],
				sourceContent: "Have the CPO review our roadmap.",
				targetTediId: "tedi-cpo",
				targetTediLabel: "CPO",
			},
			decision: {
				canAutoDispatch: false,
				mode: "needs_approval",
				reason: "target not active",
			},
		};
		const route: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "CPO owns product roadmap",
			risk: "low",
			confidence: 0.9,
			effortClass: null,
			answer: null,
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO owns this — want me to set up the hand-off?",
				route,
				delegation,
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:deleg",
			content: "Have the CPO review our roadmap.",
			idempotencyKey: "home-deleg-1",
		});

		// The verdict + work order survive the turn-work metadata merge into the
		// persisted run row — diagnosable from readRun alone (proven live, now
		// pinned: a regression in the metadata spread can't silently drop it).
		const read = await client.readRun({ runId: "home-deleg-1" });
		expect(read.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "delegate_tedi" },
			homeDelegation: {
				decision: { mode: "needs_approval", reason: "target not active" },
				workOrder: { targetTediLabel: "CPO" },
			},
		});
	});

	it("a non-delegation turn persists homeDelegation: null", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "42 active work items.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "42 active work items.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:answer",
			content: "how many active work items?",
			idempotencyKey: "home-answer-1",
		});

		const read = await client.readRun({ runId: "home-answer-1" });
		// `?? null` default: not spuriously set on non-delegation turns.
		expect(
			(read.run.metadata as Record<string, unknown>).homeDelegation,
		).toBeNull();
	});

	it("records explicit kernel correction metadata and a decision event", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Captured.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from Home context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "Captured.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "answer this in Home",
			idempotencyKey: "home-correction-prior",
		});
		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "actually correct that route",
			idempotencyKey: "home-correction-current",
			metadata: {
				correctionOf: "home-correction-prior",
				correctionSignal: "explicit_user_action",
				operatorNote: "wrong route",
			},
		});

		const read = await client.readRun({
			runId: "home-correction-current",
		});
		expect(read.run.metadata).toMatchObject({
			kernelCorrection: {
				action: "kernel.route_corrected",
				correctionSignal: "explicit_user_action",
				operatorNote: "wrong route",
				priorRouteKind: "answer_in_home",
				priorRunFound: true,
				priorRunId: "home-correction-prior",
				priorRunStatus: "completed",
				source: "kernelRuntime.enqueueMessage",
			},
			kernelRoute: { routeKind: "answer_in_home" },
		});
		const decisionEvent = db.events.find(
			(event) =>
				event.kind === "decision.recorded" &&
				event.runId === "home-correction-current",
		);
		expect(decisionEvent?.payload).toMatchObject({
			action: "kernel.route_corrected",
			priorRunFound: true,
			priorRunId: "home-correction-prior",
		});
		expect(decisionEvent?.runtimeMetadata).toMatchObject({
			priorRunFound: true,
			priorRunId: "home-correction-prior",
			signal: "kernel.route_corrected",
			source: "kernelRuntime.enqueueMessage",
		});
	});

	it("records correction attempts when the prior run is not found", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Captured.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from Home context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "Captured.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "correct a missing prior run",
			idempotencyKey: "home-correction-missing",
			metadata: {
				correction: { runId: "home-correction-missing-prior" },
				correctionNote: "prior run was outside this org or absent",
			},
		});

		const read = await client.readRun({
			runId: "home-correction-missing",
		});
		expect(read.run.metadata).toMatchObject({
			kernelCorrection: {
				action: "kernel.route_corrected",
				correctionSignal: "explicit_caller_metadata",
				operatorNote: "prior run was outside this org or absent",
				priorRouteKind: null,
				priorRunFound: false,
				priorRunId: "home-correction-missing-prior",
				priorRunStatus: null,
			},
		});
		const decisionEvent = db.events.find(
			(event) =>
				event.kind === "decision.recorded" &&
				event.runId === "home-correction-missing",
		);
		expect(decisionEvent?.payload).toMatchObject({
			priorRunFound: false,
			priorRunId: "home-correction-missing-prior",
		});
	});

	it("settle is a no-op for non home_tool_write approval payloads", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);
		await settleHomeToolWriteApproval(context, {
			approval: {
				id: "approval-other",
				tediId: "tedi-cto",
				orgId: ORG_ID,
				actionType: "workstation.attach",
				description: "x",
				payload: { source: "home.workstation_attach" },
				status: "approved",
				createdAt: "2026-06-10T08:00:00.000Z",
				expiresAt: "2026-06-11T08:00:00.000Z",
				resolvedAt: null,
				resolvedBy: null,
				resolution: null,
				workflowId: null,
			},
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
		expect(db.runs).toHaveLength(0);
	});

	describe("respondApproval — THE Home approval surface", () => {
		it("reuses a partially committed delegation Work Item by child-run intent", async () => {
			const db = createKernelRuntimeDb();
			const childRunId = "tedi-cpo:mcp:home-deleg-recovery_approved_tedi-cpo";
			const workItemId = "wi-partial-delegation";
			db.workItemRows.push(
				normalizeWorkItemInsert({
					id: workItemId,
					orgId: ORG_ID,
					title: "Partially committed delegation",
					disposition: "accepted",
					accountableOwnerType: "tedi",
					accountableOwnerId: "tedi-cpo",
					sourceIntentId: childRunId,
					sourceSessionKey: "home:recovery",
					workClass: "maintenance",
					purposeExceptionExpiresAt: "2099-01-01T00:00:00.000Z",
					createdAt: "2026-08-26T21:43:20.028Z",
				}),
			);
			db.workAttemptRows.push({
				...runningWorkAttempt(workItemId, "tedi-cpo", childRunId),
				runtimeState: "expired",
				outcome: "expired",
				expiresAt: "2026-08-26T21:48:20.028Z",
				finishedAt: "2026-08-26T21:50:07.000Z",
			});

			await expect(
				createDelegationWorkItem(createContext(db), {
					assigneeTediId: "tedi-cpo",
					childRunId,
					content: "Complete the approved delegation.",
					conversationId: "home:recovery",
					createdAt: "2026-08-27T01:00:00.000Z",
					executionRequirement: {
						surface: "managed_job",
						requiredCapabilities: ["repository_read"],
						fallbackSurface: "workstation",
						prohibitedSurfaces: [],
						satisfiable: true,
						reason: "test recovery",
					},
					homeRunId: "home-deleg-recovery",
					organizationId: ORG_ID,
				}),
			).resolves.toBe(workItemId);
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(2);
		});

		it("decision approve on a write card resolves via the canonical latch and executes exactly once", async () => {
			const db = createKernelRuntimeDb();
			const { client } = await enqueueWriteProposalTurn(
				db,
				"home-write-respond-1",
			);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { id: "INV-9", status: "draft" },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			const result = await client.respondApproval({
				runId: "home-write-respond-1",
				decision: "approve",
				note: "ship it",
			});

			// The same settle seam fired with only the server-stored payload.
			expect(executor).toHaveBeenCalledTimes(1);
			expect(executor.mock.calls[0]?.[0]).toMatchObject({
				payload: {
					kind: "home_tool_write",
					appSlug: "globex-tedix",
					toolName: "globex__create_invoice",
					args: { amount: 100, customerName: "ACME" },
					homeRunId: "home-write-respond-1",
				},
			});

			// Canonical pending→resolved latch on the approval row.
			expect(db.approvals[0]).toMatchObject({
				status: "approved",
				resolvedBy: "apikey",
				resolution: "ship it",
			});
			// Audit parity with tediApprovals.resolve.
			expect(
				db.auditRows.some(
					(row) =>
						row.action === "approval.approved" &&
						row.resourceId === db.approvals[0]?.id,
				),
			).toBe(true);

			expect(result.run.status).toBe("completed");
			expect(result.run.metadata).toMatchObject({
				kernelWriteExecutedAt: expect.any(String),
				kernelWriteExecutionId: "INV-9",
				kernelEvidence: {
					toolName: "globex__create_invoice",
					data: { id: "INV-9", status: "draft" },
				},
			});
			expect(result.assignments).toEqual([]);

			// Exactly-once: a second respond hits the resolved latch, never the
			// executor.
			await expect(
				client.respondApproval({
					runId: "home-write-respond-1",
					decision: "approve",
				}),
			).rejects.toThrow(/already "approved"/);
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it("decision reject on a write card NEVER executes and closes the run as canceled", async () => {
			const db = createKernelRuntimeDb();
			const { client } = await enqueueWriteProposalTurn(
				db,
				"home-write-respond-2",
			);
			const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			const result = await client.respondApproval({
				runId: "home-write-respond-2",
				decision: "reject",
				note: "not now",
			});

			expect(executor).not.toHaveBeenCalled();
			expect(db.approvals[0]).toMatchObject({
				status: "rejected",
				resolution: "not now",
			});
			expect(result.run.status).toBe("canceled");
			expect(result.assignments).toEqual([]);
			expect(
				db.events.some(
					(event) =>
						event.kind === "run.canceled" &&
						event.runId === "home-write-respond-2",
				),
			).toBe(true);
			// A late approve cannot resurrect the write.
			await expect(
				client.respondApproval({
					runId: "home-write-respond-2",
					decision: "approve",
				}),
			).rejects.toThrow(/already "rejected"/);
			expect(executor).not.toHaveBeenCalled();
		});

		it("decision reject on a proposed plan keeps the assignment-rejection behavior", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));

			await client.enqueueMessage({
				conversationId: "home:test",
				content:
					"Plan this across CPO and Echo: CPO owns the checklist while Echo validates evidence.",
				idempotencyKey: "home-plan-respond-reject-1",
			});
			const result = await client.respondApproval({
				runId: "home-plan-respond-reject-1",
				decision: "reject",
				note: "wrong owners",
			});

			expect(result.homePlan?.status).toBe("canceled");
			expect(result.run.status).toBe("canceled");
			expect(result.assignments).toHaveLength(2);
			expect(
				result.assignments.every(
					(assignment) => assignment.status === "canceled",
				),
			).toBe(true);
			expect(db.runs[0]?.metadata).toMatchObject({
				homePlanRejectionNote: "wrong owners",
			});
		});

		it("decision approve on a proposed plan delegates to the approve_home_plan core (Work Items + dispatch)", async () => {
			const db = createKernelRuntimeDb();
			const context = createContext(db);
			const client = createKernelRuntimeClient(context);
			const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}));
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

			await client.enqueueMessage({
				conversationId: "home:test",
				content:
					"Plan this across CPO and Echo: CPO owns the checklist while Echo validates evidence.",
				idempotencyKey: "home-plan-respond-approve-1",
			});
			const result = await client.respondApproval({
				runId: "home-plan-respond-approve-1",
				decision: "approve",
				note: "go",
			});
			await Promise.all(
				(context as BaseContext & { waitUntilPromises: Promise<unknown>[] })
					.waitUntilPromises,
			);

			expect(result.homePlan?.status).toBe("dispatching");
			expect(result.assignments).toHaveLength(2);
			expect(result.assignments.map((assignment) => assignment.status)).toEqual(
				["queued", "queued"],
			);
			expect(db.workItemRows).toHaveLength(2);
			expect(delegateRunner).toHaveBeenCalledTimes(2);
			expect(db.workItemRows[0]?.metadata).toMatchObject({
				approvalNote: "go",
			});
		});

		it("decision approve on a Home delegation recommendation dispatches the target tedi by homeRunId", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(
				async (input: { childRunId: string; content: string }) => ({
					childConversationId: "agent:main:main",
					childRunId: input.childRunId,
					status: "queued" as const,
				}),
			);
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent: "CPO owns this — want me to set up the hand-off?",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "CPO owns product",
						risk: "low" as const,
						confidence: 0.9,
						effortClass: null,
						answer: null,
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation: null,
					},
					delegation: {
						workOrder: {
							objective: "Review the roadmap",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract: "Return a short summary",
							toolGuidance: ["Use the product scope"],
							boundaries: ["Stay in-org"],
							sourceContent: "Have CPO review the roadmap.",
							targetTediId: "tedi-cpo",
							targetTediLabel: "CPO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "target not active",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: "Have CPO review the roadmap.",
				idempotencyKey: "home-deleg-respond-approve-1",
				metadata: { requiredProofKind: "code" },
			});
			expect(delegateRunner).not.toHaveBeenCalled();

			const result = await client.respondApproval({
				runId: "home-deleg-respond-approve-1",
				decision: "approve",
				note: "approved handoff",
			});

			expect(delegateRunner).toHaveBeenCalledTimes(1);
			expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
				childRunId: "home-deleg-respond-approve-1:approved:tedi-cpo",
				delegateToTediId: "tedi-cpo",
			});
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(1);
			const workItemId = db.workItemRows[0]?.id;
			expect(db.workItemRows[0]).toMatchObject({
				accountableOwnerId: "tedi-cpo",
				disposition: "accepted",
				metadata: {
					childRunId: expect.stringContaining(
						"home-deleg-respond-approve-1_approved_tedi-cpo",
					),
					homeRunId: "home-deleg-respond-approve-1",
					source: "kernelRuntime.directDelegation",
				},
			});
			expect(db.workAttemptRows[0]).toMatchObject({
				workItemId,
				executorId: "tedi-cpo",
				runtimeState: "running",
			});
			const delegateCall = delegateRunner.mock.calls[0]?.[0] as
				| { content: string; metadata: Record<string, unknown> }
				| undefined;
			expect(delegateCall).toBeDefined();
			expect(delegateCall?.content).toContain("[HOME DELEGATION WORK ORDER");
			expect(delegateCall?.content).toContain(`Work Item: ${workItemId}`);
			expect(delegateCall?.content).toContain(
				"Home owns the linked Work Item lifecycle below the model",
			);
			expect(delegateCall?.content).toContain(
				"You may read\nWork projects and items",
			);
			expect(delegateCall?.content).toContain(
				"Respect the original request's mutation limits exactly",
			);
			expect(delegateCall?.metadata).toMatchObject({
				workItemId,
				requiredProofKind: "code",
			});
			expect(result.run).toMatchObject({
				id: "home-deleg-respond-approve-1",
				status: "queued",
				delegatedTediId: "tedi-cpo",
				childRunId: "home-deleg-respond-approve-1:approved:tedi-cpo",
				metadata: {
					workItemId,
					homeDelegation: {
						resolutionStatus: "approved",
						workOrder: { status: "approved" },
					},
					homeApprovedDispatch: {
						workItemId,
						source: "kernelRuntime.respondApproval",
					},
				},
			});
			expect(result.assignments).toEqual([]);

			await expect(
				client.respondApproval({
					runId: "home-deleg-respond-approve-1",
					decision: "approve",
				}),
			).rejects.toThrow(/already "approved"/);
			expect(delegateRunner).toHaveBeenCalledTimes(1);
			// Recovery must preserve the same structured coding intent, not infer it
			// from the rendered work-order prose after an approval or failed attempt.
			db.workAttemptRows[0]!.runtimeState = "failed";
			db.workAttemptRows[0]!.finishedAt = new Date().toISOString();
			db.workAttemptRows[0]!.outcome = "failed";
			const previousRun = db.runs.find((run) => run.id === result.run.id)!;
			const previousChildRunId = previousRun.childRunId!;
			const oldTerminalAt = "2026-01-01T00:00:00.000Z";
			const oldSummary = {
				childRunStatus: "completed",
				childRunTerminalAt: oldTerminalAt,
				childRunLatestEventAt: oldTerminalAt,
				childRunPreview: "Old result",
				childRunTerminalEventKind: "run.completed",
				childRunEventCount: 10,
				childRunStopReason: "reported_partial",
				childRunStopDetail: "Old stop",
				delegationProof: { verdict: "failed" },
			};
			previousRun.status = "completed";
			previousRun.metadata = { ...previousRun.metadata, ...oldSummary };
			previousRun.runtimeMetadata = {
				...previousRun.runtimeMetadata,
				childRunId: previousChildRunId,
			};
			const recovery = await client.retryDelegation({
				workItemId: workItemId!,
			});
			expect(recovery.retryCount).toBe(1);
			expect(recovery.run).toMatchObject({
				status: "queued",
				completedAt: null,
				progress: { current: 24, label: "Dispatched" },
				runtime: { metadata: { childRunId: recovery.run.childRunId } },
				metadata: { homeRecoveryDispatch: { previousChildRunId } },
			});
			expect(recovery.run.updatedAt).not.toBe(oldTerminalAt);
			expect(recovery.run.metadata?.childRunPreview).not.toBe("Old result");
			expect(recovery.run.metadata?.delegationProof).toBeUndefined();
			const retriedRow = db.runs.find((run) => run.id === result.run.id)!;
			expect(
				normalizeHomeRunRecord(
					retriedRow,
					new Map([[`tedi-cpo:${previousChildRunId}`, oldSummary]]),
				).status,
			).toBe("queued");

			expect(delegateRunner).toHaveBeenLastCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						source: "kernelRuntime.retryDelegation",
						requiredProofKind: "code",
						delegationWorkOrder: expect.objectContaining({
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						}),
					}),
				}),
			);
		});

		it("decision approve rewrites approval-held draft work orders into executable tasks", async () => {
			const source = `Prepare a CTO delegation work order. Do not dispatch CTO yet; park this for approval. The intended CTO task is to inspect docs and return one improvement.\n${"Task context. ".repeat(300)}\nAcceptance: never alter the independent oracle; preserve each merge parent.`;
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(
				async (input: {
					childRunId: string;
					content: string;
					delegateToTediId: string;
					metadata: { delegationWorkOrder?: Record<string, unknown> };
				}) => ({
					childConversationId: "agent:main:main",
					childRunId: input.childRunId,
					status: "queued" as const,
				}),
			);
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent:
						"I prepared a delegation to CTO. It is not dispatched yet; approve this Home run to dispatch the work order.",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "The operator asked for an approval-held delegation.",
						risk: "medium" as const,
						confidence: 0.9,
						effortClass: "single_read" as const,
						answer: null,
						targetTediId: "tedi-cto-agent",
						targetTediLabel: "CTO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation:
							"A parked pending-approval work item for the CTO.",
					},
					delegation: {
						workOrder: {
							objective:
								"Deliver on this request for the operator: prepare a CTO delegation work order. Do not dispatch CTO yet; park this for approval.",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract:
								"Return: A parked pending-approval work item for the CTO.",
							toolGuidance: ["Use the coding scope"],
							boundaries: ["Stay in-org"],
							sourceContent: source,
							targetTediId: "tedi-cto-agent",
							targetTediLabel: "CTO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "operator explicitly held dispatch for approval",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: source,
				idempotencyKey: "home-deleg-held-approve-1",
			});

			await client.respondApproval({
				runId: "home-deleg-held-approve-1",
				decision: "approve",
				note: "approved parked CTO delegation",
			});

			const dispatch = delegateRunner.mock.calls[0]?.[0];
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(1);
			expect(dispatch).toMatchObject({
				delegateToTediId: "tedi-cto-agent",
				metadata: {
					workItemId: db.workItemRows[0]?.id,
				},
			});
			expect(dispatch?.content).toContain(
				`Work Item: ${db.workItemRows[0]?.id}`,
			);
			expect(dispatch?.content).toContain(
				"Home owns the linked Work Item lifecycle below the model",
			);
			expect(dispatch?.content).toContain(
				"You may read\nWork projects and items",
			);
			expect(dispatch?.content).toContain(
				"Respect the original request's mutation limits exactly",
			);
			expect(dispatch?.childRunId).toContain("home-deleg-held-approve-1");
			expect(dispatch?.content).toContain(
				"Execute the intended delegated task now.",
			);
			expect(dispatch?.content).toContain(
				"Do not create another approval gate",
			);
			expect(dispatch?.content).toContain(
				"Return the completed delegated task result",
			);
			expect(dispatch?.content).not.toContain(
				"Output contract: Return: A parked pending-approval work item",
			);
			expect(dispatch?.metadata.delegationWorkOrder).toMatchObject({
				status: "approved",
				outputContract: expect.stringContaining(
					"Return the completed delegated task result",
				),
				sourceContent: expect.stringContaining("Approved Home delegation"),
			});
			expect(dispatch?.content).toContain(source);
			expect(dispatch?.metadata.delegationWorkOrder?.sourceContent).toContain(
				source,
			);
			// Retry the approved task under a new fenced Attempt. Its original
			// acceptance constraints must survive the stored work order too.
			db.workAttemptRows[0]!.runtimeState = "failed";
			db.workAttemptRows[0]!.finishedAt = new Date().toISOString();
			db.workAttemptRows[0]!.outcome = "failed";
			await client.retryDelegation({ workItemId: db.workItemRows[0]!.id });
			expect(delegateRunner).toHaveBeenCalledTimes(2);
			expect(db.workAttemptRows).toHaveLength(2);
			expect(delegateRunner).toHaveBeenLastCalledWith(
				expect.objectContaining({ content: expect.stringContaining(source) }),
			);
		});

		it("decision reject on a Home delegation recommendation cancels it without dispatching", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
				childRunId: input.childRunId,
				status: "queued" as const,
			}));
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent: "CPO owns this — want me to set up the hand-off?",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "CPO owns product",
						risk: "low" as const,
						confidence: 0.9,
						effortClass: null,
						answer: null,
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation: null,
					},
					delegation: {
						workOrder: {
							objective: "Review the roadmap",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract: "Return a short summary",
							toolGuidance: ["Use the product scope"],
							boundaries: ["Stay in-org"],
							sourceContent: "Have CPO review the roadmap.",
							targetTediId: "tedi-cpo",
							targetTediLabel: "CPO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "target not active",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: "Have CPO review the roadmap.",
				idempotencyKey: "home-deleg-respond-reject-1",
			});

			const result = await client.respondApproval({
				runId: "home-deleg-respond-reject-1",
				decision: "reject",
				note: "not now",
			});

			expect(delegateRunner).not.toHaveBeenCalled();
			expect(result.run).toMatchObject({
				id: "home-deleg-respond-reject-1",
				status: "canceled",
				metadata: {
					homeDelegation: {
						resolutionStatus: "rejected",
						workOrder: { status: "rejected" },
					},
				},
			});
			expect(result.assignments).toEqual([]);
		});

		it("names what the run is waiting on when it is neither a write card nor a plan", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));

			// A completed answer-in-home turn: nothing pending.
			await client.enqueueMessage({
				conversationId: "home:test",
				content: "hello there",
				idempotencyKey: "home-respond-neither-1",
			});
			await expect(
				client.respondApproval({
					runId: "home-respond-neither-1",
					decision: "approve",
				}),
			).rejects.toThrow(/not waiting on an approval/);

			// Unknown run id.
			await expect(
				client.respondApproval({
					runId: "home-respond-missing",
					decision: "reject",
				}),
			).rejects.toThrow(/Home run not found/);
		});
	});
});

describe("kernel enqueue response budget", () => {
	it("charges pre-DO work against the total in-band budget", () => {
		expect(remainingKernelTurnBudgetMs(1_000, 4_500, 10_000)).toBe(6_500);
		expect(remainingKernelTurnBudgetMs(1_000, 12_000, 10_000)).toBe(0);
	});

	it("does not create extra budget when the clock moves backwards", () => {
		expect(remainingKernelTurnBudgetMs(2_000, 1_000, 10_000)).toBe(10_000);
	});
});

describe("kernel DO integration (enqueueMessage kernel path)", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(null);
	});

	/** Real-timer tick so post-ack microtasks/timers settle (no fake timers). */
	function flushAsync(ms = 10) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Minimal contract-valid result the fake DO stub returns. */
	function doTurnResult(runId: string) {
		const at = "2026-06-10T08:00:00.000Z";
		return {
			idempotencyKey: runId,
			conversationId: "home:do",
			status: "needs_delegation" as const,
			run: {
				id: runId,
				organizationId: ORG_ID,
				conversationId: "home:do",
				status: "completed" as const,
				inputMessageId: `${runId}:input`,
				outputMessageId: `${runId}:assistant`,
				delegatedTediId: null,
				childRunId: null,
				startedAt: at,
				completedAt: at,
				createdAt: at,
				updatedAt: at,
				metadata: { source: "kernel.processTurn" },
			},
			homePlan: undefined,
			assistantMessage: {
				id: `${runId}:assistant`,
				organizationId: ORG_ID,
				conversationId: "home:do",
				runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: "FROM THE DO",
				createdAt: at,
				startedAt: at,
				completedAt: at,
			},
			error: undefined,
		};
	}

	it("routes kernel-eligible turns through KERNEL.processTurn and returns its result verbatim", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const processTurn = vi.fn(
			async (input: { runId: string; organizationId: string }) =>
				doTurnResult(input.runId),
		);
		const idFromName = vi.fn(() => "do-id");
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName,
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "what changed today?",
			idempotencyKey: "home-do-success-1",
		});

		// DO keyed by org id; turn input carries the persist-first identity.
		expect(idFromName).toHaveBeenCalledWith(ORG_ID);
		expect(processTurn).toHaveBeenCalledTimes(1);
		const turnInput = processTurn.mock.calls[0]?.[0] as {
			runId: string;
			userMessageId: string;
			content: string;
		};
		expect(turnInput.runId).toBe("home-do-success-1");
		expect(turnInput.userMessageId).toBe("home-do-success-1:input");
		expect(turnInput.content).toBe("what changed today?");
		// Do result returned verbatim; inline turn body did not run.
		expect(result.assistantMessage?.content).toBe("FROM THE DO");
		expect(inlineKernel).not.toHaveBeenCalled();
		// Persist-first inserts stayed in enqueueMessage (run row durable
		// before the DO call) — the fake DO never wrote anything.
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-do-success-1");
		expect(db.runs[0]?.status).toBe("running");
	});

	it("acks immediately when the DO returns the async-dispatch sentinel (KERNEL_ASYNC_PLANNER)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		// processTurn returns the async sentinel: under KERNEL_ASYNC_PLANNER the DO
		// scheduled the planner off its turn body instead of running it inline.
		const processTurn = vi.fn(async () => ({ kernelAsyncDispatched: true }));
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "dump idea one",
			idempotencyKey: "home-async-1",
		});

		expect(processTurn).toHaveBeenCalledTimes(1);
		// Ack path: the run id is the real persist-first run, status queued, no
		// answer yet (the caller polls task.id), and the inline body never ran.
		expect(result.status).toBe("queued");
		expect(result.run.id).toBe("home-async-1");
		expect(result.run.status).toBe("running");
		expect(result.assistantMessage).toBeUndefined();
		expect(inlineKernel).not.toHaveBeenCalled();
		// Persist-first run row durable before the DO call.
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-async-1");
	});

	it("falls back to the inline turn body when the DO stub throws", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const processTurn = vi.fn(async () => {
			throw new Error("durable object unavailable");
		});
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => ({
			assistantContent: "INLINE FALLBACK",
			route: {
				routeKind: "answer_directly" as const,
				rationale: "Direct answer.",
				risk: "low" as const,
				confidence: 0.9,
			},
		}));
		kernelRuntimeTestHooks.setKernelForTest(
			inlineKernel as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "what changed today?",
			idempotencyKey: "home-do-fallback-1",
		});

		expect(processTurn).toHaveBeenCalledTimes(1);
		expect(inlineKernel).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage?.content).toBe("INLINE FALLBACK");
		// Inline turn body completed the run (running → completed patch).
		expect(db.runs[0]?.status).toBe("completed");
		const inlineRunMetadata = db.runs[0]?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(inlineRunMetadata).toBeDefined();
		expect(inlineRunMetadata?.kernelRoute).toMatchObject({
			routeKind: "answer_directly",
		});
	});

	it("returns the soft-deadline ack (real run id, contract-valid status) when the DO turn outlives the deadline", async () => {
		kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(25);
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		let resolveTurn!: (value: ReturnType<typeof doTurnResult>) => void;
		const processTurn = vi.fn(
			() =>
				new Promise<ReturnType<typeof doTurnResult>>((resolve) => {
					resolveTurn = resolve;
				}),
		);
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "slow turn that outlives the soft deadline",
			idempotencyKey: "home-do-deadline-1",
		});

		// Ack shape: top-level status "queued" (the output enum has no
		// "running"), run still "running" with the real run id so the MCP task
		// linkage (task.id = run.id) attaches, kernel-owned metadata null (the
		// DO patches kernelRoute/kernelEvidence on completion), no assistantMessage.
		expect(result.status).toBe("queued");
		expect(result.run.id).toBe("home-do-deadline-1");
		expect(result.run.status).toBe("running");
		expect(result.run.completedAt).toBeNull();
		expect(result.run.metadata).toMatchObject({
			kernelRoute: null,
			kernelEvidence: null,
		});
		expect(result.run.progress?.label).toBe("Running");
		expect(result.assistantMessage).toBeUndefined();
		// Persist-first state at ack time: the run row is durable and still
		// "running" (the fake DO never wrote anything).
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.id).toBe("home-do-deadline-1");
		expect(db.runs[0]?.status).toBe("running");
		expect(inlineKernel).not.toHaveBeenCalled();

		// The dangling stub promise resolving after the ack does nothing: no
		// inline re-run, no extra writes — the DO owns the turn now.
		const eventCountAtAck = db.events.length;
		resolveTurn(doTurnResult("home-do-deadline-1"));
		await Promise.all(context.waitUntilPromises);
		await flushAsync();
		expect(inlineKernel).not.toHaveBeenCalled();
		expect(db.events).toHaveLength(eventCountAtAck);
		expect(db.runs[0]?.status).toBe("running");
	});

	it("does not re-run inline (and surfaces no unhandled rejection) when the DO rejects after the deadline", async () => {
		kernelRuntimeTestHooks.setKernelTurnSoftDeadlineForTest(25);
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		let rejectTurn!: (reason: unknown) => void;
		const processTurn = vi.fn(
			() =>
				new Promise<ReturnType<typeof doTurnResult>>((_resolve, reject) => {
					rejectTurn = reject;
				}),
		);
		(context.env as Record<string, unknown>).KERNEL = {
			idFromName: vi.fn(() => "do-id"),
			get: vi.fn(() => ({ processTurn })),
		};
		const inlineKernel = vi.fn(async () => null);
		kernelRuntimeTestHooks.setKernelForTest(inlineKernel);

		const client = createKernelRuntimeClient(context);
		const result = await client.enqueueMessage({
			conversationId: "home:do",
			content: "slow turn whose DO later fails",
			idempotencyKey: "home-do-late-error-1",
		});

		expect(result.status).toBe("queued");
		expect(result.run.id).toBe("home-do-late-error-1");
		expect(inlineKernel).not.toHaveBeenCalled();
		const eventCountAtAck = db.events.length;

		// A late rejection (after the deadline ack) must not trigger the inline
		// fallback — the ack already told the caller to poll, and the turn may
		// have partially completed under the DO. The dangling promise is
		// swallowed (vitest fails the test on unhandled rejections).
		rejectTurn(new Error("late durable object failure"));
		await Promise.all(context.waitUntilPromises);
		await flushAsync();
		expect(inlineKernel).not.toHaveBeenCalled();
		expect(processTurn).toHaveBeenCalledTimes(1);
		// Fake db untouched beyond the persist-first inserts captured at ack.
		expect(db.events).toHaveLength(eventCountAtAck);
		expect(db.runs).toHaveLength(1);
		expect(db.runs[0]?.status).toBe("running");
	});
});

describe("governance policy: fan-out cap and approval TTL", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
	});

	it("blocks auto-dispatch when maxDelegationsPerTurn=1 (dispatch tool counts as the 1 slot)", async () => {
		// maxDelegationsPerTurn=1 means the dispatch tool itself fills the only slot;
		// no child spawns are allowed. This is the kill-switch equivalent of a
		// spawn_bounds.max_dispatches_per_turn cap enforced with the spawn
		// tool counted. The turn must fail rather than silently drop the dispatch.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 1 },
					},
					// status is checked via where clause; mock returns all rows so include it
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Dispatching CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason: "authorized",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this task.",
			idempotencyKey: "fan-out-blocked-1",
		});

		// The dispatch must be blocked (fail-closed, not silently dropped).
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result.status).toBe("failed");
		expect(result.run.status).toBe("failed");
		expect(db.runs[0]?.status).toBe("failed");
		// Error recorded on the auto-dispatch metadata, with the spawn-bound
		// counting + "fan out in waves" guidance (change 2).
		expect(db.runs[0]?.metadata).toMatchObject({
			homeAutoDispatch: {
				status: "failed",
				error: expect.stringContaining("fan-out cap reached"),
			},
		});
		const capError = (
			db.runs[0]?.metadata as {
				homeAutoDispatch?: { error?: string };
			}
		)?.homeAutoDispatch?.error;
		expect(capError).toContain("counts the dispatch spawn itself");
		expect(capError).toContain("fan out in waves");
	});

	it("boot_unavailable verdict makes NO dispatch call, NO approval row, and persists the refusal", async () => {
		// Change 1 turn-level proof: a cold embodied target yields boot_unavailable.
		// The turn must refuse — never enqueue a child (the cold-503 failure) and
		// never open an approval card — but still record the refusal evidence.
		const db = createKernelRuntimeDb();
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO's workstation is cold.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: null,
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: WORKSTATION_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: false,
						mode: "boot_unavailable",
						reason:
							"target body is cold — no running body or warm workstation lease; refusing dispatch",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this task.",
			idempotencyKey: "boot-unavailable-1",
		});

		// No child dispatch was attempted (the whole point of boot_unavailable).
		expect(delegateRunner).not.toHaveBeenCalled();
		// No approval card opened — boot_unavailable is a refusal, not a decision
		// request.
		expect(db.approvals).toHaveLength(0);
		// The refusal is persisted as durable delegation evidence on the run.
		const meta = db.runs[0]?.metadata as {
			homeDelegation?: { decision?: { mode?: string; reason?: string } };
			homeAutoDispatch?: unknown;
		};
		expect(meta?.homeDelegation?.decision?.mode).toBe("boot_unavailable");
		expect(meta?.homeDelegation?.decision?.reason).toContain("cold");
		// No auto-dispatch metadata was written (no spawn was made or failed).
		expect(meta?.homeAutoDispatch ?? null).toBeNull();
	});

	it("allows auto-dispatch when maxDelegationsPerTurn=2 (cap covers the spawn tool + 1 child)", async () => {
		// cap=2: dispatch tool = 1, one child = 1 → total 2, within budget.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 2 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Dispatching CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns this.",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "embodied" as const,
					answer: "Delegating to CPO.",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Handle task.",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return result.",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Task content.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: true,
						mode: "auto",
						reason: "authorized",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Ask CPO to handle this.",
			idempotencyKey: "fan-out-allowed-1",
		});

		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("queued");
		expect(result.run.status).toBe("queued");
	});

	it("blocks plan assignment dispatch when selected assignments exceed cap budget", async () => {
		// maxDelegationsPerTurn=2 → allows 1 child dispatch (cap - 1 = 1 for approval action).
		// A plan with 2 assignments should be blocked.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 2 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		// Seed a proposed run with 2-assignment Home plan.
		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.",
			idempotencyKey: "fan-out-plan-cap-1",
		});

		expect(proposed.homePlan?.assignments).toHaveLength(2);

		// Attempting to dispatch both assignments (2) with cap=2 allows budget of 1
		// child (cap - 1 approval action = 1). 2 > 1 → should throw.
		await expect(
			client.approvePlanAssignments({
				runId: "fan-out-plan-cap-1",
				approvalNote: "trying to dispatch 2 assignments past cap",
			}),
		).rejects.toThrow(/fan-out cap reached/);
	});

	it("allows plan assignment dispatch within cap budget", async () => {
		// maxDelegationsPerTurn=3 → allows 2 child dispatches (cap - 1 = 2).
		// A plan with 2 assignments should succeed.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { maxDelegationsPerTurn: 3 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: `child:${input.childRunId}`,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const proposed = await client.enqueueMessage({
			conversationId: "home:test",
			content:
				"Plan this across CPO and Echo: CPO owns the launch plan while Echo validates the data.",
			idempotencyKey: "fan-out-plan-ok-1",
		});

		expect(proposed.homePlan?.assignments).toHaveLength(2);

		const approved = await client.approvePlanAssignments({
			runId: "fan-out-plan-ok-1",
			approvalNote: "Dispatching 2 assignments within cap=3",
		});

		await Promise.all(context.waitUntilPromises);
		expect(approved.assignments).toHaveLength(2);
		expect(approved.assignments.every((a) => a.status === "queued")).toBe(true);
		expect(delegateRunner).toHaveBeenCalledTimes(2);
	});

	it("approval TTL respects configurable window from governance policy", async () => {
		// approvalTtlHours=48 means the write approval expires 48h from creation.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: { approvalTtlHours: 48 },
					},
					status: "active",
				} as PolicyPackRow,
			],
		});
		const context = createContext(db, { userSub: "operator-1" });
		const client = createKernelRuntimeClient(context);

		// Stub a propose_tool_write route to trigger write approval creation.
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "I'll update the invoice.",
				route: {
					routeKind: "propose_tool_write" as const,
					rationale: "Update invoice 42.",
					risk: "medium" as const,
					confidence: 0.85,
					effortClass: "cognitive" as const,
					answer: "Will update invoice 42 on globex.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: {
						appSlug: "globex",
						capability: "update_invoice",
						connectionStatus: "connected" as const,
					},
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
					writeIntent: {
						appSlug: "globex",
						toolName: "update_invoice",
						args: { invoiceId: "42", status: "paid" },
						rationale: "Marking invoice 42 as paid.",
					},
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		// Stub the write proposal planner to return a concrete proposal.
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => ({
				appSlug: "globex",
				toolName: "update_invoice",
				args: { invoiceId: "42", status: "paid" },
				rationale: "Marking invoice 42 as paid.",
			})),
		);

		// Need an anchor tedi for write approval. Add one to the tedi rows.
		db.tediRows.push({
			runtimeStatus: null,
			displayName: "Anchor",
			id: "tedi-anchor",
			name: "Anchor",
			organizationId: ORG_ID,
			runtimeKind: "agent",
			slug: "anchor",
		});

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Update invoice 42 to paid on globex.",
			idempotencyKey: "approval-ttl-test-1",
		});

		// The run should be parked for approval.
		expect(result.status).toBe("requires_approval");

		// Check that the approval row has a 48-hour expiry window.
		const approvalRow = db.approvals.find(
			(approval) => approval.actionType === "home.tool_write",
		);
		expect(approvalRow).toBeDefined();
		if (approvalRow) {
			const created = new Date(approvalRow.createdAt).getTime();
			const expires = new Date(approvalRow.expiresAt).getTime();
			const windowHours = (expires - created) / (1000 * 60 * 60);
			// Configurable 48-hour window (not the default 24h).
			expect(windowHours).toBeCloseTo(48, 0);
		}
	});
});

describe("home plan generalization (kernel-evals plan.multi_tedi_work_items)", () => {
	const target = (slug: string, displayName: string): HomePlanningTarget =>
		({
			displayName,
			id: `t-${slug}`,
			name: displayName,
			runtimeKind: "agent",
			runtimeState: null,
			slug,
			status: "active",
		}) as unknown as HomePlanningTarget;
	const roster = [
		target("cpo", "CPO"),
		target("cmo", "CMO"),
		target("ceo", "CEO"),
		target("research", "Research"),
	];

	it("detects a plan request without the old hardcoded CPO+Echo names", () => {
		// The original gate required both "cpo" and "echo"; now any plan-intent
		// phrasing qualifies (the >=2-named-tedis gate lives in selection).
		expect(
			detectsHomePlanningRequest("Plan and split this across the teams"),
		).toBe(true);
		expect(
			detectsHomePlanningRequest("Coordinate the rollout across two owners"),
		).toBe(true);
		expect(detectsHomePlanningRequest("What's the status of the launch?")).toBe(
			false,
		);
	});

	it("clamps a long LLM objective to the dispatch bound (plan v1)", () => {
		const short = "Review the deploy pipeline and flag release risks.";
		expect(clampPlanObjective(short)).toBe(short);
		const clamped = clampPlanObjective("x".repeat(900));
		expect(clamped.length).toBe(600);
		expect(clamped.endsWith("…")).toBe(true);
	});

	it("selects EVERY named tedi, not just CPO/Echo", () => {
		const picked = selectedHomePlanTargets({
			content:
				"Plan a launch brief: have CPO draft the product section and CMO draft go-to-market.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cpo", "cmo"]);
	});

	it("works for an arbitrary pair (CEO + Research) the old hardcode could never plan", () => {
		const picked = selectedHomePlanTargets({
			content: "Coordinate this across CEO and Research — split the analysis.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug).sort()).toEqual(["ceo", "research"]);
	});

	it("declines (<2) when fewer than two tedis are named — no fabricated owners", () => {
		expect(
			selectedHomePlanTargets({
				content: "Have CPO own the whole launch.",
				targets: roster,
			}).map((t) => t.slug),
		).toEqual(["cpo"]);
		expect(
			selectedHomePlanTargets({
				content: "Plan the launch carefully.",
				targets: roster,
			}),
		).toEqual([]);
	});

	// Fix #15 — single explicitly-named target must not fan out.
	// When a single strong (slug-token) match is present, all weak-only matches
	// are suppressed so "ask the CTO to …" returns only the CTO tedi even when
	// another tedi's display-name contains an incidental prose word match.
	it("single strong target: does not fan out to weak-match tedis", () => {
		// Extend the roster with a tedi whose display-name contains "bench" — a
		// word that can appear in prose without the operator naming that tedi.
		// With the stopword addition "bench" is now filtered, so this also covers
		// the stopword fix. Add a tedi whose display-name contains "tedix" too.
		const extendedRoster = [
			...roster,
			target("bench", "Tedix Bench"), // "bench" in display-name (stopworded)
		];
		const picked = selectedHomePlanTargets({
			content: "Ask the CPO to review the deploy benchmark results.",
			targets: extendedRoster,
		});
		// "benchmark" contains "bench" but bench tedi's slug "bench" is now
		// stopworded. CPO (strong slug token "cpo") is the only match.
		expect(picked.map((t) => t.slug)).toEqual(["cpo"]);
	});

	it("single strong target: collapses fan-out when exactly one slug matches strongly", () => {
		// Build a roster where "cpo" strongly matches, but there's also a tedi
		// whose display-name is "Product Operations" — "product" might weakly match
		// the word "product" in the sentence without the operator naming that tedi.
		const mixedRoster = [...roster, target("prodops", "Product Operations")];
		const picked = selectedHomePlanTargets({
			content: "Ask the CPO to review the product roadmap.",
			targets: mixedRoster,
		});
		// "cpo" slug strongly names one target (CPO); "prodops" display-name
		// "Product Operations" may weakly match "product" in the sentence.
		// With dominance rule: only CPO is returned.
		const slugs = picked.map((t) => t.slug);
		expect(slugs).toContain("cpo");
		expect(slugs.length).toBe(1);
	});

	it("does not mistake an interview pilot for the System 1 Pilot tedi", () => {
		const extendedRoster = [
			...roster,
			target("system1-pilot", "System 1 Pilot (Workers AI 70B)"),
		];
		const picked = selectedHomePlanTargets({
			content:
				"Delegate this bounded GTM brief to CMO for a four-week interview pilot; no other tedi is needed.",
			targets: extendedRoster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cmo"]);
	});

	it("still recognizes the System 1 Pilot tedi when explicitly named", () => {
		const extendedRoster = [
			...roster,
			target("system1-pilot", "System 1 Pilot (Workers AI 70B)"),
		];
		const picked = selectedHomePlanTargets({
			content: "Plan a CMO brief and ask System 1 Pilot to review it.",
			targets: extendedRoster,
		});
		expect(picked.map((t) => t.slug)).toEqual(["cmo", "system1-pilot"]);
	});

	it("two strong targets: keeps both (no false collapse)", () => {
		const picked = selectedHomePlanTargets({
			content: "Have CPO draft the product brief and CEO review the budget.",
			targets: roster,
		});
		expect(picked.map((t) => t.slug).sort()).toEqual(["ceo", "cpo"]);
	});
});

/**
 * Local mirror of the Tedix OS consumer's `unwrapStructuredPayload`. The producer
 * cannot import the separate frontend repository, so we re-derive
 * the same accept gate the Tedix OS applies to a `Raw result: …` preview and assert
 * the emitted envelope round-trips through it — proving the delegation receipt
 * will yield a card-bearing `output` on the Tedix OS side.
 */
function tedixOsUnwrapStructuredPayload(output: unknown): unknown {
	if (typeof output !== "string") return null;
	let rest = output.trim();
	if (!rest) return null;
	let hadWrapper = false;
	const prefix = /^raw result\s*:\s*/i.exec(rest);
	if (prefix) {
		rest = rest.slice(prefix[0].length).trim();
		hadWrapper = true;
	}
	if (rest.startsWith("```")) {
		const fence =
			/^```[ \t]*(?:json|jsonc|json5)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(rest);
		if (!fence) return null;
		rest = (fence[1] ?? "").trim();
		hadWrapper = true;
	} else {
		const inline = /^(`{1,2})([\s\S]*?)\1$/.exec(rest);
		if (inline) {
			rest = (inline[2] ?? "").trim();
			hadWrapper = true;
		}
	}
	if (!hadWrapper) return null;
	const first = rest[0];
	if (first !== "{" && first !== "[") return null;
	try {
		const parsed = JSON.parse(rest) as unknown;
		return parsed === null || typeof parsed !== "object" ? null : parsed;
	} catch {
		return null;
	}
}

describe("childRunPreview structured-result envelope (Tedix OS Phase D)", () => {
	const project = kernelRuntimeTestHooks.childRunPreviewFromEventsForTest;

	function toolCompletedRow(payload: Record<string, unknown> | null) {
		return childRuntimeEvent({
			createdAt: "2026-06-18T00:00:01.000Z",
			id: "child-tool-completed",
			kind: "tool.completed",
			payload,
			runId: "child-run-1",
			tediId: "tedi-cto",
		});
	}

	function messageCompletedRow(content: string) {
		return childRuntimeEvent({
			createdAt: "2026-06-18T00:00:02.000Z",
			id: "child-message-completed",
			kind: "message.completed",
			payload: { role: "assistant", content },
			runId: "child-run-1",
			tediId: "tedi-cto",
		});
	}

	it("prefers the child's prose final message over a structured tool.completed payload", () => {
		// The tedi's own conclusion is the operator-facing answer — an
		// intermediate tool payload (test results, discovery listing) must not
		// bury it. The structured envelope survives as evidence, not as the
		// message preview.
		const data = {
			passed: 12,
			failed: 1,
			skipped: 0,
			total: 13,
			failing: [{ name: "auth › rejects expired token", status: "failed" }],
		};
		// Rows are stored newest-first (desc createdAt), matching the reader.
		const preview = project(
			[
				messageCompletedRow("Ran the suite — see results."),
				toolCompletedRow({ data }),
			],
			"Ran the suite — see results.",
		);
		expect(preview).toBe("Ran the suite — see results.");
	});

	it("emits the canonical envelope for a structured tool.completed payload when the child produced no message", () => {
		const data = {
			passed: 12,
			failed: 1,
			skipped: 0,
			total: 13,
			failing: [{ name: "auth › rejects expired token", status: "failed" }],
		};
		const preview = project([toolCompletedRow({ data })], null);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
		);
		// The exact envelope the Tedix OS consumer unwraps back to the structured value.
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(data);
	});

	it("lights the card from an agent-runtime tool.completed `payload.result` JSON string (no `data`, no message)", () => {
		// The agent runtime's MCP-client emitter (`recordToolEvent`) carries the raw
		// tool output as a JSON string under `payload.result`, never `payload.data`
		// (verified against the prod ledger). The `data ?? result` fallback must light
		// the same canonical envelope so message-less delegated tool work is not dark.
		const data = {
			results: [{ id: "fact-1", summary: "Tedix ships autonomous workers" }],
			total: 1,
		};
		const preview = project(
			[
				toolCompletedRow({
					name: "tedix_mcp_code",
					result: JSON.stringify(data),
				}),
			],
			null,
		);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
		);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(data);
	});

	it("emits the canonical envelope when the final assistant message IS structured JSON (plan card)", () => {
		const plan = {
			title: "Launch checklist",
			steps: [
				{ label: "Draft RFC", status: "completed" },
				{ label: "Ship canary", status: "in_progress" },
			],
		};
		const content = JSON.stringify(plan);
		const preview = project([messageCompletedRow(content)], content);
		expect(preview).toBe(`Raw result: \`\`\`json\n${content}\n\`\`\``);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(plan);
	});

	it("unwraps a fenced ```json final message into the canonical envelope", () => {
		const obj = { ok: true, count: 3 };
		const content = `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
		const preview = project([messageCompletedRow(content)], content);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(obj);
	});

	it("keeps prose unchanged for a genuinely unstructured result — never fake JSON", () => {
		const prose = "I finished the assignment and shipped the canary.";
		const preview = project([messageCompletedRow(prose)], prose);
		expect(preview).toBe(prose);
		expect(tedixOsUnwrapStructuredPayload(preview)).toBeNull();
	});

	it("does not wrap a partial/malformed JSON-looking string", () => {
		const broken = '{"steps": [{"label": "Draft RFC"';
		const preview = project([messageCompletedRow(broken)], broken);
		expect(preview).toBe(broken);
		expect(tedixOsUnwrapStructuredPayload(preview)).toBeNull();
	});

	// ── Fix 1: DESC-mispick ────────────────────────────────────────────────────

	it("multi-tool DESC-mispick: picks the STRUCTURED earlier result, not the most-recent error", () => {
		// Rows are DESC-createdAt. The most-recent tool.completed is an error;
		// the earlier one is a structured object. Fix 1 must skip the error and
		// return the structured envelope — not the raw "Execution error:" string.
		const structuredData = {
			results: [{ id: "fact-1", summary: "Tedix ships autonomous workers" }],
			total: 1,
		};
		const errorRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:03.000Z", // most recent
			id: "child-tool-error",
			kind: "tool.completed",
			payload: { name: "search", result: "Execution error: scope timeout" },
			runId: "child-run-multi",
			tediId: "tedi-cto",
		});
		const structuredRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:02.000Z", // earlier
			id: "child-tool-structured",
			kind: "tool.completed",
			payload: {
				name: "memory_search",
				result: JSON.stringify(structuredData),
			},
			runId: "child-run-multi",
			tediId: "tedi-cto",
		});
		// DESC order: error row is first
		const preview = project([errorRow, structuredRow], null);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(structuredData)}\n\`\`\``,
		);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(structuredData);
	});

	it("tool-error-only run with no prose preview produces a humanized one-liner, not raw engine internals", () => {
		// All tool.completed rows are error strings, rawPreview is null.
		// The preview must be "Tool step errored: …", not the raw "Execution error:" string.
		const errorRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:01.000Z",
			id: "child-tool-error-only",
			kind: "tool.completed",
			payload: {
				name: "exec",
				result:
					"Execution error: POST https://api.internal.cf.dev/v1/run timed out after 30000ms",
			},
			runId: "child-run-error-only",
			tediId: "tedi-cto",
		});
		const preview = project([errorRow], null);
		expect(typeof preview).toBe("string");
		expect(preview).toMatch(/^Tool step errored:/);
		// Must not contain raw POST URL or Execution error prefix.
		expect(preview).not.toMatch(/^Execution error:/);
		expect(preview).not.toMatch(/POST https?:\/\//);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 & 4: run.failed humanized preview + structured-tool hasSubstantive gate
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeChildRuntimeEvents legibility fixes", () => {
	// Fix 2: run.failed with runtime_dropped reason
	it("run.failed payload.reason='runtime_dropped' → humanized operator-facing preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-dropped";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed-dropped",
				kind: "run.failed",
				payload: { reason: "runtime_dropped" },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunStatus).toBe("failed");
		// Preview must be the humanized string, not null or a raw payload dump.
		expect(summary?.childRunPreview).toBe(
			"The tedi runtime dropped this run before it finished — retry.",
		);
	});

	it("run.failed recovery_exhausted/out_of_memory → humanized operator-facing preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-recovery-oom";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:15:00.000Z",
				id: "child-run.failed-oom",
				kind: "run.failed",
				payload: {
					reason: "recovery_exhausted",
					error: "chat recovery exhausted: out_of_memory",
					recovery: { reason: "out_of_memory" },
				},
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
		expect(summary?.childRunPreview).toBe(
			"The tedi exceeded the Durable Object memory limit while recovering this turn.",
		);
	});

	// Fix 2: run.failed with a message containing a raw POST URL
	it("run.failed with raw Cloudflare POST URL in message → stripped preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-cf-error";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed-cf",
				kind: "run.failed",
				payload: {
					reason: "network_error",
					message:
						"Agent unreachable\nPOST https://agents-internal.cf.dev/v1/dispatch\n503 Service Unavailable",
				},
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
		const preview = summary?.childRunPreview as string;
		expect(preview).not.toMatch(/POST https?:\/\//);
		expect(preview).not.toMatch(/503/);
		expect(preview).toMatch(/Agent unreachable/);
	});

	// Fix 4: structured-tool-only success is not downgraded to "failed"
	it("structured-tool-only success (tool.completed object, no message.completed) → status=completed, hasSubstantive=true", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-tool-only";
		const structuredData = { answer: 42, unit: "widgets" };
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.completed",
				kind: "run.completed",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:58.000Z",
				id: "child-tool-only",
				kind: "tool.completed",
				payload: { name: "compute", result: JSON.stringify(structuredData) },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		// Must not be downgraded to "failed" by the disposition gate.
		expect(summary?.childRunStatus).toBe("completed");
		// Preview must be the structured envelope.
		const preview = summary?.childRunPreview as string;
		expect(preview).toMatch(/^Raw result:/);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(structuredData);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// latestActivityLabel — live-panel "calling <tool>" surface
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeChildRuntimeEvents — latestActivityLabel (CLI live panel)", () => {
	const TEDI_ID = "tedi-cto";
	const RUN_ID = "child-run-activity";

	it("tool.started as latest event → childRunLatestActivityLabel='calling <tool>'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		// DESC order: tool.started is the most recent event (run still in-flight).
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:02.000Z",
				id: "child-tool-started",
				kind: "tool.started",
				payload: { name: "workers_builds_list_builds", arguments: {} },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe(
			"calling workers_builds_list_builds",
		);
	});

	it("tool.completed as latest event → childRunLatestActivityLabel='calling <tool>'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:03.000Z",
				id: "child-tool-completed",
				kind: "tool.completed",
				payload: { name: "firecrawl_scrape", result: "done", latencyMs: 800 },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-2",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe(
			"calling firecrawl_scrape",
		);
	});

	it("message.delta as latest event → childRunLatestActivityLabel='responding…'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:04.000Z",
				delta: "The deploy run shows…",
				id: "child-msg-delta",
				kind: "message.delta",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-3",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe("responding…");
	});

	it("run.started → childRunLatestActivityLabel='thinking…' (widened Part B)", async () => {
		// After Part B widening, run.started maps to "thinking…" instead of null.
		// This pins the new correct behavior so regressions are caught.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-4",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe("thinking…");
	});

	it("running run with tool.started → progress.detail='calling <tool>' (not event count)", async () => {
		const db = createKernelRuntimeDb();
		const RUN_ROW_ID = "home-run-with-child";
		const CHILD_TEDI = "tedi-cto-agent";
		// Seed a kernel run row that delegates to CHILD_TEDI / RUN_ID.
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: RUN_ROW_ID,
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: CHILD_TEDI,
				childRunId: RUN_ID,
				createdAt: "2026-06-22T10:00:00.000Z",
				updatedAt: "2026-06-22T10:00:02.000Z",
			}),
		);
		// Seed child runtime events: run.started then tool.started (tool.started is
		// the most recent — rows are stored in insertion order but the query is DESC
		// by createdAt, so push latest createdAt last and let the mock sort them).
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-progress",
				kind: "run.started",
				runId: RUN_ID,
				tediId: CHILD_TEDI,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:02.000Z",
				id: "child-tool-started-progress",
				kind: "tool.started",
				payload: { name: "workers_builds_list_builds", arguments: {} },
				runId: RUN_ID,
				tediId: CHILD_TEDI,
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = result.runSet.runs.find((r) => r.id === RUN_ROW_ID);
		expect(run).not.toBeUndefined();
		// The live-panel reads progress.detail as the activity string.
		// It must show "calling workers_builds_list_builds", not "2 runtime events recorded".
		expect(run?.progress.detail).toBe("calling workers_builds_list_builds");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// latestActivityLabelFromEventsForTest — direct unit tests for Part B widened
// event kinds. Tests the new labels that were not previously matched:
//   run.started → "thinking…"
//   context.injected → "loading context…"
//   artifact.created → "writing <name>"
//   subagent.started → "delegating…"
//   message.completed (no run.completed yet) → "wrapping up…"
// ─────────────────────────────────────────────────────────────────────────────

describe("latestActivityLabelFromEvents — widened Part B event kinds", () => {
	const fn = kernelRuntimeTestHooks.latestActivityLabelFromEventsForTest;

	function makeEvent(
		kind: string,
		payload?: Record<string, unknown>,
	): (typeof import("@tedix/db/schema"))["tediRuntimeEvents"]["$inferSelect"] {
		return {
			id: `evt-${kind}`,
			tediId: "tedi-cto",
			runId: "run-1",
			organizationId: "org-1",
			conversationId: "home:main",
			kind: kind as Parameters<typeof fn>[0][number]["kind"],
			payload: payload ?? null,
			delta: null,
			messageId: null,
			createdAt: "2026-06-22T10:00:00.000Z",
			runtime: null,
			runtimeMetadata: null,
		} as Parameters<typeof fn>[0][number];
	}

	it("run.started as latest event → 'thinking…'", () => {
		expect(fn([makeEvent("run.started")])).toBe("thinking…");
	});

	it("context.injected as latest event → 'loading context…'", () => {
		expect(fn([makeEvent("context.injected")])).toBe("loading context…");
	});

	it("artifact.created with named payload → 'writing <name>'", () => {
		expect(
			fn([
				makeEvent("artifact.created", { artifact: { name: "turn_summary" } }),
			]),
		).toBe("writing turn_summary");
	});

	it("artifact.created with long name → truncated to 35 chars with ellipsis", () => {
		const longName = "a".repeat(40);
		const result = fn([
			makeEvent("artifact.created", { artifact: { name: longName } }),
		]);
		expect(result).toBe(`writing ${"a".repeat(35)}…`);
	});

	it("artifact.created with no name in payload → 'writing artifact' fallback", () => {
		expect(fn([makeEvent("artifact.created", {})])).toBe("writing artifact");
	});

	it("subagent.started as latest event → 'delegating…'", () => {
		expect(fn([makeEvent("subagent.started")])).toBe("delegating…");
	});

	it("message.completed as latest event → 'wrapping up…'", () => {
		// message.completed before any run.completed = the run is still settling.
		expect(fn([makeEvent("message.completed", { content: "Done." })])).toBe(
			"wrapping up…",
		);
	});

	it("message.received as latest event → 'reading the task'", () => {
		expect(fn([makeEvent("message.received")])).toBe("reading the task");
	});

	it("message.progress as latest event → 'synthesizing…' (T1.1 heartbeat)", () => {
		// The T1.1 mid-round heartbeat emits message.progress while the model is
		// composing its reply (post-tool, pre-message.delta). The live panel must
		// read "synthesizing…" instead of freezing on the last tool name.
		expect(fn([makeEvent("message.progress", { round: 1 })])).toBe(
			"synthesizing…",
		);
	});

	it("tool.started newer than message.progress — tool.started wins (still 'calling')", () => {
		// Heartbeat must not override an actively-running tool: DESC order, newest
		// (tool.started) matches first.
		expect(
			fn([
				makeEvent("tool.started", { name: "firecrawl_scrape" }),
				makeEvent("message.progress", { round: 1 }),
			]),
		).toBe("calling firecrawl_scrape");
	});

	it("run.started older than tool.started — tool.started wins (DESC order, first match)", () => {
		// In DESC order (newest first): tool.started (t=2) is before run.started (t=1).
		expect(
			fn([
				makeEvent("tool.started", { name: "firecrawl_scrape" }),
				makeEvent("run.started"),
			]),
		).toBe("calling firecrawl_scrape");
	});

	it("only run.completed present (terminal run) → null (run is done, no in-progress label)", () => {
		// run.completed is not in the widened set, so it falls through to null.
		expect(fn([makeEvent("run.completed")])).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// readSingleChildRunSummary — crash-lease sweep self-heal
// ─────────────────────────────────────────────────────────────────────────────

describe("readSingleChildRunSummary", () => {
	const TEDI_ID = "tedi-cto";
	const CHILD_RUN_ID = "child-run-1";

	it("returns completed summary when child has a run.completed event with substantive content", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.completed",
				kind: "run.completed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:50.000Z",
				id: "child-msg.completed",
				kind: "message.completed",
				delta: "Firecrawl scrape completed — 12 pages extracted.",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunStatus).toBe("completed");
		expect(typeof summary?.childRunPreview).toBe("string");
		expect(
			(summary?.childRunPreview as string | undefined)?.length,
		).toBeGreaterThan(0);
	});

	it("keeps a workstation subprocess artifact non-terminal when run.completed is missing", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-artifact-terminal",
				kind: "artifact.created",
				payload: {
					artifact: {
						name: "workstation_process/install/evidence.json",
						metadata: {
							source: "workstation_process",
							processId: "install",
							eventType: "workstation.process.completed",
							exitCode: 0,
						},
					},
				},
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:00.000Z",
				id: "child-run.started",
				kind: "run.started",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toMatchObject({
			childRunStatus: "running",
			childRunLatestEventKind: "artifact.created",
			childRunTerminalAt: null,
			childRunTerminalEventKind: null,
		});
		expect(summary?.childRunPreview).toContain("process install completed");
	});

	it("returns failed summary when child has a run.completed event but NO substantive content (disposition gate)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-bare-completed",
				kind: "run.completed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).not.toBeNull();
		// Disposition gate: bare run.completed with no substantive result is "failed",
		// so the crash-terminalization branch should not self-heal to completed.
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("returns failed summary when child has a run.failed event", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed",
				kind: "run.failed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("returns null when the child has no events", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toBeNull();
	});

	it("fail-soft: returns null on DB error", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.controls.childRuntimeSelectError = new Error("D1 unavailable");
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toBeNull();
	});
});

describe("explicitDelegationNeedsEmbodiedSurface (native-vs-workstation gate)", () => {
	it("defaults to NATIVE when no embodiment signal is present", () => {
		// A plain operator delegation ("report git HEAD", a remote-MCP read) carries
		// only `source`/`operator` metadata — no embodied need. Must stay native.
		expect(explicitDelegationNeedsEmbodiedSurface(undefined)).toBe(false);
		expect(explicitDelegationNeedsEmbodiedSurface(null)).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface({
				source: "os.home",
				operator: { id: "u1", email: "operator@example.com" },
			}),
		).toBe(false);
	});

	it("requires the embodied surface when the caller stamps an explicit signal", () => {
		expect(
			explicitDelegationNeedsEmbodiedSurface({ needsEmbodiedSurface: true }),
		).toBe(true);
		expect(
			explicitDelegationNeedsEmbodiedSurface({ requireWorkstation: true }),
		).toBe(true);
		// Mirrors the kernel route vocabulary verbatim.
		expect(
			explicitDelegationNeedsEmbodiedSurface({ effortClass: "embodied" }),
		).toBe(true);
	});

	it("treats non-embodied effort classes as native", () => {
		for (const effortClass of ["single_read", "multi_hop_read", "fan_out"]) {
			expect(explicitDelegationNeedsEmbodiedSurface({ effortClass })).toBe(
				false,
			);
		}
	});

	it("ignores truthy-but-not-true and malformed signals (fail to native)", () => {
		// Only a strict boolean `true` flips the gate — a string "true" or a
		// non-object metadata must not accidentally lease a workstation.
		expect(
			explicitDelegationNeedsEmbodiedSurface({ needsEmbodiedSurface: "true" }),
		).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface({ requireWorkstation: 1 }),
		).toBe(false);
		expect(explicitDelegationNeedsEmbodiedSurface("embodied")).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface([{ effortClass: "embodied" }]),
		).toBe(false);
	});
});

describe("enqueueMessage routing composition (needs × capability)", () => {
	it("(a) capable target + no signal → native isolate (workstationAttach false)", async () => {
		// tedi-cto-agent has repoConfig.repoUrl → workstation-capable. No
		// needsEmbodiedSurface in metadata → native isolate delegation (no approval).
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; content: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Summarise the git log",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-a",
		});

		// Native path → delegate runner fires; no approval gate.
		expect(delegateRunner).toHaveBeenCalled();
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			metadata: { executionSurface: "native" },
		});
		expect(result).toMatchObject({
			status: "queued",
			run: {
				delegatedTediId: "tedi-cto-agent",
				status: "queued",
			},
		});
		expect(db.approvals).toHaveLength(0);
	});

	it("reuses an existing Work Item for native delegation without creating a wrapper", async () => {
		const db = createKernelRuntimeDb();
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Existing graph lens task",
				disposition: "accepted",
				workKind: "coding",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto-agent",
				priority: "medium",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				metadata: { existingCanonicalItem: true },
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn(
			async (input: {
				childRunId: string;
				content: string;
				metadata: Record<string, unknown>;
			}) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Implement the remaining graph lens",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-existing-native",
			metadata: { workItemId },
		});

		expect(db.workItemRows).toHaveLength(1);
		expect(db.workItemRows[0]).toMatchObject({
			id: workItemId,
			accountableOwnerId: "tedi-cto-agent",
			disposition: "accepted",
			metadata: {
				existingCanonicalItem: true,
			},
		});
		expect(db.workAttemptRows).toHaveLength(1);
		expect(db.workAttemptRows[0]).toMatchObject({
			workItemId,
			executorId: "tedi-cto-agent",
		});
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			metadata: { workItemId, executionSurface: "native" },
		});
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			`Work Item: ${workItemId}`,
		);
		expect(result.run.metadata).toMatchObject({ workItemId });
	});

	it("fails closed when the requested canonical Work Item belongs to another tedi", async () => {
		const db = createKernelRuntimeDb();
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Already assigned task",
				disposition: "accepted",
				workKind: "coding",
				priority: "medium",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cpo",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		await expect(
			client.enqueueMessage({
				conversationId: "home:test",
				content: "Take somebody else's item",
				delegateToTediId: "tedi-cto-agent",
				idempotencyKey: "comp-test-existing-conflict",
				metadata: { workItemId },
			}),
		).rejects.toThrow(`Work Item ${workItemId} is unavailable`);
		expect(db.workItemRows).toHaveLength(1);
		expect(db.workAttemptRows).toHaveLength(0);
		expect(delegateRunner).not.toHaveBeenCalled();
	});

	it("(b) capable target + needsEmbodiedSurface:true → workstation (workstationAttach true)", async () => {
		// Same workstation-capable tedi; metadata carries needsEmbodiedSurface:true
		// → WORKSTATION-attach work order (requires_approval before dispatch).
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Existing workstation coding task",
				disposition: "accepted",
				workKind: "coding",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto-agent",
				priority: "medium",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				metadata: {
					existingCanonicalItem: true,
					executionRequirement: {
						surface: "workstation",
						requiredCapabilities: [
							"repository_read",
							"repository_edit",
							"tests",
						],
						fallbackSurface: null,
						prohibitedSurfaces: ["native", "managed_job"],
						satisfiable: true,
						reason: "canonical repository Work Item requirement",
					},
				},
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; content: string }) => ({
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Write and run a migration script in the repo",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-b",
			metadata: { needsEmbodiedSurface: true, workItemId },
		});
		await Promise.all(context.waitUntilPromises);

		// Workstation path → approval gate before dispatch; runner not called yet.
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "requires_approval",
			run: {
				status: "requires_approval",
				delegatedTediId: "tedi-cto-agent",
			},
		});
		expect(db.workItemRows).toHaveLength(1);
		expect(db.workItemRows[0]).toMatchObject({
			id: workItemId,
			accountableOwnerId: "tedi-cto-agent",
			disposition: "accepted",
			metadata: {
				existingCanonicalItem: true,
			},
		});
		expect(db.workAttemptRows).toHaveLength(1);
		expect(db.workAttemptRows[0]).toMatchObject({
			workItemId,
			executorId: "tedi-cto-agent",
			runtimeState: "running",
		});
		expect(result.run.metadata).toMatchObject({
			workItemId,
			delegationWorkOrder: {
				workItemId,
				executionRequirement: {
					surface: "workstation",
					requiredCapabilities: ["repository_read", "repository_edit", "tests"],
					prohibitedSurfaces: ["native", "managed_job"],
				},
			},
		});
		expect(db.approvals).toHaveLength(1);
		expect(db.approvals[0]).toMatchObject({
			actionType: "workstation.attach",
			tediId: "tedi-cto-agent",
		});
		expect(db.harnessSubjectVersionRows).toHaveLength(1);
		expect(db.harnessSubjectVersionRows[0]).toMatchObject({
			subjectKind: "kernel",
			subjectId: `kernel:${ORG_ID}`,
			components: { home_dispatch: "direct-workstation-attach-v1" },
			promotionStatus: "active",
		});
		expect(db.harnessSubjectTraceBundleRows).toHaveLength(1);
		const traceBundle = db.harnessSubjectTraceBundleRows[0]!;
		expect(traceBundle).toMatchObject({
			id: "comp-test-b:bundle",
			subjectKind: "kernel",
			subjectId: `kernel:${ORG_ID}`,
			orgId: ORG_ID,
			conversationId: "home:test",
			runId: "comp-test-b",
			outcome: "escalated",
		});
		const traceEventKinds = db.events
			.filter((event) => traceBundle.eventIds.includes(event.id))
			.map((event) => event.kind);
		expect(traceEventKinds).toEqual([
			"message.completed",
			"approval.requested",
		]);
		const traceMetadata = traceBundle.metadata as {
			bodyExecutionResult?: {
				status?: string;
				structuredResult?: Record<string, unknown>;
			};
		};
		expect(traceMetadata.bodyExecutionResult).toMatchObject({
			status: "blocked",
			structuredResult: {
				delegation: "workstation_attach",
				delegatedTediId: "tedi-cto-agent",
				childRunId: expect.any(String),
				workItemId,
				approvalRequestId: "comp-test-b",
			},
		});
	});

	it("retryRun re-dispatches a failed delegated run as a NEW run with a fresh id", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Seed a failed delegated run carrying a delegationWorkOrder.
		const failedRunId = "retry-test-failed-1";
		const delegatedTediId = "tedi-cpo";
		const delegationWorkOrder = {
			objective: "Run the quarterly capacity analysis",
			outputContract: "Return the key metrics table.",
			sourceContent: `Please run the quarterly capacity analysis for Q3.\n${"Scope context. ".repeat(300)}\nAcceptance: retain the independent oracle and both merge parents.`,
			toolGuidance: ["Use analytics tools"],
			boundaries: ["Do not write to any systems"],
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test",
				status: "failed",
				delegatedTediId,
				childRunId: "child-failed-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId,
					delegationWorkOrder,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		// Stub the delegate runner to succeed.
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.retryRun({ runId: failedRunId });

		// The returned run is a new run (different id from the failed one).
		expect(result.newRunId).not.toBe(failedRunId);
		expect(result.run.id).toBe(result.newRunId);
		expect(result.run.status).toBe("queued");
		expect(result.run.delegatedTediId).toBe(delegatedTediId);

		// The delegate runner was called with the retried work order content.
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		const dispatchCall = delegateRunner.mock.calls[0]?.[0];
		expect(dispatchCall).toMatchObject({
			delegateToTediId: delegatedTediId,
			metadata: expect.objectContaining({
				source: "kernelRuntime.retryRun",
				retriedFromRunId: failedRunId,
			}),
		});
		// Content should contain the work order framing.
		expect(typeof dispatchCall?.content).toBe("string");
		expect(dispatchCall?.content).toContain("RETRY");
		expect(dispatchCall?.content).toContain(delegationWorkOrder.sourceContent);
		expect(dispatchCall?.content).toContain(
			"Run the quarterly capacity analysis",
		);

		// A new run row was inserted in the DB.
		expect(db.runs).toHaveLength(2);
		const newRunRow = db.runs.find((r) => r.id === result.newRunId);
		expect(newRunRow).toBeDefined();
		expect(newRunRow?.status).toBe("queued");
		expect(newRunRow?.delegatedTediId).toBe(delegatedTediId);
		expect(newRunRow?.metadata).toMatchObject({
			retriedFromRunId: failedRunId,
			delegatedTediId,
		});

		// An audit event was emitted.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.retried",
				resourceType: "kernel_run",
				resourceId: result.newRunId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.retryRun",
					retriedFromRunId: failedRunId,
					delegatedTediId,
				}),
			}),
		);

		// The original failed run is unchanged.
		const originalRun = db.runs.find((r) => r.id === failedRunId);
		expect(originalRun?.status).toBe("failed");
	});

	it("retryRun preserves canonical Work Item correlation in the child dispatch", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const failedRunId = "retry-work-item-failed-1";
		const workItemId = "11111111-1111-4111-8111-111111111111";
		const delegatedTediId = "tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-work-item",
				status: "failed",
				delegatedTediId,
				runtimeMetadata: { requiredProofKind: "code" },
				metadata: {
					delegatedTediId,
					delegationWorkOrder: {
						objective: "Finish the existing coding task",
						sourceContent: "Complete the canonical Work Item.",
						workItemId,
					},
				},
				createdAt: "2026-07-22T19:00:00.000Z",
				updatedAt: "2026-07-22T19:01:00.000Z",
			}),
		);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.retryRun({ runId: failedRunId });

		expect(delegateRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					workItemId,
					requiredProofKind: "code",
				}),
			}),
		);
		expect(result.run.metadata).toMatchObject({ workItemId });
		expect(result.run.runtime?.metadata).toMatchObject({
			workItemId,
			requiredProofKind: "code",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.retried",
				metadata: expect.objectContaining({ workItemId }),
			}),
		);
	});

	it("retryRun rejects a non-failed run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Seed a running (non-terminal) run.
		const runningRunId = "retry-running-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: runningRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-2",
				status: "running",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegationWorkOrder: { objective: "Do something" },
					delegatedTediId: "tedi-cpo",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		await expect(
			client.retryRun({ runId: runningRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining('"running"'),
		});
	});

	it("retryRun rejects a failed run that has no delegationWorkOrder", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Case 1: no delegatedTediId at all (e.g. a kernel-inline run).
		const inlineFailedRunId = "retry-no-workorder-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: inlineFailedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-3",
				status: "failed",
				delegatedTediId: null,
				metadata: {
					// No delegationWorkOrder
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);
		await expect(
			client.retryRun({ runId: inlineFailedRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining("no delegatedTediId"),
		});

		// Case 2: has delegatedTediId but no delegationWorkOrder in metadata.
		const noWorkOrderRunId = "retry-no-workorder-2";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: noWorkOrderRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-3",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					// No delegationWorkOrder — e.g. a failed plain-delegation run
					// with no work order (older format or truncated metadata).
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);
		await expect(
			client.retryRun({ runId: noWorkOrderRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining("delegationWorkOrder"),
		});
	});

	it("retryRun records a dispatch failure as a terminal failed run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-dispatch-fail-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-dispatch-fail",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					delegationWorkOrder: {
						objective: "Run the analysis",
						sourceContent: "Please run the analysis.",
					},
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		// Stub the delegate runner to fail.
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async () => ({
			childRunId: "child-dispatch-fail",
			childConversationId: undefined,
			error: "target runtime unavailable",
			status: "failed" as const,
		}));

		const result = await client.retryRun({ runId: failedRunId });

		// New run exists but is itself failed (dispatch could not reach the target).
		expect(result.run.status).toBe("failed");
		expect(result.newRunId).not.toBe(failedRunId);

		const newRunRow = db.runs.find((r) => r.id === result.newRunId);
		expect(newRunRow?.status).toBe("failed");
	});

	it("retryRun stamps kernelRoute from the FAILED run onto the audit event so home-reflection-producer can mine the rationale", async () => {
		// The failed run carried a kernelRoute when it was originally dispatched.
		// retryRun must forward it into the new run's audit event so the producer
		// can mine "Operator retried ... because: <rationale>" on the next cycle.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-g3-failed-1";
		const delegatedTediId = "tedi-cto";
		const kernelRoute = {
			routeKind: "delegate_tedi",
			rationale: "cto is the only roster member with the board context",
			confidence: 0.75,
			effortClass: "single_shot",
		};
		const delegationWorkOrder = {
			objective: "Prepare the board deck summary",
			outputContract: "Return the key slides.",
			sourceContent: "Please prepare the board deck summary for Q3.",
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-g3",
				status: "failed",
				delegatedTediId,
				childRunId: "child-g3-failed",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId,
					delegationWorkOrder,
					kernelRoute,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);

		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);

		const result = await client.retryRun({ runId: failedRunId });

		expect(result.run.status).toBe("queued");
		expect(result.newRunId).not.toBe(failedRunId);

		// The audit event for the new run must carry kernelRoute from the original
		// failed run so home-reflection-producer fires the "because:" clause.
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.retried" &&
				(r as Record<string, unknown>).resourceId === result.newRunId,
		) as Record<string, unknown> | undefined;
		expect(auditRow).toBeDefined();
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		expect(auditMeta?.kernelRoute).toMatchObject({
			routeKind: "delegate_tedi",
			rationale: "cto is the only roster member with the board context",
		});
		// delegatedTediId also present (producer reads it to scope the "because:" clause).
		expect(auditMeta?.delegatedTediId).toBe(delegatedTediId);
	});

	it("fail-soft: retryRun with no kernelRoute on the failed run → audit event carries kernelRoute null", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-g3-nosig-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-g3-nosig",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					delegationWorkOrder: {
						objective: "Analyse Q3",
						sourceContent: "Please analyse Q3.",
					},
					// no kernelRoute — producer must emit bare fact text (no "because:")
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);

		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);

		const result = await client.retryRun({ runId: failedRunId });

		expect(result.run.status).toBe("queued");
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.retried" &&
				(r as Record<string, unknown>).resourceId === result.newRunId,
		) as Record<string, unknown> | undefined;
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		// Absent kernelRoute → null (fail-soft, no throw).
		expect(auditMeta?.kernelRoute).toBeNull();
	});
});

describe("proposeCodemodeExecute — delegated durable call", () => {
	it("creates the canonical approval card and parks the matching Home run", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-1",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "tedi-cto:mcp:child-1",
				metadata: {},
			}),
		);

		const result = await proposeCodemodeExecuteImpl(createContext(db), {
			tediId: "tedi-cto",
			orgId: ORG_ID,
			conversationId: "cto:delegated",
			sessionKey: "home:durable",
			executionId: "exec-1",
			codeHash: "hash-1",
			executionMode: "durable_call",
			homeRunId: "home-durable-1",
			childRunId: "tedi-cto:mcp:child-1",
			pendingSeq: 0,
			connector: "workspace",
			method: "write_file",
		});

		expect(result.status).toBe("pending");
		expect(db.approvals).toHaveLength(1);
		expect(db.approvals[0]).toMatchObject({
			actionType: "durable_code.call",
			status: "pending",
			tediId: "tedi-cto",
		});
		expect(db.runs[0]).toMatchObject({
			status: "requires_approval",
			metadata: {
				approvalRequestId: result.approvalRequestId,
				durableCodeApproval: {
					executionId: "exec-1",
					connector: "workspace",
					method: "write_file",
					status: "pending",
				},
			},
		});
	});

	it("idempotently repairs the same durable approval without duplicate cards", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-repair",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "tedi-cto:mcp:repair",
				metadata: {},
			}),
		);
		const input = {
			tediId: "tedi-cto",
			orgId: ORG_ID,
			conversationId: "cto:delegated",
			sessionKey: "home:durable",
			executionId: "exec-repair",
			codeHash: "hash-repair",
			approvalRequestId: "approval-repair-stable",
			executionMode: "durable_call" as const,
			homeRunId: "home-durable-repair",
			childRunId: "tedi-cto:mcp:repair",
			pendingSeq: 0,
			connector: "workspace",
			method: "write_file",
		};
		const first = await proposeCodemodeExecuteImpl(createContext(db), input);
		const repaired = await proposeCodemodeExecuteImpl(createContext(db), input);
		expect(repaired).toEqual(first);
		expect(db.approvals).toHaveLength(1);
		expect(
			db.auditRows.filter((row) => row.action === "approval.requested"),
		).toHaveLength(1);

		const run = db.runs[0];
		if (run) run.status = "completed";
		const approval = db.approvals[0];
		if (approval) approval.status = "approved";
		const afterApproval = await proposeCodemodeExecuteImpl(
			createContext(db),
			input,
		);
		expect(afterApproval.status).toBe("approved");
		expect(db.runs[0]?.status).toBe("completed");
	});

	it("rejects a durable approval that is not correlated to the delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-2",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "actual-child",
				metadata: {},
			}),
		);
		await expect(
			proposeCodemodeExecuteImpl(createContext(db), {
				tediId: "tedi-cto",
				orgId: ORG_ID,
				conversationId: "cto:delegated",
				sessionKey: "home:durable",
				executionId: "exec-2",
				codeHash: "hash-2",
				executionMode: "durable_call",
				homeRunId: "home-durable-2",
				childRunId: "spoofed-child",
				pendingSeq: 0,
				connector: "workspace",
				method: "write_file",
			}),
		).rejects.toThrow(/does not match/);
		expect(db.approvals).toHaveLength(0);
	});
});

describe("proposeRepoCommit + settle-guard", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
	});

	const BASE_INPUT = {
		tediId: "tedi-cpo",
		orgId: ORG_ID,
		conversationId: "home:repo-test",
		owner: "tedix",
		repo: "ops",
		baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
		branch: "feat/add-widget",
		message: "add widget",
		openPr: false,
		prBase: null,
		changeSummary: {
			fileCount: 2,
			addedOrModified: ["src/widget.ts", "src/widget.test.ts"],
			deleted: [],
			totalBytes: 1024,
		},
		executionLedgerId: "exec-ledger-1",
		riskTier: "low" as const,
	};

	it("proposeRepoCommit creates approval row + auto-resolves low-risk trusted commit WITHOUT calling MCP executor", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const result = await proposeRepoCommitImpl(context, BASE_INPUT);

		expect(result.status).toBe("approved");
		expect(result.autoResolved).toBe(true);
		expect(result.approvalRequestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		// Row created and auto-resolved
		expect(db.approvals).toHaveLength(1);
		const row = db.approvals[0];
		expect(row?.status).toBe("approved");
		expect(row?.resolvedBy).toBe("policy");
		expect(row?.actionType).toBe("home.tool_write");
		expect(row?.tediId).toBe("tedi-cpo");
		expect((row?.payload as { kind?: string })?.kind).toBe("repo_commit_write");
		expect(row?.payload).toMatchObject({
			appSlug: "repo",
			toolName: "repo_commit",
			title: "Commit 2 file(s) to tedix/ops@feat/add-widget",
			requestPreview:
				"Commit 2 file(s) to tedix/ops@feat/add-widget (base abc1234567890123456789012345678901234567)",
			executionLedgerId: "exec-ledger-1",
		});

		// Both audit events present
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "approval.requested",
				resourceId: result.approvalRequestId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeRepoCommit",
					riskTier: "low",
				}),
			}),
		);
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "policy",
				action: "approval.approved",
				resourceId: result.approvalRequestId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeRepoCommit.autoResolve",
					autoResolveSource: "policy",
				}),
			}),
		);

		// MCP executor was never called
		expect(executor).not.toHaveBeenCalled();
	});

	it("proposeRepoCommit persists the exact content fingerprint onto the approval", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const fingerprint = "a1b2c3d4".repeat(8);

		await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			changeFingerprint: fingerprint,
		});

		// The anchor the publish fence compares the moving bytes against has to
		// live in D1, not only in the tedi's own DO-SQLite.
		expect(db.approvals[0]?.payload).toMatchObject({
			changeFingerprint: fingerprint,
		});
	});

	it("proposeRepoCommit records null (never a malformed anchor) when the caller sends no usable fingerprint", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		// A runtime that predates the field.
		await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(db.approvals[0]?.payload).toMatchObject({
			changeFingerprint: null,
		});

		// A malformed value is dropped rather than stored: persisting it would
		// fail parseRepoCommitWritePayload and strand the commit forever.
		await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			changeFingerprint: "not-a-sha",
		});
		expect(db.approvals[1]?.payload).toMatchObject({
			changeFingerprint: null,
		});
	});

	it("proposeRepoCommit protected-branch commit stays pending (not auto-resolved)", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "high",
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);

		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
		expect(row?.resolvedBy).toBeNull();

		// Only approval.requested, no approval.approved
		expect(db.auditRows.some((r) => r.action === "approval.requested")).toBe(
			true,
		);
		expect(db.auditRows.some((r) => r.action === "approval.approved")).toBe(
			false,
		);
	});

	it("settle-guard: settleHomeToolWriteApproval is a no-op for repo_commit_write payloads (MCP executor never called)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const fakeApproval = {
			id: "approval-rc-1",
			tediId: "tedi-cpo",
			orgId: ORG_ID,
			actionType: "home.tool_write",
			description:
				"Commit 2 file(s) to tedix/ops@feat/add-widget (base abc123...)",
			payload: {
				kind: "repo_commit_write",
				organizationId: ORG_ID,
				tediId: "tedi-cpo",
				conversationId: "home:repo-test",
				homeRunId: null,
				owner: "tedix",
				repo: "ops",
				baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
				branch: "feat/add-widget",
				message: "add widget",
				openPr: false,
				prBase: null,
				changeSummary: {
					fileCount: 2,
					addedOrModified: ["src/widget.ts"],
					deleted: [],
					totalBytes: 512,
				},
				riskTier: "low",
				executionLedgerId: "exec-ledger-1",
			},
			status: "approved" as const,
			createdAt: "2026-06-21T10:00:00.000Z",
			expiresAt: "2026-06-22T10:00:00.000Z",
			resolvedAt: "2026-06-21T10:01:00.000Z",
			resolvedBy: "policy",
			resolution: "policy-trusted low-risk write repo:repo_commit",
			workflowId: null,
		};

		await settleHomeToolWriteApproval(context, {
			approval: fakeApproval,
			status: "approved",
		});

		// MCP executor must never be called for repo_commit_write
		expect(executor).not.toHaveBeenCalled();
	});

	it("getRepoCommitApprovalStatus returns status after proposeRepoCommit", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		// Propose a commit (no trusted policy → stays pending)
		const proposed = await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(proposed.status).toBe("pending");

		// Manually look up via db.approvals (mirrors what getRepoCommitApprovalStatus does)
		const row = db.approvals.find((a) => a.id === proposed.approvalRequestId);
		expect(row).toBeDefined();
		expect(row?.status).toBe("pending");
		expect(row?.resolution).toBeNull();

		// Simulate the handler logic directly (no service-auth middleware in unit test)
		// We test via the router client with service-binding headers
		const headers = new Headers({ "X-Service-Binding": "true" });
		const serviceContext = { ...context, headers };
		const client = createRouterClient(kernelRuntimeContractRouter, {
			context: serviceContext,
		});
		const status = await client.getRepoCommitApprovalStatus({
			approvalRequestId: proposed.approvalRequestId,
			tediId: BASE_INPUT.tediId,
		});
		expect(status.status).toBe("pending");
		expect(status.resolution).toBeNull();
	});

	it("ADVERSARIAL: server ignores caller-supplied riskTier — lying 'low' for main branch stays pending", async () => {
		// Policy would auto-approve a low-risk repo_commit. The DO lies and sends
		// riskTier:'low' but branch='main'. Server recomputes 'high' and forces pending.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "low", // caller lies — server recomputes 'high'
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);
		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
		expect(row?.resolvedBy).toBeNull();
		expect(db.auditRows.some((r) => r.action === "approval.approved")).toBe(
			false,
		);
	});

	it("FIX-1: policy trustedTools covers repo:* + protected branch ('main') → still pending", async () => {
		// decideKernelWriteApproval would return autoResolve:true if riskTier were 'low',
		// but server recomputes 'high' for main and effectiveAutoResolve forces pending.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:*"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "high",
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);
		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
	});

	it("FIX-1: session allowlist + feature branch ('feat/x') → auto-approved (low-risk honored)", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "feat/x",
			riskTier: "low",
		});

		expect(result.status).toBe("approved");
		expect(result.autoResolved).toBe(true);
		const row = db.approvals[0];
		expect(row?.status).toBe("approved");
	});

	it("FIX-2: getRepoCommitApprovalStatus — wrong tediId returns NOT_FOUND", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		const proposed = await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(proposed.status).toBe("pending");

		const headers = new Headers({ "X-Service-Binding": "true" });
		const serviceContext = { ...context, headers };
		const client = createRouterClient(kernelRuntimeContractRouter, {
			context: serviceContext,
		});

		// Wrong tediId → NOT_FOUND (no information about who owns the row)
		await expect(
			client.getRepoCommitApprovalStatus({
				approvalRequestId: proposed.approvalRequestId,
				tediId: "tedi-attacker",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Correct tediId → returns status
		const status = await client.getRepoCommitApprovalStatus({
			approvalRequestId: proposed.approvalRequestId,
			tediId: BASE_INPUT.tediId,
		});
		expect(status.status).toBe("pending");
	});

	it("FIX-3 repo_commit_write settle triggers tedi DO drain and never calls MCP executor", async () => {
		const db = createKernelRuntimeDb();
		const runtimeFetch = vi.fn(async () =>
			Response.json({ ok: true, drained: true }),
		);
		const context = createContext(db, {
			env: {
				TEDI_SERVICE: { fetch: runtimeFetch },
			},
		});

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const fakeApproval = {
			id: "approval-rc-guard",
			tediId: "tedi-cpo",
			orgId: ORG_ID,
			actionType: "home.tool_write",
			description: "Commit 1 file(s) to tedix/ops@feat/add-widget",
			payload: {
				kind: "repo_commit_write",
				organizationId: ORG_ID,
				tediId: "tedi-cpo",
				conversationId: "home:repo-test",
				homeRunId: null,
				owner: "tedix",
				repo: "ops",
				baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
				branch: "feat/add-widget",
				message: "add widget",
				openPr: false,
				prBase: null,
				changeSummary: {
					fileCount: 1,
					addedOrModified: ["src/widget.ts"],
					deleted: [],
					totalBytes: 512,
				},
				riskTier: "low",
				executionLedgerId: "exec-ledger-guard",
			},
			status: "approved" as const,
			createdAt: "2026-06-21T10:00:00.000Z",
			expiresAt: "2026-06-22T10:00:00.000Z",
			resolvedAt: "2026-06-21T10:01:00.000Z",
			resolvedBy: "policy",
			resolution: "policy-trusted low-risk write repo:repo_commit",
			workflowId: null,
		};

		await settleHomeToolWriteApproval(context, {
			approval: fakeApproval,
			status: "approved",
		});
		await Promise.all(context.waitUntilPromises);

		expect(runtimeFetch).toHaveBeenCalledTimes(1);
		const [url, init] = runtimeFetch.mock.calls[0] ?? [];
		expect(String(url)).toContain("/__internal/repo-commit/drain");
		expect((init as RequestInit | undefined)?.method).toBe("POST");
		const drainHeaders = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		expect(drainHeaders).toBeDefined();
		expect(drainHeaders?.["X-Service-Binding"]).toBe("true");
		expect(
			JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")),
		).toMatchObject({
			approvalRequestId: "approval-rc-guard",
			executionLedgerId: "exec-ledger-guard",
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Fan-out child-tree: buildFanoutChildNodes + augmentTreeWithFanoutChildren
// ---------------------------------------------------------------------------

describe("buildFanoutChildNodes", () => {
	it("builds nodes for live slots with queued status", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Summarize page",
					objective: "Summarize the product page",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:00Z",
				},
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-2",
					childRunId: "tedi-cto:fanout:child-2",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Analyze competitors",
					objective: "Analyze competitor data",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:01Z",
				},
			],
			terminalByRunId: new Map(),
		});
		expect(nodes).toHaveLength(2);
		expect(nodes[0]).toMatchObject({
			id: "fanout:tedi-cto:tedi-cto:fanout:child-1",
			homeRunId: "home-run-1",
			delegatedTediId: "tedi-cto",
			childRunId: "tedi-cto:fanout:child-1",
			status: "queued",
			active: true,
			depth: 1,
			children: [],
		});
	});

	it("upgrades live-slot status from D1 terminal evidence", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([["tedi-cto:fanout:child-1", "completed"]]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Task A",
					objective: "Do task A",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:00Z",
				},
			],
			terminalByRunId,
		});
		expect(nodes[0]?.status).toBe("completed");
		expect(nodes[0]?.active).toBe(false);
	});

	it("includes terminal runs not in live slots (already cleared from DO)", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([
			["tedi-cto:fanout:child-done-1", "completed"],
			["tedi-cto:fanout:child-done-2", "failed"],
		]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [],
			terminalByRunId,
		});
		expect(nodes).toHaveLength(2);
		const done = nodes.find(
			(n) => n.childRunId === "tedi-cto:fanout:child-done-1",
		);
		const failed = nodes.find(
			(n) => n.childRunId === "tedi-cto:fanout:child-done-2",
		);
		expect(done?.status).toBe("completed");
		expect(failed?.status).toBe("failed");
	});

	it("deduplicates childRunId appearing in both slots and terminal map", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([["tedi-cto:fanout:child-dup", "completed"]]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-dup",
					childRunId: "tedi-cto:fanout:child-dup",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Dup",
					objective: "dup",
					status: "queued",
					dispatchedAt: null,
				},
			],
			terminalByRunId,
		});
		// slot took priority; terminal map should not add a second node
		expect(nodes).toHaveLength(1);
		expect(nodes[0]?.status).toBe("completed");
	});

	it("returns [] when no slots and no terminal runs", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [],
			terminalByRunId: new Map(),
		});
		expect(nodes).toHaveLength(0);
	});
});

describe("augmentTreeWithFanoutChildren", () => {
	it("returns the base tree unchanged when there are no active delegation nodes", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:main",
			nodes: [],
			activeNodeId: null,
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, []);
		expect(result).toBe(tree); // same reference — no work done
	});

	it("returns the base tree unchanged when delegation node is terminal", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:main",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					conversationId: "home:main",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					parentRunId: null,
					label: "cto",
					status: "completed" as const,
					active: false,
					depth: 0,
					updatedAt: null,
					children: [],
				},
			],
			activeNodeId: null,
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, []);
		// Terminal node → not augmented → tree unchanged
		expect(result).toBe(tree);
	});

	it("returns base tree when no service-binding fetcher (test env) — fail-soft", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:fanout",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto" },
				createdAt: "2026-06-22T10:00:00.000Z",
				updatedAt: "2026-06-22T10:00:00.000Z",
			}),
		);
		const context = createContext(db);
		// No TEDI_SERVICE in context.env → config.fetcher is undefined → fail-soft → []
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:fanout",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					conversationId: "home:fanout",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					parentRunId: null,
					label: "cto",
					status: "running" as const,
					active: true,
					depth: 0,
					updatedAt: null,
					children: [],
				},
			],
			activeNodeId: "child:tedi-cto:child-run-1",
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, db.runs);
		// No fetcher → readFanoutSlotsForNode returns [] → no D1 fanout events →
		// children stays [] → tree returned unchanged
		expect(result.nodes[0]?.children).toHaveLength(0);
	});

	it("readChildRunTree: existing delegation node still has children: [] when no fanout slots", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:tree",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto", childRunStatus: "running" },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readChildRunTree({
			conversationId: "home:tree",
		});
		expect(result.tree).toMatchObject({
			conversationId: "home:tree",
			activeNodeId: "child:tedi-cto:child-run-1",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					label: "cto",
					status: "running",
					active: true,
					children: [],
				},
			],
		});
	});

	it("omits approvalMirrors when the rebuildable approval projection read fails", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-approval-projection-failure",
				organizationId: ORG_ID,
				conversationId: "home:approval-projection-failure",
				status: "running",
				createdAt: "2026-07-22T19:00:00.000Z",
				updatedAt: "2026-07-22T19:00:00.000Z",
			}),
		);

		// The focused router fake intentionally has no approval-mirror table;
		// listActiveKernelApprovalMirrors therefore throws, exercising readRunSet's
		// fail-soft projection path without suppressing canonical run data.
		const result = await createKernelRuntimeClient(
			createContext(db),
		).readRunSet({
			conversationId: "home:approval-projection-failure",
		});

		expect(result.runSet.runs).toHaveLength(1);
		expect(result.runSet).not.toHaveProperty("approvalMirrors");
	});
});

describe("operator slash commands are never routed as objectives", () => {
	// Regression: `/retry <id>` sent as a message became a new objective on a new
	// work item titled after the command text, while the item it named stayed
	// blocked. Every text surface must refuse it the same way.
	it("detects operator verbs on the first line", () => {
		expect(detectOperatorSlashCommand("/retry 5eed0001")).toBe("retry");
		expect(detectOperatorSlashCommand("  /Cancel abc  ")).toBe("cancel");
		expect(
			detectOperatorSlashCommand("/retry 5eed0001\n\nLocal terminal context:"),
		).toBe("retry");
	});

	it("leaves ordinary prose and unknown verbs alone", () => {
		expect(detectOperatorSlashCommand("summarize the run set")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("/Users/owner/x.md is stale"),
		).toBeUndefined();
		expect(detectOperatorSlashCommand("/2026 targets")).toBeUndefined();
		expect(detectOperatorSlashCommand("/definitelynotaverb x")).toBeUndefined();
		expect(detectOperatorSlashCommand("/")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("please run /retry for me"),
		).toBeUndefined();
	});

	it("refuses the enqueue instead of minting a work item", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.enqueueMessage({
				conversationId: "home:test",
				content: "/retry 5eed0001-0000-4000-8000-000000000001",
				idempotencyKey: "home-slash-1",
			}),
		).rejects.toThrow(/operator command, not a message/);
	});

	// The OS composer's skill picker writes `/skill <slug>` ABOVE the operator's
	// prose. Reading literally the first line would classify the reference as
	// "not a command" and let the real command underneath through unrefused.
	it("steps over leading skill references to find the real command", () => {
		expect(
			detectOperatorSlashCommand("/skill deploy-runbook\n\n/retry 5eed0001"),
		).toBe("retry");
		expect(
			detectOperatorSlashCommand(
				"/skill deploy-runbook\n/skill audit-costs\n\n/cancel abc",
			),
		).toBe("cancel");
	});

	it("never refuses a skill reference as a command of its own", () => {
		// A reference is a reference. Claiming the verb would refuse every
		// picker insertion the composer makes.
		expect(SKILL_REFERENCE_VERB).toBe("skill");
		expect(detectOperatorSlashCommand("/skill deploy-runbook")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("/skill deploy-runbook\n\nship the widget"),
		).toBeUndefined();
	});

	it("still reads a leading token that only looks like a reference", () => {
		// Not the reference grammar (no slug), so it is ordinary prose again.
		expect(detectOperatorSlashCommand("/skill\n/retry abc")).toBeUndefined();
	});
});

describe("operator skill references are resolved before the turn is billed", () => {
	// A picker that inserts a reference nothing resolves is a visible affordance
	// that silently does nothing. Refuse at enqueue, naming the slug, so the
	// operator fixes it instead of wondering why the skill was ignored.
	it("refuses a reference that resolves to no readable skill", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue(undefined);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await expect(
				client.enqueueMessage({
					conversationId: "home:test",
					content: "/skill ghost\n\nship the widget",
					idempotencyKey: "home-skill-ref-1",
				}),
			).rejects.toThrow(/did not resolve to a usable skill/);
		} finally {
			read.mockRestore();
		}
	});

	it("names the exact slug that failed, not just that something did", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue(undefined);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await expect(
				client.enqueueMessage({
					conversationId: "home:test",
					content: "/skill deploy-runbook\n\nship the widget",
					idempotencyKey: "home-skill-ref-2",
				}),
			).rejects.toThrow(/"\/skill deploy-runbook"/);
		} finally {
			read.mockRestore();
		}
	});

	it("lets a resolvable reference through and enqueues the turn", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue({
				id: "skill-deploy",
				organizationId: "org-1",
				title: "Deploy runbook",
				slug: "deploy-runbook",
				content: "1. run the deploy script",
				tediId: null,
				visibility: "org",
				lifecycleState: "proven",
			} as unknown as Awaited<
				ReturnType<typeof skillCrudQueries.getSkillEntryBySlug>
			>);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const result = await client.enqueueMessage({
				conversationId: "home:test",
				content: "/skill deploy-runbook\n\nship the widget",
				idempotencyKey: "home-skill-ref-ok",
			});
			expect(result.conversationId).toBe("home:test");
			expect(read).toHaveBeenCalledWith(
				expect.anything(),
				"org-1",
				"deploy-runbook",
			);
		} finally {
			read.mockRestore();
		}
	});

	it("lets a message with no skill reference through without any skill read", async () => {
		const read = vi.spyOn(skillCrudQueries, "getSkillEntryBySlug");
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await client.enqueueMessage({
				conversationId: "home:test",
				content: "ship the widget",
				idempotencyKey: "home-skill-ref-3",
			});
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});
});

describe("workstation admission runtime identity", () => {
	function fixture(automatic: boolean) {
		const db = createKernelRuntimeDb();
		const target = db.tediRows.find((row) => row.id === "tedi-cto-agent")!;
		Object.assign(target, {
			isolateAgentId: "cto-rebind-1782139014003",
			runtimeStatus: "running",
		});
		const context = createContext(db, {
			env: { WORKSTATION_AUTO_DISPATCH_ENABLED: automatic ? "true" : "false" },
			...(automatic ? { userSub: "operator-1" } : {}),
		}) as BaseContext & { waitUntilPromises: Promise<unknown>[] };
		const client = createKernelRuntimeClient(context);
		const workItemId = crypto.randomUUID();
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Supervised workstation task",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: target.id,
				workKind: "coding",
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2099-01-01T00:00:00.000Z",
				createdAt: new Date().toISOString(),
			}),
		);
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childRunId: predictAgentRunId({
					clientRequestId: input.childRunId,
					tediId: input.delegateToTediId,
				}),
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		const enqueue = async (homeRunId: string) => {
			const result = await client.enqueueMessage({
				conversationId: "home:test",
				content: "Run the bounded native command",
				delegateToTediId: target.id,
				idempotencyKey: homeRunId,
				metadata: { requireWorkstation: true, workItemId },
			});
			await Promise.all(context.waitUntilPromises);
			return result;
		};
		const approve = (homeRunId: string) => {
			const approval = db.approvals.find((row) => row.id === homeRunId)!;
			approval.status = "approved";
			return resolveKernelWorkstationAttachWorkOrder(context, {
				approvalRequestId: approval.id,
				organizationId: ORG_ID,
				status: "approved",
			});
		};
		return {
			db,
			target,
			context,
			client,
			workItemId,
			delegateRunner,
			enqueue,
			approve,
		};
	}

	it("automatic dispatch admits the canonical runtime run before sending the unchanged delivery key", async () => {
		const f = fixture(true);
		await f.enqueue("identity-auto");
		expect(f.db.workAttemptRows).toHaveLength(1);
		expect(f.db.workAttemptRows[0]).toMatchObject({
			runId: "tedi-cto-agent:mcp:identity-auto_workstation_tedi-cto-agent",
			executorType: "tedi",
			executorId: "tedi-cto-agent",
			orgId: ORG_ID,
		});
		expect(f.delegateRunner).toHaveBeenCalledTimes(1);
		expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
			"identity-auto:workstation:tedi-cto-agent",
		);
		expect(
			f.db.runs.find((row) => row.id === "identity-auto")?.childRunId,
		).toBe(f.db.workAttemptRows[0]!.runId);
	});

	it("approved attachment dispatch uses the original exact admission without replacing its Attempt", async () => {
		const f = fixture(false);
		await f.enqueue("identity-approved");
		expect(f.delegateRunner).not.toHaveBeenCalled();
		const before = structuredClone(f.db.workAttemptRows[0]);
		expect(before).toMatchObject({
			runtimeState: "running",
			expiresAt: expect.any(String),
		});
		expect(before!.expiresAt! > new Date().toISOString()).toBe(true);
		const result = await f.approve("identity-approved");
		expect(f.db.workAttemptRows).toEqual([before]);
		expect(result.run.childRunId).toBe(
			"tedi-cto-agent:mcp:identity-approved_workstation_tedi-cto-agent",
		);
		expect(result.run.childRunId).toBe(before!.runId);
		expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
			"identity-approved:workstation:tedi-cto-agent",
		);
	});

	it.each([
		"raw_run",
		"wrong_executor",
		"expired",
		"terminal_attempt",
		"terminal_home",
		"missing_target",
		"cross_org_target",
	] as const)(
		"approved attachment fails closed for %s without rewriting authority or dispatching",
		async (failure) => {
			const f = fixture(false);
			const home = `identity-${failure}`;
			await f.enqueue(home);
			const attempt = f.db.workAttemptRows[0]!;
			if (failure === "raw_run")
				attempt.runId = `${home}:workstation:tedi-cto-agent`;
			if (failure === "wrong_executor") attempt.executorId = "tedi-cpo";
			if (failure === "expired") attempt.expiresAt = "2000-01-01T00:00:00.000Z";
			if (failure === "terminal_attempt") attempt.runtimeState = "completed";
			if (failure === "terminal_home")
				f.db.runs.find((row) => row.id === home)!.status = "canceled";
			if (failure === "missing_target")
				f.db.tediRows.splice(f.db.tediRows.indexOf(f.target), 1);
			if (failure === "cross_org_target") f.target.organizationId = "other-org";
			const before = structuredClone(f.db.workAttemptRows);
			const homeBefore = structuredClone(
				f.db.runs.find((row) => row.id === home),
			);
			await expect(f.approve(home)).rejects.toThrow();
			expect(f.delegateRunner).not.toHaveBeenCalled();
			expect(f.db.workAttemptRows).toEqual(before);
			expect(f.db.runs.find((row) => row.id === home)).toEqual(homeBefore);
		},
	);

	it.each(["2099-01-01T00:00:00.000Z", null, "not-a-date", ""])(
		"automatic reentry rejects a raw-key Attempt with expiry %j without changing it",
		async (expiresAt) => {
			const f = fixture(true);
			const attempt = {
				...runningWorkAttempt(
					f.workItemId,
					f.target.id,
					"identity-raw:workstation:tedi-cto-agent",
				),
				admissionId: "existing-admission",
				expiresAt,
			};
			f.db.workAttemptRows.push(attempt);
			const before = structuredClone(attempt);
			await expect(f.enqueue("identity-raw")).rejects.toThrow(
				/exact admitted runtime run/,
			);
			expect(f.delegateRunner).not.toHaveBeenCalled();
			expect(f.db.workAttemptRows).toEqual([before]);
		},
	);

	it("a valid expired Attempt permits fresh canonical admission without rewriting history", async () => {
		const f = fixture(true);
		const expired = {
			...runningWorkAttempt(
				f.workItemId,
				f.target.id,
				"identity-expired:workstation:tedi-cto-agent",
			),
			admissionId: "old-admission",
			expiresAt: "2000-01-01T00:00:00.000Z",
		};
		f.db.workAttemptRows.push(expired);
		const before = structuredClone(expired);
		await f.enqueue("identity-expired");
		expect(f.db.workAttemptRows).toHaveLength(2);
		expect(f.db.workAttemptRows[0]).toEqual(before);
		expect(f.db.workAttemptRows[1]!.runId).toBe(
			"tedi-cto-agent:mcp:identity-expired_workstation_tedi-cto-agent",
		);
		expect(f.delegateRunner).toHaveBeenCalledTimes(1);
	});

	it.each(["requires_approval", "canceled"] as const)(
		"workstation recommendation with Home status %s preserves admission and terminal fences",
		async (status) => {
			const f = fixture(false);
			const homeRunId = "identity-recommendation";
			const workOrder = {
				id: `work-order:${homeRunId}`,
				objective: "Run the bounded native command",
				sourceContent: "Run the bounded native command",
				outputContract: "Return exact command output",
				targetTediId: f.target.id,
				executionRequirement: {
					surface: "workstation",
					requiredCapabilities: ["process"],
					fallbackSurface: null,
					prohibitedSurfaces: [],
					satisfiable: true,
					reason: "approved workstation task",
				},
			};
			const run = normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:test",
				status,
				delegatedTediId: f.target.id,
				metadata: {
					workItemId: f.workItemId,
					homeDelegation: {
						targetTediId: f.target.id,
						status: "requires_approval",
						workOrder,
						decision: {
							mode: "needs_approval",
							canAutoDispatch: false,
							reason: "operator approval",
						},
					},
					delegationWorkOrder: workOrder,
				},
				createdAt: new Date().toISOString(),
			});
			f.db.runs.push(run);
			if (status === "canceled") {
				const before = structuredClone({
					runs: f.db.runs,
					events: f.db.events,
					workItems: f.db.workItemRows,
					attempts: f.db.workAttemptRows,
				});
				await expect(
					respondKernelDelegationRecommendationApprovalCore(f.context, {
						run,
						organizationId: ORG_ID,
						decision: "approve",
					}),
				).rejects.toThrow(/Terminal Home run/);
				expect(f.delegateRunner).not.toHaveBeenCalled();
				expect({
					runs: f.db.runs,
					events: f.db.events,
					workItems: f.db.workItemRows,
					attempts: f.db.workAttemptRows,
				}).toEqual(before);
				return;
			}
			const result = await respondKernelDelegationRecommendationApprovalCore(
				f.context,
				{ run, organizationId: ORG_ID, decision: "approve" },
			);
			expect(f.db.workAttemptRows).toHaveLength(1);
			expect(f.db.workAttemptRows[0]!.runId).toBe(
				"tedi-cto-agent:mcp:identity-recommendation_workstation_tedi-cto-agent",
			);
			expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
				"identity-recommendation:workstation:tedi-cto-agent",
			);
			expect(result.run.childRunId).toBe(f.db.workAttemptRows[0]!.runId);
		},
	);
});

describe("respondApproval — held Home delegation authority and agent review fence", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
	});

	async function parkHeldDelegation(
		db: ReturnType<typeof createKernelRuntimeDb>,
		runId: string,
		agentReview?: Record<string, unknown>,
	) {
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "I prepared a delegation to CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product",
					risk: "high" as const,
					confidence: 0.9,
					effortClass: null,
					answer: null,
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Review the roadmap",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return a short summary",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Have CPO review the roadmap.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: false,
						mode: "needs_approval",
						approvalRoute: "agent",
						reason: "route classified as high risk",
					},
					...(agentReview ? { agentReview } : {}),
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);
		await createKernelRuntimeClient(createContext(db)).enqueueMessage({
			conversationId: "home:test",
			content: "Have CPO review the roadmap.",
			idempotencyKey: runId,
		});
		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			vi.fn(async (input: { childRunId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			})),
		);
	}

	function serviceBindingClient(
		db: ReturnType<typeof createKernelRuntimeDb>,
		headers: Record<string, string>,
		member?: { role: string; status: string },
	) {
		(db as unknown as { query: unknown }).query = {
			organizationMembers: {
				findFirst: vi.fn(async () =>
					member ? { ...member, organizationId: ORG_ID } : undefined,
				),
			},
		};
		const context = createContext(db);
		return createKernelRuntimeClient({
			...context,
			apiKey: undefined,
			authType: undefined,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": ORG_ID,
				"X-Tedix-Tedi-Scopes": "tedis:write tedis:read",
				...headers,
			}),
		} as unknown as BaseContext);
	}

	const PENDING_REVIEW = {
		status: "pending",
		approverTediId: "tedi-cto",
		approverTediLabel: "CTO",
		proposalId: "proposal-1",
		workItemId: "wi-held-1",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};

	it("refuses an operator without owner/admin authority", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-member-1");
		const client = serviceBindingClient(
			db,
			{ "X-Tedix-Acting-User": "member-user" },
			{ role: "member", status: "active" },
		);
		await expect(
			client.respondApproval({ runId: "held-member-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("owner or admin"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});

	it("refuses a tedi principal on the operator path", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-tedi-1");
		const client = serviceBindingClient(db, {
			"X-Tedix-Tedi-Id": "tedi-cpo",
		});
		await expect(
			client.respondApproval({ runId: "held-tedi-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("Work approval plane"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});

	it("lets an admin approve an ordinary held delegation", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-admin-1");
		const client = serviceBindingClient(
			db,
			{ "X-Tedix-Acting-User": "admin-user" },
			{ role: "admin", status: "active" },
		);
		const result = await client.respondApproval({
			runId: "held-admin-1",
			decision: "approve",
		});
		expect(result.run.status).toBe("queued");
	});

	it("returns CONFLICT on approve while the agent review is pending, but allows reject", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-pending-1", PENDING_REVIEW);
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.respondApproval({ runId: "held-pending-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("awaiting CTO"),
		});
		expect(db.workItemRows).toHaveLength(0);

		const rejected = await client.respondApproval({
			runId: "held-pending-1",
			decision: "reject",
			note: "not now",
		});
		expect(rejected.run.status).toBe("canceled");
	});

	it.each([
		[
			"the review expired",
			{ ...PENDING_REVIEW, expiresAt: "2020-01-01T00:00:00.000Z" },
		],
		[
			"the approver declined",
			{ ...PENDING_REVIEW, status: "rejected", rationale: "frozen" },
		],
		[
			"the review was unavailable",
			{ ...PENDING_REVIEW, status: "unavailable", reason: "no tools" },
		],
	])("lets the operator approve once %s", async (_label, review) => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-fallback-1", review);
		const result = await createKernelRuntimeClient(
			createContext(db),
		).respondApproval({ runId: "held-fallback-1", decision: "approve" });
		expect(result.run.status).toBe("queued");
	});

	it("latches atomically: a resolver holding a stale read loses with CONFLICT", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-race-1");
		const context = createContext(db);
		const stale = structuredClone(db.runs.find((r) => r.id === "held-race-1")!);
		await createKernelRuntimeClient(context).respondApproval({
			runId: "held-race-1",
			decision: "reject",
		});
		await expect(
			respondKernelDelegationRecommendationApprovalCore(context, {
				decision: "approve",
				organizationId: ORG_ID,
				run: stale as unknown as Parameters<
					typeof respondKernelDelegationRecommendationApprovalCore
				>[1]["run"],
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("changed while it was being resolved"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});
});
