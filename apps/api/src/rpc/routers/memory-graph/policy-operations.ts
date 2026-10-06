import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
} from "../../orpc";
import type { CuriosityStatus } from "@tedix/db/queries/memory-graph/curiosity";
import type { GraphClient } from "../../../integrations/graph-db/neo4j";
import {
	GraphProjectionMaintenanceIdempotencyError,
	getGraphProjectionMaintenanceRun,
	reserveGraphProjectionMaintenanceRun,
} from "@tedix/db/queries/graph-projection-maintenance";
import type { GraphProjectionMaintenanceRun } from "@tedix/db/schema/graph-projection";
import type { NewMemoryFact } from "@tedix/db/schema/memory-graph";
import type { OptimizationSignalStatus } from "@tedix/db/queries/memory-graph/optimization-signals";
import { ensureGraphGdsRefreshWorkflow } from "../../../services/graph-gds-maintenance-scheduling";
import { getFactsByIds } from "@tedix/db/queries/memory-graph/facts";
import { getGraphClient } from "../../../integrations/graph-db/client";
import {
	getGraphProjectionBacklogStats,
	getGraphProjectionReadState,
} from "@tedix/db/queries/graph-projection";
import { implement } from "@orpc/server";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { memoryGraphContract } from "@tedix/api-contract/contracts/memory-graph";
import { requireOrgId } from "../../org-scope";

export const memoryGraphOs =
	implement(memoryGraphContract).$context<BaseContext>();

export const authed = memoryGraphOs.use(withAuth);

export const loadGraphProjectionCertification = () =>
	import("../../../services/graph-projection-certification");

export const loadGraphProjectionDrain = () =>
	import("../../../services/graph-projection-drain");

export const loadGraphProjectionEntities = () =>
	import("../../../services/graph-projection-entities");

export const loadGraphProjectionSchema = () =>
	import("../../../services/graph-projection-schema");

/**
 * Enforce the org-from-context invariant for a graph sync: a non-platform
 * caller may only sync their own org and may not pass a foreign `orgId`.
 * Platform principals may sync any org.
 */

export /**
 * Enforce the org-from-context invariant for a graph sync: a non-platform
 * caller may only sync their own org and may not pass a foreign `orgId`.
 * Platform principals may sync any org.
 */
function resolveSyncOrgId(
	context: BaseContext,
	requestedOrgId?: string,
): string {
	if (isPlatformPrincipal(context)) {
		return requestedOrgId ?? requireOrgId(context);
	}
	const orgId = requireOrgId(context);
	if (requestedOrgId && requestedOrgId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Cannot sync the graph for another organization",
		);
	}
	return orgId;
}

export function requireGraphMaintenanceAuthority(context: BaseContext): void {
	if (context.externalAgentPrincipalId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"External agents may contribute benchmark and entity evidence but cannot run graph projection maintenance",
		);
	}
	if (context.tediId) {
		const scopes = context.tediScopes ?? [];
		if (
			scopes.includes("*") ||
			scopes.includes("platform:admin") ||
			scopes.includes("mcp:memory.admin")
		) {
			return;
		}
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Graph projection maintenance requires mcp:memory.admin",
		);
	}
	if (
		context.authType === "user" &&
		(context.userRole === "owner" ||
			context.userRole === "admin" ||
			isPlatformPrincipal(context))
	) {
		return;
	}
	if (context.authType === "apikey") {
		const scopes = context.apiKey?.scopes ?? [];
		if (
			scopes.includes("*") ||
			scopes.includes("platform:admin") ||
			scopes.includes("mcp:memory.admin")
		) {
			return;
		}
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Graph projection maintenance requires owner/admin or mcp:memory.admin authority",
	);
}

export type MemoryScope = "org" | "tedi" | "kernel" | "session" | "graph";

export type MemoryUsePolicy =
	| "can_use_as_instruction"
	| "can_use_as_evidence"
	| "requires_user_confirmation"
	| "do_not_inject_automatically";

export type MemoryReviewStatus =
	| "pending"
	| "confirmed"
	| "evidence_only"
	| "restricted"
	| "stale"
	| "disputed"
	| "rejected"
	| "superseded";

export type Priority = "core" | "active" | "background";

export type Visibility = "private" | "shared" | "org";

