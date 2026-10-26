/**
 * Shared in-memory D1 fake and fixtures for the kernel runtime router tests.
 * Split out of kernel-runtime.test.ts so each suite stays a readable size;
 * the vi.mock blocks stay in each test file because vitest hoists them per file.
 */
import { SQL } from "drizzle-orm";
import { createRouterClient } from "@orpc/server";
import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
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
import { workstationLeases } from "@tedix/db/schema/workstations";
import { tediApprovalExecutionReceipts } from "@tedix/db/schema/approval-simulations";
import { vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { kernelRuntimeContractRouter } from "../kernel-runtime";

export const ORG_ID = "org-1";
export const NATIVE_EXECUTION_REQUIREMENT: ExecutionRequirement = {
	surface: "native",
	requiredCapabilities: ["repository_read"],
	fallbackSurface: "workstation",
	prohibitedSurfaces: [],
	satisfiable: true,
	reason: "The test work order is executable on the native agent surface.",
};
export const WORKSTATION_EXECUTION_REQUIREMENT: ExecutionRequirement = {
	surface: "workstation",
	requiredCapabilities: ["process"],
	fallbackSurface: null,
	prohibitedSurfaces: [],
	satisfiable: true,
	reason: "The test work order requires an interactive process.",
};

export type KernelRuntimeEventRow = typeof kernelRuntimeEvents.$inferSelect;
export type KernelRuntimeEventInsert = typeof kernelRuntimeEvents.$inferInsert;
export type KernelRuntimeRunRow = typeof kernelRuntimeRuns.$inferSelect;
export type KernelRuntimeRunInsert = typeof kernelRuntimeRuns.$inferInsert;
export type KernelConversationGrantRow =
	typeof kernelConversationGrants.$inferSelect;
export type KernelConversationRow = typeof kernelConversations.$inferSelect;
export type KernelConversationInsert = typeof kernelConversations.$inferInsert;
export type TediApprovalRequestRow = typeof tediApprovalRequests.$inferSelect;
export type TediApprovalRequestInsert =
	typeof tediApprovalRequests.$inferInsert;
export type WorkItemRow = typeof workItems.$inferSelect;
export type WorkItemInsert = typeof workItems.$inferInsert;
export type WorkItemCommentRow = typeof workItemComments.$inferSelect;
export type WorkItemCommentInsert = typeof workItemComments.$inferInsert;
export type WorkItemRelationRow = typeof workItemRelations.$inferSelect;
export type WorkAttemptRow = typeof workAttempts.$inferSelect;
export type WorkEventRow = typeof workEvents.$inferSelect;
export type WorkEventInsert = typeof workEvents.$inferInsert;
export type WorkItemRelationInsert = typeof workItemRelations.$inferInsert;
export type HarnessSubjectVersionRow =
	typeof harnessSubjectVersions.$inferSelect;
export type HarnessSubjectVersionInsert =
	typeof harnessSubjectVersions.$inferInsert;
export type HarnessSubjectTraceBundleRow =
	typeof harnessSubjectTraceBundles.$inferSelect;
export type HarnessSubjectTraceBundleInsert =
	typeof harnessSubjectTraceBundles.$inferInsert;
export type TediRow = Pick<
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
export type ChatDispatchIdempotencyRow =
	typeof chatDispatchIdempotency.$inferSelect;

export const columnKeyByName: Record<string, string> = {
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

export function stringChunkValue(chunk: unknown): string {
	const value = (chunk as { value?: unknown }).value;
	return typeof value === "string" ? value : "";
}

export function sqlChunkText(chunk: unknown): string {
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

export function collectWhereConditions(
	value: unknown,
	conditions: Array<{
		key: string;
		op: "=" | "<" | "is null";
		value: unknown;
	}> = [],
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
		const key = columnKeyByName[chunk.name];
		if (!key) continue;
		const trailingSql = chunks
			.slice(index + 1, index + 4)
			.map(sqlChunkText)
			.join("")
			.trim();
		if (op === "is null" || trailingSql.startsWith("is null")) {
			conditions.push({ key, op: "is null", value: null });
			continue;
		}
		const param = chunks[index + 2] as { value?: unknown } | undefined;
		if (!param || !("value" in param)) continue;
		if (op === "=" || op === "<") {
			conditions.push({ key, op, value: param.value });
		}
	}
	return conditions;
}

export function applyWhere<Row extends Record<string, unknown>>(
	rows: Row[],
	whereClause: unknown,
): Row[] {
	const conditions = collectWhereConditions(whereClause);
	if (conditions.length === 0) return rows;
	const equalsByKey = new Map<string, Set<unknown>>();
	const lessThan: Array<{ key: string; value: unknown }> = [];
	const nullKeys = new Set<string>();
	for (const condition of conditions) {
		if (condition.op === "=") {
			const values = equalsByKey.get(condition.key) ?? new Set<unknown>();
			values.add(condition.value);
			equalsByKey.set(condition.key, values);
		} else if (condition.op === "is null") {
			nullKeys.add(condition.key);
		} else {
			lessThan.push(condition);
		}
	}
	return rows.filter((row) => {
		for (const key of nullKeys) {
			if ((row[key] ?? null) !== null) return false;
		}
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

export function isDescOrder(orderByClause: unknown): boolean {
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
export function evalRelationWhere(
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
		const separator = stringChunkValue(chunk).replace(/[()]/g, "").trim();
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
export function evalConversationIndexWhere(
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
		const separator = stringChunkValue(chunk).replace(/[()]/g, "").trim();
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

export function normalizeKernelConversationInsert(
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

export function normalizeKernelRuntimeEventInsert(
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

export function normalizeKernelRuntimeRunInsert(
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

export function normalizeTediApprovalRequestInsert(
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

export function normalizeWorkItemInsert(input: WorkItemInsert): WorkItemRow {
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

export function runningWorkAttempt(
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

export function normalizeWorkItemCommentInsert(
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

export type PolicyPackRow = {
	definition: Record<string, unknown> | null;
	organizationId?: string;
	status?: string;
};

// Indexed event reads still target this fixture's runtime-event table.
export function isRuntimeEventSource(source: unknown): boolean {
	return (
		source === tediRuntimeEvents ||
		(source instanceof SQL && source.queryChunks.includes(tediRuntimeEvents))
	);
}

export function createKernelRuntimeDb(opts?: {
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
		/** Fails the audit insert for this action. */
		auditInsertErrorAction: string | null;
	} = {
		artifactSelectError: null,
		childRuntimeSelectError: null,
		kernelEventInsertError: null,
		kernelRuntimeSelectError: null,
		auditInsertErrorAction: null,
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
						const row = value as Record<string, unknown>;
						if (row.action === controls.auditInsertErrorAction)
							throw new Error("audit unavailable");
						if (!auditRows.some((existing) => existing.id === row.id))
							auditRows.push(row);
						return this;
					},
					onConflictDoNothing() {
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
			if (isRuntimeEventSource(table)) {
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
					if (table === auditEvents) {
						selectedRows = [...auditRows] as unknown as typeof selectedRows;
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
					if (isRuntimeEventSource(table)) {
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
					if (table === workstationLeases) {
						selectedRows = [];
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
									).sql?.queryChunks?.[0];
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
						isRuntimeEventSource(selectedTable) &&
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

export function createMissingKernelRuntimeTableDb() {
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

export function createContext(
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

export function createKernelRuntimeClient(context: BaseContext) {
	return createRouterClient(kernelRuntimeContractRouter, { context });
}

export function childRuntimeEvent(input: {
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

export function grantRow(input: {
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

export function planAssignmentSeed(input: {
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
export function seedDependencyPlanRun(
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