export function objectRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function resolveMemoryFactReviewUpdates(
	input: {
		reviewStatus?: MemoryReviewStatus;
		usePolicy?: MemoryUsePolicy;
		priority?: Priority;
		visibility?: Visibility;
		topicKey?: string;
		archived?: boolean;
		reason?: string;
	},
	options: {
		now: string;
		existingMetadata?: Record<string, unknown> | null;
		reviewerTediId?: string | null;
		reviewerAuthType?: BaseContext["authType"] | null;
	},
): Partial<NewMemoryFact> {
	const updates: Partial<NewMemoryFact> = {};
	if (input.reviewStatus !== undefined)
		updates.reviewStatus = input.reviewStatus;
	if (input.usePolicy !== undefined) updates.usePolicy = input.usePolicy;
	if (input.priority !== undefined) updates.priority = input.priority;
	if (input.visibility !== undefined) updates.visibility = input.visibility;
	if (input.topicKey !== undefined) updates.topicKey = input.topicKey;
	if (input.archived !== undefined) {
		updates.archivedAt = input.archived ? options.now : null;
	}
	if (input.reviewStatus === "rejected") {
		updates.usePolicy ??= "do_not_inject_automatically";
		updates.priority ??= "background";
	}
	if (input.reviewStatus === "confirmed") {
		updates.status = "active";
		updates.lastVerifiedAt = options.now;
	}
	const metadata = objectRecord(options.existingMetadata);
	const memoryLifecycle = objectRecord(metadata.memoryLifecycle);
	updates.metadata = {
		...metadata,
		memoryLifecycle: {
			...memoryLifecycle,
			lastReview: {
				reviewedAt: options.now,
				...(options.reviewerTediId
					? {
							reviewerTediId: options.reviewerTediId,
						}
					: {}),
				...(options.reviewerAuthType
					? {
							reviewerAuthType: options.reviewerAuthType,
						}
					: {}),
				...(input.reviewStatus
					? {
							reviewStatus: input.reviewStatus,
						}
					: {}),
				...(input.usePolicy
					? {
							usePolicy: input.usePolicy,
						}
					: {}),
				...(input.priority
					? {
							priority: input.priority,
						}
					: {}),
				...(input.visibility
					? {
							visibility: input.visibility,
						}
					: {}),
				...(input.topicKey
					? {
							topicKey: input.topicKey,
						}
					: {}),
				...(input.archived !== undefined
					? {
							archived: input.archived,
						}
					: {}),
				...(input.reason
					? {
							reason: input.reason,
						}
					: {}),
			},
		},
	};
	return updates;
}

export const MEMORY_SCOPES = new Set<MemoryScope>([
	"org",
	"tedi",
	"kernel",
	"session",
	"graph",
]);

export const MEMORY_USE_POLICIES = new Set<MemoryUsePolicy>([
	"can_use_as_instruction",
	"can_use_as_evidence",
	"requires_user_confirmation",
	"do_not_inject_automatically",
]);

export const MEMORY_REVIEW_STATUSES = new Set<MemoryReviewStatus>([
	"pending",
	"confirmed",
	"evidence_only",
	"restricted",
	"stale",
	"disputed",
	"rejected",
	"superseded",
]);

export function metadataString(
	metadata: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

export function resolveMemoryScope(input: {
	memoryScope?: string;
	tediId?: string;
	metadata?: Record<string, unknown>;
}): MemoryScope {
	const raw =
		input.memoryScope ??
		metadataString(input.metadata, "memoryScope") ??
		metadataString(input.metadata, "scope");
	return raw && MEMORY_SCOPES.has(raw as MemoryScope)
		? (raw as MemoryScope)
		: input.tediId
			? "tedi"
			: "org";
}

export function resolveMemoryFactOwnership(input: {
	memoryScope: MemoryScope;
	inputTediId?: string | null;
	contextTediId?: string | null;
	forwardedTediId?: string | null;
	visibility?: string | null;
}): {
	tediId: string | null;
	visibility: "private" | "shared" | "org";
} {
	const tediId =
		input.inputTediId ?? input.contextTediId ?? input.forwardedTediId ?? null;
	if (input.memoryScope === "org") {
		return {
			tediId: null,
			visibility: (input.visibility as "private" | "shared" | "org") ?? "org",
		};
	}
	if (input.memoryScope === "tedi" && !tediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"tedi-scoped memory requires a tediId or authenticated tedi context",
		);
	}
	return {
		tediId,
		visibility:
			(input.visibility as "private" | "shared" | "org" | undefined) ??
			(tediId ? "private" : input.memoryScope === "graph" ? "private" : "org"),
	};
}

export function resolveUsePolicy(
	input: {
		usePolicy?: string;
		metadata?: Record<string, unknown>;
	},
	memoryScope: MemoryScope,
): MemoryUsePolicy {
	const raw =
		input.usePolicy ??
		metadataString(input.metadata, "usePolicy") ??
		metadataString(input.metadata, "usagePolicy");
	if (raw && MEMORY_USE_POLICIES.has(raw as MemoryUsePolicy)) {
		return raw as MemoryUsePolicy;
	}
	return memoryScope === "graph"
		? "do_not_inject_automatically"
		: "can_use_as_evidence";
}

export function resolveReviewStatus(input: {
	reviewStatus?: string;
	metadata?: Record<string, unknown>;
	memoryScope: MemoryScope;
	usePolicy: MemoryUsePolicy;
}): MemoryReviewStatus {
	const raw =
		input.reviewStatus ??
		metadataString(input.metadata, "reviewStatus") ??
		metadataString(input.metadata, "validationStatus");
	if (raw && MEMORY_REVIEW_STATUSES.has(raw as MemoryReviewStatus)) {
		return raw as MemoryReviewStatus;
	}
	if (
		input.memoryScope === "graph" ||
		input.usePolicy === "do_not_inject_automatically"
	) {
		return "evidence_only";
	}
	return "pending";
}

export function deriveTopicKey(
	input: {
		topicKey?: string;
		metadata?: Record<string, unknown>;
	},
	orgId: string,
): string | null {
	const explicit =
		input.topicKey ??
		metadataString(input.metadata, "topicKey") ??
		metadataString(input.metadata, "stateKey");
	if (explicit) return explicit;
	const orgSlug = metadataString(input.metadata, "orgSlug") ?? orgId;
	const connectorSlug =
		metadataString(input.metadata, "connectorSlug") ??
		metadataString(input.metadata, "appSlug");
	const stateKind =
		metadataString(input.metadata, "stateKind") ??
		metadataString(input.metadata, "stateType");
	if (connectorSlug && stateKind) {
		return `org:${orgSlug}.connector.${connectorSlug}.${stateKind}`;
	}
	const gatewaySlug = metadataString(input.metadata, "gatewaySlug");
	if (gatewaySlug && stateKind) {
		return `org:${orgSlug}.mcp_gateway.${gatewaySlug}.${stateKind}`;
	}
	const cmsCollection = metadataString(input.metadata, "cmsCollection");
	if (cmsCollection && stateKind) {
		return `org:${orgSlug}.cms.${cmsCollection}.${stateKind}`;
	}
	const entityType = metadataString(input.metadata, "entityType");
	const entityName = metadataString(input.metadata, "entityName");
	if (entityType && entityName) {
		const normalized = entityName.toLowerCase().trim().replace(/\s+/g, "-");
		return `entity:${entityType}:${normalized}`;
	}
	return null;
}

export function getHeader(
	context: BaseContext,
	name: string,
): string | undefined {
	return (
		context.headers.get(name) ??
		context.headers.get(name.toLowerCase()) ??
		undefined
	);
}

export function logMemorySearch(
	context: BaseContext,
	event: "start" | "complete",
	payload: Record<string, unknown>,
) {
	if (event === "start" && context.env.ENVIRONMENT !== "development") return;
	console.log(`[MemoryGraph.search] ${event} ${JSON.stringify(payload)}`);
}

/**
 * Stable, non-reversible short hash (djb2) for grouping identical retrieval
 * queries on the runtime spine WITHOUT persisting the raw query text.
 */

export /**
 * Stable, non-reversible short hash (djb2) for grouping identical retrieval
 * queries on the runtime spine WITHOUT persisting the raw query text.
 */
function cheapHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16);
}

export async function measureSearchPhase<T>(
	timings: Record<string, number>,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	try {
		return await fn();
	} finally {
		timings[name] = Date.now() - startedAt;
	}
}

export type GraphReadMeta = {
	graphConfigured: boolean;
	graphHealthy: boolean;
	projectionState: "disabled" | "catching_up" | "ready" | "degraded";
	projectionReady: boolean;
	projectionReason: string | null;
	persistedWatermark: number;
	gdsWatermark: number;
	degraded: boolean;
	source: "neo4j" | "none";
};

export async function getGraphReadState(
	context: BaseContext,
	options?: {
		requiresGds?: boolean;
	},
) {
	const orgId = requireOrgId(context);
	const checkedAt = new Date().toISOString();
	const graphClient = getGraphClient(context.env);
	const configured = graphClient !== null;
	const [healthy, readiness, backlog] = await Promise.all([
		graphClient ? graphClient.isHealthy().catch(() => false) : false,
		getGraphProjectionReadState(context.db, orgId),
		getGraphProjectionBacklogStats(context.db, orgId),
	]);
	const { graphProjectionReadAdmission } =
		await loadGraphProjectionCertification();
	const admission = graphProjectionReadAdmission({
		inspection: {
			transportHealthy: healthy,
			readiness,
			backlog,
			checkedAt,
		},
		requiresGds: options?.requiresGds,
	});
	const projectionState =
		readiness?.state === "ready" && !admission.allowed
			? "degraded"
			: (readiness?.state ?? (configured ? "degraded" : "disabled"));
	const meta: GraphReadMeta = {
		graphConfigured: configured,
		graphHealthy: healthy,
		projectionState,
		projectionReady: admission.allowed,
		projectionReason: admission.reason,
		persistedWatermark: readiness?.persistedWatermark ?? 0,
		gdsWatermark: readiness?.gdsWatermark ?? 0,
		degraded: !admission.allowed,
		source: admission.allowed ? "neo4j" : "none",
	};
	return {
		graphClient,
		meta,
	};
}

export function degradedGraphMeta(
	meta: GraphReadMeta,
	reason = "graph_query_failed",
): GraphReadMeta {
	return {
		...meta,
		projectionState: "degraded",
		projectionReady: false,
		projectionReason: reason,
		degraded: true,
		source: "none",
	};
}

export const curiosityStatuses = new Set<CuriosityStatus>([
	"queued",
	"exploring",
	"completed",
	"deferred",
]);

export const optimizationSignalStatuses = new Set<OptimizationSignalStatus>([
	"detected",
	"proposed",
	"approved",
	"executing",
	"completed",
	"dismissed",
]);

export function toCuriosityStatus(
	status?: string,
): CuriosityStatus | undefined {
	return status && curiosityStatuses.has(status as CuriosityStatus)
		? (status as CuriosityStatus)
		: undefined;
}

export function toOptimizationSignalStatus(
	status?: string,
): OptimizationSignalStatus | undefined {
	return status &&
		optimizationSignalStatuses.has(status as OptimizationSignalStatus)
		? (status as OptimizationSignalStatus)
		: undefined;
}

// =============================================================================
// SEARCH
// =============================================================================

// =============================================================================
// ASSEMBLE CONTEXT
// =============================================================================

// NOTE: The Home kernel does NOT call this handler on the per-turn path.
// It uses the bounded relevance blend in kernel/context-assembly.ts
// (assembleHomeContext: one org-scoped D1 search, fail-soft,
// ahead of the static getTopPlatformFacts top-N). Explicit graph assembly
// rechecks the D1-owned projection and GDS freshness on every request; when
// admission fails it degrades to D1 without graph-derived boosts.
export async function getContextAssemblyGraphClient(
	context: BaseContext,
): Promise<GraphClient | undefined> {
	const { graphClient, meta } = await getGraphReadState(context, {
		requiresGds: true,
	});
	return meta.degraded ? undefined : (graphClient ?? undefined);
}

export // =============================================================================
// GRAPH DB QUERIES (Neo4j-powered)
// =============================================================================

type VizNode = {
	id: string;
	label: string;
	type: "fact" | "decision" | "domain" | "tedi" | "skill" | "knowledge_entry";
	properties: Record<string, unknown>;
};

export type VizEdge = {
	source: string;
	target: string;
	type: string;
	properties: Record<string, unknown>;
};

/** Filter null entries from Cypher OPTIONAL MATCH results and coerce labels */

export /** Filter null entries from Cypher OPTIONAL MATCH results and coerce labels */
function sanitizeViz(raw: { nodes: unknown[]; edges: unknown[] }): {
	nodes: VizNode[];
	edges: VizEdge[];
} {
	const nodes = (raw.nodes ?? [])
		.filter(
			(n: unknown): n is Record<string, unknown> =>
				n != null &&
				typeof n === "object" &&
				(n as Record<string, unknown>).id != null,
		)
		.map((n) => ({
			...n,
			label: String(n.label ?? n.id ?? ""),
			properties: (n.properties as Record<string, unknown>) ?? {},
		})) as VizNode[];
	const edges = (raw.edges ?? [])
		.filter(
			(e: unknown): e is Record<string, unknown> =>
				e != null &&
				typeof e === "object" &&
				(e as Record<string, unknown>).source != null &&
				(e as Record<string, unknown>).target != null,
		)
		.map((e) => ({
			...e,
			type: String(e.type ?? "RELATED_TO"),
			properties: (e.properties as Record<string, unknown>) ?? {},
		})) as VizEdge[];
	return {
		nodes,
		edges,
	};
}

export async function getCanonicalGraphFacts(
	context: BaseContext,
	orgId: string,
	factIds: string[],
) {
	const ids = [...new Set(factIds)].slice(0, 500);
	const facts = [];
	for (let offset = 0; offset < ids.length; offset += 80) {
		facts.push(
			...(await getFactsByIds(context.db, ids.slice(offset, offset + 80), {
				includeGraphAnchors: true,
			})),
		);
	}
	return facts.filter((fact) => fact.organizationId === orgId);
}

export async function hydrateGraphVisualization(
	context: BaseContext,
	orgId: string,
	raw: {
		nodes: unknown[];
		edges: unknown[];
	},
) {
	const sanitized = sanitizeViz(raw);
	const factIds = sanitized.nodes
		.filter((node) => node.type === "fact")
		.map((node) => node.id);
	const canonicalFacts = await getCanonicalGraphFacts(context, orgId, factIds);
	const canonicalById = new Map(canonicalFacts.map((fact) => [fact.id, fact]));
	const nodes = sanitized.nodes
		.filter((node) => node.type !== "fact" || canonicalById.has(node.id))
		.map((node) => {
			if (node.type !== "fact") return node;
			const fact = canonicalById.get(node.id)!;
			return {
				...node,
				label: fact.summary ?? fact.content.slice(0, 80),
				properties: {
					...node.properties,
					factType: fact.factType,
					confidence: fact.confidence,
					priority: fact.priority,
					visibility: fact.visibility,
					domainId: fact.domainId,
					tediId: fact.tediId,
				},
			};
		});
	const retainedIds = new Set(nodes.map((node) => node.id));
	return {
		nodes,
		edges: sanitized.edges.filter(
			(edge) => retainedIds.has(edge.source) && retainedIds.has(edge.target),
		),
	};
}

export // =============================================================================
// GRAPH MAINTENANCE (orphan cleanup, dedup detection, stats)
// =============================================================================

const GRAPH_GDS_TASK_PREFIX = "graph-gds-";

export const GRAPH_GDS_TASK_POLL_INTERVAL_MS = 2_500;

export type GraphGdsTaskStatus =
	| "queued"
	| "running"
	| "cancel_requested"
	| "completed"
	| "failed"
	| "cancelled";

export type GraphGdsTaskResult = {
	operation: "gds_refresh";
	organizationId: string;
	watermark: number;
	epoch: string;
};

export type GraphGdsTask = {
	id: string;
	workflowId: string;
	status: GraphGdsTaskStatus;
	createdAt: string;
	lastUpdatedAt: string;
	pollWith: "tasks/get";
	pollIntervalMs: number;
	result: GraphGdsTaskResult | null;
	error: string | null;
};

export function parseGraphGdsTaskResult(
	value: unknown,
	organizationId: string,
): GraphGdsTaskResult | null {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).operation !== "gds_refresh" ||
		(value as Record<string, unknown>).organizationId !== organizationId ||
		typeof (value as Record<string, unknown>).watermark !== "number" ||
		typeof (value as Record<string, unknown>).epoch !== "string"
	) {
		return null;
	}
	const record = value as Record<string, unknown>;
	return {
		operation: "gds_refresh",
		organizationId: record.organizationId as string,
		watermark: record.watermark as number,
		epoch: record.epoch as string,
	};
}

export async function graphGdsTaskId(
	runtimeEnvironment: "development" | "staging" | "production",
	organizationId: string,
	idempotencyKey: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			`${runtimeEnvironment}\u0000${organizationId}\u0000${idempotencyKey}`,
		),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${GRAPH_GDS_TASK_PREFIX}${hex}`;
}

export function graphGdsTaskFromRun(
	row: GraphProjectionMaintenanceRun,
): GraphGdsTask {
	let status = row.status === "canceled" ? "cancelled" : row.status;
	const completedResult =
		status === "completed"
			? parseGraphGdsTaskResult(row.result, row.organizationId)
			: null;
	if (status === "completed" && !completedResult) {
		status = "failed";
	}
	return {
		id: row.id,
		workflowId: row.workflowId,
		status: status as GraphGdsTaskStatus,
		createdAt: row.createdAt,
		lastUpdatedAt: row.updatedAt,
		pollWith: "tasks/get",
		pollIntervalMs: GRAPH_GDS_TASK_POLL_INTERVAL_MS,
		result: status === "completed" ? completedResult : null,
		error:
			status === "failed"
				? (row.error ??
					(row.status === "completed"
						? "GDS refresh completed without a valid atomic receipt"
						: "GDS refresh failed"))
				: null,
	};
}

export function validateGraphGdsMaintenanceRequest(input: {
	operations: readonly string[];
	idempotencyKey?: string;
}): void {
	if (!input.operations.includes("reindex")) return;
	if (input.operations.length !== 1) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"reindex must be requested alone because it starts a durable asynchronous operation",
		);
	}
	if (!input.idempotencyKey) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"reindex requires a caller-stable idempotencyKey",
		);
	}
}

export async function graphGdsTaskForOrg(
	context: BaseContext,
	taskId: string,
): Promise<GraphGdsTask> {
	const organizationId = requireOrgId(context);
	if (!taskId.startsWith(GRAPH_GDS_TASK_PREFIX)) {
		throw createError(ErrorCodes.NOT_FOUND, "Graph GDS task not found");
	}
	const row = await getGraphProjectionMaintenanceRun(
		context.db,
		context.env.ENVIRONMENT,
		organizationId,
		taskId,
	);
	if (row?.operation !== "gds_refresh" || row.workflowId !== taskId) {
		throw createError(ErrorCodes.NOT_FOUND, "Graph GDS task not found");
	}
	return graphGdsTaskFromRun(row);
}

export async function startGraphGdsTask(
	context: BaseContext,
	idempotencyKey: string,
): Promise<{
	task: GraphGdsTask;
	deduplicated: boolean;
}> {
	const organizationId = requireOrgId(context);
	const stableKey = idempotencyKey;
	const taskId = await graphGdsTaskId(
		context.env.ENVIRONMENT,
		organizationId,
		stableKey,
	);
	let reserved: Awaited<
		ReturnType<typeof reserveGraphProjectionMaintenanceRun>
	>;
	try {
		reserved = await reserveGraphProjectionMaintenanceRun(context.db, {
			id: taskId,
			runtimeEnvironment: context.env.ENVIRONMENT,
			organizationId,
			operation: "gds_refresh",
			idempotencyKey: stableKey,
			requestFingerprint: "gds_refresh:v1",
		});
	} catch (error) {
		if (error instanceof GraphProjectionMaintenanceIdempotencyError) {
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		throw error;
	}
	await ensureGraphGdsRefreshWorkflow(
		context.env.GRAPH_GDS_REFRESH_WORKFLOW,
		{
			id: taskId,
			runtimeEnvironment: context.env.ENVIRONMENT,
			organizationId,
			source: "mcp",
		},
		{
			// The successful first reservation proves this is a new deterministic
			// id, so avoid an unnecessary provider status round-trip on the latency
			// critical start path. Replays still reconcile before creating.
			preferCreate: !reserved.deduplicated,
		},
	);
	return {
		task: graphGdsTaskFromRun(reserved.run),
		deduplicated: reserved.deduplicated,
	};
}

export // Helper: run a raw Cypher query using graph-db driver
async function runGraphQuery(
	context: BaseContext,
	queryObj: {
		query: string;
		params: Record<string, unknown>;
	},
): Promise<Record<string, unknown>[]> {
	const { runCypherWithParams } =
		await import("../../../integrations/graph-db/client");
	return runCypherWithParams(context.env, queryObj.query, queryObj.params);
}

export function toNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "number") return value;
	return Number(value) || 0;
}

// =============================================================================
// OPTIMIZE (unified: curiosity + optimization signals)
// =============================================================================
