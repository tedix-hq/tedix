/**
 * Durable D1 -> Neo4j projection drain and bounded baseline repair.
 *
 * The outbox cursor is strict per organization: any retry/poison event blocks
 * later acknowledgement. Baseline repair uses stable `id` keysets and bulk
 * Neo4j writers so tens of thousands of facts do not become tens of thousands
 * of HTTP calls.
 */

import type { DbClient } from "@tedix/db/client";
import {
	acquireGraphProjectionLease,
	getGraphProjectionReadState,
	readGraphDomainBackfillPage,
	readGraphEdgeBackfillPage,
	readGraphFactBackfillPage,
	releaseGraphProjectionLease,
} from "@tedix/db/queries/graph-projection";
import {
	GraphProjectionHydrationError,
	runGraphProjectionDrain,
} from "./graph-projection-drain-engine";
import {
	getProjectionCapability,
	getProjectionCapabilityLink,
	getProjectionDecision,
	getProjectionDomain,
	getProjectionEdge,
	getProjectionExpertise,
	getProjectionFact,
	getProjectionKnowledgeEntry,
	getProjectionSkill,
	getProjectionTedi,
	listProjectionCapabilities,
	listProjectionCapabilityLinks,
	listProjectionDecisions,
	listProjectionEntities,
	listProjectionEntityResolutions,
	listProjectionExpertise,
	listProjectionProjects,
	listProjectionWorkItemSources,
	listProjectionWorkItems,
	listProjectionKnowledgeEntries,
	listProjectionSkills,
	listProjectionTedis,
} from "@tedix/db/queries/graph-projection-read-model";
import type {
	GraphProjectionEntityKind,
	GraphProjectionOutboxEvent,
	GraphProjectionRepairPhase,
} from "@tedix/db/schema/graph-projection";
import type {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "@tedix/db/schema/memory-graph";
import {
	type GraphWriter,
	processProjectionBatch,
} from "../integrations/graph-db/sync";
import type {
	GraphDecision,
	GraphDomain,
	GraphFact,
	GraphSyncEdge,
	SyncEvent,
} from "../integrations/graph-db/types";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_REPAIR_PAGE_SIZE = 100;
/**
 * The inline drain runs inside one request and holds its lease for a single
 * batch, so it takes a much shorter lease than the durable Workflow's default.
 * A stalled request therefore frees the organization in five minutes, not
 * fifteen.
 */
const DIRECT_DRAIN_LEASE_MS = 300_000;
/**
 * Keep canonical baseline reads well below Workers' per-invocation D1 query
 * ceiling. Router-owned lease/checkpoint writes and any post-repair drain use
 * the remaining headroom.
 */
export const GRAPH_PROJECTION_REPAIR_D1_QUERY_BUDGET = 200;
export const GRAPH_PROJECTION_REPAIR_CLEANUP_D1_QUERY_BUDGET = 200;
export const GRAPH_PROJECTION_REPAIR_MAX_PAGES = 100;
export const GRAPH_PROJECTION_REPAIR_D1_QUERIES_PER_PAGE_HEADROOM = 3;
export const GRAPH_PROJECTION_REPAIR_D1_FIXED_HEADROOM = 250;
export const GRAPH_PROJECTION_REPAIR_D1_QUERY_CEILING =
	GRAPH_PROJECTION_REPAIR_D1_QUERY_BUDGET +
	GRAPH_PROJECTION_REPAIR_CLEANUP_D1_QUERY_BUDGET +
	GRAPH_PROJECTION_REPAIR_MAX_PAGES *
		GRAPH_PROJECTION_REPAIR_D1_QUERIES_PER_PAGE_HEADROOM +
	GRAPH_PROJECTION_REPAIR_D1_FIXED_HEADROOM;
export const GRAPH_PROJECTION_DECISION_PREDECESSOR_PAGE_SIZE = 50;
export const GRAPH_PROJECTION_POST_REPAIR_DRAIN_EVENT_BUDGET = 31;
// Two equally expensive worst cases at nine statements each. A clean batch:
// two lease-acquire statements, readiness/cursor/batch reads, the pre-write
// renewal, the checkpoint's renewal and cursor advance, and release. A
// last-event writer failure: the same reads and pre-write renewal, then two
// failure updates and release instead of the checkpoint.
export const GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_UPPER_BOUND = 9;
export const GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_HEADROOM = 9;
export const GRAPH_PROJECTION_POST_REPAIR_DRAIN_D1_QUERY_CEILING =
	GRAPH_PROJECTION_POST_REPAIR_DRAIN_EVENT_BUDGET +
	GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_HEADROOM;
export const GRAPH_PROJECTION_SYNC_D1_QUERY_CEILING =
	GRAPH_PROJECTION_REPAIR_D1_QUERY_CEILING +
	GRAPH_PROJECTION_POST_REPAIR_DRAIN_D1_QUERY_CEILING;

export class GraphProjectionRepairQueryBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphProjectionRepairQueryBudgetError";
	}
}

/**
 * Every baseline-repair phase reads a complete canonical page with one
 * set-based Drizzle SELECT. Keeping the bound explicit makes future page-reader
 * changes fail review/tests instead of silently eroding the invocation budget.
 */
export const GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND = 1;

export const GRAPH_PROJECTION_REPAIR_PHASE_ORDER = [
	"domains",
	"facts",
	"edges",
	"tedis",
	"decisions",
	"decision_predecessors",
	"knowledge_entries",
	"skills",
	"tedi_expertise",
	"capabilities",
	"capability_links",
	"entities",
	"entity_resolutions",
	"projects",
	"work_items",
	"work_item_sources",
	"sweep",
	"complete",
] as const satisfies readonly GraphProjectionRepairPhase[];

export type GraphProjectionExtensionHydrator = (
	db: DbClient,
	event: GraphProjectionOutboxEvent,
) => Promise<SyncEvent | null>;

export type GraphProjectionDrainResult = {
	organizationId: string;
	acquired: boolean;
	processed: number;
	cursorBefore: number;
	cursorAfter: number;
	highWaterSequence: number | null;
	blocked:
		| null
		| "leased"
		| "retry_backoff"
		| "projection_error"
		| "lease_lost"
		| "epoch_changed";
	failedSequence: number | null;
};

export type GraphProjectionRepairCheckpoint = {
	phase: GraphProjectionRepairPhase;
	cursor: string | null;
};

export type GraphProjectionRepairResult = {
	checkpoint: GraphProjectionRepairCheckpoint;
	pagesProcessed: number;
	domainsProjected: number;
	factsProjected: number;
	edgesProjected: number;
	projectedByKind: Partial<Record<GraphProjectionEntityKind, number>>;
	canonicalD1QueriesUsed: number;
	stoppedReason: "query_budget" | "max_pages" | null;
};

export type GraphProjectionPostRepairDrainPlan = {
	maxBatches: 0 | 1;
	batchSize: number;
	d1QueryCeiling: number;
};

/**
 * A graph.sync invocation may finish a baseline page loop and still have
 * ordered outbox work after the captured high-water mark. Keep that inline
 * drain deliberately small: one call, at most 32 hydrated events. Remaining
 * backlog stays durable for the projection Workflow or the next sync request.
 */
export function planPostRepairGraphProjectionDrain(input: {
	repairComplete: boolean;
	requestedBatches: number;
	requestedBatchSize: number;
}): GraphProjectionPostRepairDrainPlan {
	const enabled = input.repairComplete && input.requestedBatches > 0;
	return {
		maxBatches: enabled ? 1 : 0,
		batchSize: enabled
			? Math.max(
					1,
					Math.min(
						GRAPH_PROJECTION_POST_REPAIR_DRAIN_EVENT_BUDGET,
						Math.trunc(input.requestedBatchSize),
					),
				)
			: 0,
		d1QueryCeiling: enabled
			? GRAPH_PROJECTION_POST_REPAIR_DRAIN_D1_QUERY_CEILING
			: 0,
	};
}

type RepairEventPage = {
	events: SyncEvent[];
	nextCursor: string | null;
	done: boolean;
};

function nextRepairPhase(
	phase: GraphProjectionRepairPhase,
): GraphProjectionRepairPhase {
	const index = GRAPH_PROJECTION_REPAIR_PHASE_ORDER.indexOf(phase);
	return GRAPH_PROJECTION_REPAIR_PHASE_ORDER[index + 1] ?? "complete";
}

function eventPage<T extends { id: string }>(
	rows: T[],
	limit: number,
	toEvent: (row: T) => SyncEvent,
): RepairEventPage {
	const done = rows.length <= limit;
	const page = rows.slice(0, limit);
	return {
		events: page.map(toEvent),
		nextCursor: done ? null : (page.at(-1)?.id ?? null),
		done,
	};
}

async function readManagedRepairEventPage(input: {
	db: DbClient;
	organizationId: string;
	repairEpoch: string;
	phase: Exclude<
		GraphProjectionRepairPhase,
		"domains" | "facts" | "edges" | "sweep" | "complete"
	>;
	afterId: string | null;
	limit: number;
}): Promise<RepairEventPage> {
	const pageLimit = input.limit + 1;
	const repairEvent = (
		entityKind: GraphProjectionEntityKind,
		entityId: string,
	) =>
		syntheticRepairEvent({
			organizationId: input.organizationId,
			entityKind,
			entityId,
			repairEpoch: input.repairEpoch,
		});
	switch (input.phase) {
		case "tedis":
			return eventPage(
				await listProjectionTedis(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(repairEvent("tedi", row.id), "upsert_tedi", {
						id: row.id,
						orgId: row.organizationId,
						slug: row.slug,
						name: row.name,
					}),
			);
		case "decisions":
		case "decision_predecessors":
			return eventPage(
				await listProjectionDecisions(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(repairEvent("decision", row.id), "upsert_decision", {
						id: row.id,
						tediId: row.tediId,
						orgId: row.orgId,
						action: row.action,
						rationale: row.rationale,
						category: row.category,
						confidence: row.confidence,
						outcomeStatus: row.outcomeStatus,
						evidence: JSON.stringify(row.evidence ?? {}),
						objectiveId: row.objectiveId ?? null,
						approvalRequestId: row.approvalRequestId ?? null,
						createdAt: row.createdAt,
						completedAt: row.completedAt ?? null,
					}),
			);
		case "knowledge_entries":
			return eventPage(
				await listProjectionKnowledgeEntries(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) => {
					const event = repairEvent("knowledge_entry", row.id);
					return syncEvent(event, "upsert_knowledge_entry", {
						id: row.id,
						orgId: row.organizationId,
						tediId: row.tediId ?? null,
						domainId: row.domainId ?? null,
						title: row.title,
						content: row.content,
						entryType: row.entryType,
						confidence: row.confidence,
						visibility: row.visibility,
						revision: row.revision,
						sourceFactIds: row.sourceFactIds ?? null,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					});
				},
			);
		case "skills":
			return eventPage(
				await listProjectionSkills(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) => {
					const event = repairEvent("skill", row.id);
					return syncEvent(event, "upsert_skill", {
						id: row.id,
						orgId: row.organizationId,
						tediId: row.tediId ?? null,
						domainId: row.domainId ?? null,
						title: row.title,
						content: row.content,
						visibility: row.visibility,
						slug: row.slug ?? null,
						successCount: row.successCount,
						failureCount: row.failureCount,
						revision: row.revision,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					});
				},
			);
		case "projects":
			return eventPage(
				await listProjectionProjects(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) => {
					const event = repairEvent("project", row.id);
					return syncEvent(event, "upsert_project", {
						id: row.id,
						orgId: row.organizationId,
						key: row.key,
						name: row.name,
						status: row.status,
						leadTediId: row.leadTediId ?? null,
						objectiveId: row.objectiveId ?? null,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					});
				},
			);
		case "work_items":
			return eventPage(
				await listProjectionWorkItems(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) => {
					const event = repairEvent("work_item", row.id);
					return syncEvent(event, "upsert_work_item", {
						id: row.id,
						orgId: row.organizationId,
						title: row.title,
						workKind: row.workKind,
						disposition: row.disposition,
						priority: row.priority,
						projectId: row.projectId ?? null,
						parentWorkItemId: row.parentWorkItemId ?? null,
						assigneeTediId: row.assigneeTediId ?? null,
						objectiveId: row.objectiveId ?? null,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					});
				},
			);
		case "work_item_sources":
			return eventPage(
				await listProjectionWorkItemSources(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) => {
					const event = repairEvent("work_item_source", row.id);
					return syncEvent(event, "upsert_work_item_source", {
						id: row.id,
						orgId: row.organizationId,
						provider: row.provider,
						externalId: row.externalId,
						kind: row.kind,
						state: row.state,
						title: row.title ?? null,
						externalUrl: row.externalUrl ?? null,
						projectId: row.projectId ?? null,
						workItemId: row.workItemId ?? null,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					});
				},
			);
		case "tedi_expertise":
			return eventPage(
				await listProjectionExpertise(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(
						repairEvent("tedi_expertise", row.id),
						"upsert_tedi_expertise",
						{
							orgId: input.organizationId,
							tediId: row.tediId,
							domainId: row.domainId,
							level: row.level,
							avgConfidence: row.avgConfidence,
						},
					),
			);
		case "capabilities":
			return eventPage(
				await listProjectionCapabilities(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(repairEvent("capability", row.id), "upsert_capability", {
						id: row.id,
						orgId: row.organizationId,
						parentId: row.parentId ?? null,
						name: row.name,
						slug: row.slug,
						valueStream: row.valueStream ?? null,
						paceLayer: row.paceLayer,
						maturityScore: row.maturityScore ?? null,
						status: row.status,
					}),
			);
		case "capability_links":
			return eventPage(
				await listProjectionCapabilityLinks(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(
						repairEvent("capability_link", row.id),
						"upsert_capability_link",
						{
							orgId: row.organizationId,
							capabilityId: row.capabilityId,
							entityKind: row.entityKind,
							entityId: row.entityId,
						},
					),
			);
		case "entities":
			return eventPage(
				await listProjectionEntities(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(repairEvent("entity", row.id), "upsert_entity", {
						id: row.id,
						orgId: row.organizationId,
						entityType: row.entityType,
						displayName: row.displayName,
						normalizedName: row.normalizedName,
						status: row.status,
						mergedIntoEntityId: row.mergedIntoEntityId ?? null,
						version: row.version,
						updatedAt: row.updatedAt,
					}),
			);
		case "entity_resolutions":
			return eventPage(
				await listProjectionEntityResolutions(input.db, {
					organizationId: input.organizationId,
					afterId: input.afterId,
					limit: pageLimit,
				}),
				input.limit,
				(row) =>
					syncEvent(
						repairEvent("entity_resolution", row.id),
						"upsert_entity_resolution",
						{
							id: row.id,
							orgId: row.organizationId,
							mentionId: row.mentionId,
							factId: row.sourceFactId,
							entityId: row.entityId!,
							decisionId: row.decisionId,
							confidence: row.confidence,
							validFrom: row.validFrom,
							validTo: row.validTo,
							status: row.status,
						},
					),
			);
	}
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function stringField(
	value: unknown,
	field: string,
	options?: { nullable?: boolean },
): string | null {
	const candidate = asObject(value)[field];
	if (typeof candidate === "string" && candidate.length > 0) return candidate;
	if (options?.nullable && (candidate === null || candidate === undefined)) {
		return null;
	}
	throw new Error(`Graph projection tombstone is missing ${field}`);
}

export function graphFactFromCanonical(
	fact: typeof memoryFacts.$inferSelect,
): GraphFact {
	return {
		id: fact.id,
		orgId: fact.organizationId,
		tediId: fact.tediId ?? null,
		domainId: fact.domainId ?? null,
		content: fact.content,
		summary: fact.summary ?? null,
		factType: fact.factType,
		confidence: fact.confidence,
		validTo: fact.validTo ?? null,
		archivedAt: fact.archivedAt ?? null,
		priority: fact.priority ?? null,
		visibility: fact.visibility ?? null,
		accessCount: fact.accessCount,
		usageCount: fact.usageCount,
		createdAt: fact.createdAt ?? null,
		updatedAt: fact.updatedAt ?? fact.createdAt ?? null,
	};
}

export function graphDomainFromCanonical(
	domain: typeof memoryDomains.$inferSelect,
): GraphDomain {
	return {
		id: domain.id,
		orgId: domain.organizationId,
		name: domain.name,
		parentId: domain.parentId ?? null,
		description: domain.description ?? null,
	};
}

export function graphEdgeFromCanonical(
	edge: typeof memoryEdges.$inferSelect & { organizationId: string },
): GraphSyncEdge {
	return {
		id: edge.id,
		orgId: edge.organizationId,
		sourceFactId: edge.sourceFactId,
		targetFactId: edge.targetFactId,
		relationType: edge.relationType,
		strength: edge.strength,
		context: edge.context ?? null,
		updatedAt: edge.createdAt ?? null,
	};
}

function syncEvent(
	event: GraphProjectionOutboxEvent,
	op: SyncEvent["op"],
	payload?: SyncEvent["payload"],
): SyncEvent {
	return {
		op,
		id: event.entityId,
		orgId: event.organizationId,
		timestamp: Date.parse(event.createdAt) || Date.now(),
		...(payload ? { payload } : {}),
	};
}

function deleteEventFor(event: GraphProjectionOutboxEvent): SyncEvent {
	switch (event.entityKind) {
		case "fact":
			return syncEvent(event, "delete_fact");
		case "edge": {
			const payload = event.payload;
			const edge: GraphSyncEdge = {
				id: event.entityId,
				orgId: event.organizationId,
				sourceFactId: stringField(payload, "sourceFactId")!,
				targetFactId: stringField(payload, "targetFactId")!,
				relationType: stringField(
					payload,
					"relationType",
				)! as GraphSyncEdge["relationType"],
				strength: 0,
				context: null,
				updatedAt: event.createdAt,
			};
			return syncEvent(event, "delete_edge", edge);
		}
		case "domain":
			return syncEvent(event, "delete_domain");
		case "tedi":
			return syncEvent(event, "delete_tedi");
		case "decision":
			return syncEvent(event, "delete_decision");
		case "knowledge_entry":
			return syncEvent(event, "delete_knowledge_entry");
		case "skill":
			return syncEvent(event, "delete_skill");
		case "tedi_expertise":
			return syncEvent(event, "delete_tedi_expertise", {
				orgId: event.organizationId,
				tediId: stringField(event.payload, "tediId")!,
				domainId: stringField(event.payload, "domainId")!,
				level: "novice",
				avgConfidence: 0,
			});
		case "capability":
			return syncEvent(event, "delete_capability");
		case "capability_link":
			return syncEvent(event, "delete_capability_link", {
				orgId: event.organizationId,
				capabilityId: stringField(event.payload, "capabilityId")!,
				entityKind: stringField(event.payload, "entityKind")! as
					| "skill"
					| "app"
					| "tedi"
					| "objective",
				entityId: stringField(event.payload, "entityId")!,
			});
		case "entity":
			return syncEvent(event, "delete_entity");
		case "entity_resolution": {
			// The review timestamp is the canonical bitemporal cutoff. Keep the
			// event timestamp fallback for tombstones emitted before validTo was
			// added to the payload.
			const validTo =
				stringField(event.payload, "validTo", { nullable: true }) ??
				event.createdAt;
			return syncEvent(event, "revoke_entity_resolution", { validTo });
		}
		case "project":
			return syncEvent(event, "delete_project", undefined);
		case "work_item":
			return syncEvent(event, "delete_work_item", undefined);
		case "work_item_source":
			return syncEvent(event, "delete_work_item_source", undefined);
		default:
			throw new Error(
				`Unsupported graph projection delete kind: ${event.entityKind satisfies never}`,
			);
	}
}

async function hydrateCoreProjectionEvent(
	db: DbClient,
	event: GraphProjectionOutboxEvent,
): Promise<SyncEvent | null> {
	const orgId = event.organizationId;
	switch (event.entityKind) {
		case "fact": {
			const row = await getProjectionFact(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_fact", graphFactFromCanonical(row))
				: null;
		}
		case "edge": {
			const row = await getProjectionEdge(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_edge", graphEdgeFromCanonical(row))
				: null;
		}
		case "domain": {
			const row = await getProjectionDomain(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_domain", graphDomainFromCanonical(row))
				: null;
		}
		case "tedi": {
			const row = await getProjectionTedi(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_tedi", {
						id: row.id,
						orgId: row.organizationId,
						slug: row.slug,
						name: row.name,
					})
				: null;
		}
		case "decision": {
			const row = await getProjectionDecision(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_decision", {
						id: row.id,
						tediId: row.tediId,
						orgId: row.orgId,
						action: row.action,
						rationale: row.rationale,
						category: row.category,
						confidence: row.confidence,
						outcomeStatus: row.outcomeStatus,
						evidence: JSON.stringify(row.evidence ?? {}),
						objectiveId: row.objectiveId ?? null,
						approvalRequestId: row.approvalRequestId ?? null,
						createdAt: row.createdAt,
						completedAt: row.completedAt ?? null,
					})
				: null;
		}
		case "knowledge_entry": {
			const row = await getProjectionKnowledgeEntry(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_knowledge_entry", {
						id: row.id,
						orgId: row.organizationId,
						tediId: row.tediId ?? null,
						domainId: row.domainId ?? null,
						title: row.title,
						content: row.content,
						entryType: row.entryType,
						confidence: row.confidence,
						visibility: row.visibility,
						revision: row.revision,
						sourceFactIds: row.sourceFactIds ?? null,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					})
				: null;
		}
		case "skill": {
			const row = await getProjectionSkill(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_skill", {
						id: row.id,
						orgId: row.organizationId,
						tediId: row.tediId ?? null,
						domainId: row.domainId ?? null,
						title: row.title,
						content: row.content,
						visibility: row.visibility,
						slug: row.slug ?? null,
						successCount: row.successCount,
						failureCount: row.failureCount,
						revision: row.revision,
						createdAt: row.createdAt ?? event.createdAt,
						updatedAt: row.updatedAt ?? row.createdAt ?? event.createdAt,
					})
				: null;
		}
		case "tedi_expertise": {
			const row = await getProjectionExpertise(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_tedi_expertise", {
						orgId,
						tediId: row.tediId,
						domainId: row.domainId,
						level: row.level,
						avgConfidence: row.avgConfidence,
					})
				: null;
		}
		case "capability": {
			const row = await getProjectionCapability(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_capability", {
						id: row.id,
						orgId: row.organizationId,
						parentId: row.parentId ?? null,
						name: row.name,
						slug: row.slug,
						valueStream: row.valueStream ?? null,
						paceLayer: row.paceLayer,
						maturityScore: row.maturityScore ?? null,
						status: row.status,
					})
				: null;
		}
		case "capability_link": {
			const row = await getProjectionCapabilityLink(db, {
				organizationId: orgId,
				entityId: event.entityId,
			});
			return row
				? syncEvent(event, "upsert_capability_link", {
						orgId: row.organizationId,
						capabilityId: row.capabilityId,
						entityKind: row.entityKind,
						entityId: row.entityId,
					})
				: null;
		}
		case "entity":
		case "entity_resolution":
		// Work-graph kinds are materialized by the repair sweep, which already
		// carries the full payload; there is no incremental outbox producer to
		// re-hydrate from.
		case "project":
		case "work_item":
		case "work_item_source":
			return null;
		default:
			throw new Error(
				`Unsupported graph projection entity kind: ${event.entityKind satisfies never}`,
			);
	}
}

function stampDirectDrainUpsert(
	event: SyncEvent,
	projectionEpoch: string,
): SyncEvent {
	if (!event.op.startsWith("upsert_")) return event;
	if (!event.payload) {
		throw new Error(`${event.op} requires a canonical projection payload`);
	}
	return {
		...event,
		payload: {
			...event.payload,
			projectionEpoch,
		} as SyncEvent["payload"],
	};
}

export async function hydrateGraphProjectionEvent(
	db: DbClient,
	event: GraphProjectionOutboxEvent,
	projectionEpoch: string,
	extensionHydrator?: GraphProjectionExtensionHydrator,
): Promise<SyncEvent> {
	if (event.operation === "delete") return deleteEventFor(event);
	const core = await hydrateCoreProjectionEvent(db, event);
	if (core) {
		return stampDirectDrainUpsert(core, projectionEpoch);
	}
	if (
		(event.entityKind === "entity" ||
			event.entityKind === "entity_resolution") &&
		extensionHydrator
	) {
		const extended = await extensionHydrator(db, event);
		if (extended) {
			return stampDirectDrainUpsert(extended, projectionEpoch);
		}
	}
	// An upsert whose row no longer exists is the final delete state. Delete
	// tombstones for relation kinds are included on every trigger event.
	return deleteEventFor(event);
}

/**
 * Hydrate the endpoint facts an edge needs but the batch does not carry.
 *
 * The Neo4j driver MATCHes both endpoints before merging a relationship, then
 * reads the relationship back and throws when it wrote nothing. For an edge
 * whose endpoint Fact has not been projected yet that throw is permanent, not
 * transient: the endpoint's own upsert event can sit hundreds of thousands of
 * sequences later, and this drain applies events in sequence order, so the edge
 * is waiting on a node queued behind it. One organization deadlocked exactly
 * this way at sequence 350,799 and stopped projecting for 37 days while a
 * million events piled up behind the wall.
 *
 * D1 is canonical, so the endpoints are always readable here. Emitting them
 * ahead of the edge makes the merge satisfiable whatever order the outbox is
 * in, and each fact's own event later re-upserts the identical current row.
 */
export async function edgeEndpointFactEvents(
	db: DbClient,
	organizationId: string,
	events: readonly SyncEvent[],
	projectionEpoch: string,
	alreadyProjected: ReadonlySet<string> = new Set(),
): Promise<SyncEvent[]> {
	const carried = new Set<string>(alreadyProjected);
	for (const event of events) {
		if (event.op === "upsert_fact" && typeof event.id === "string") {
			carried.add(event.id);
		}
	}
	const wanted = new Set<string>();
	for (const event of events) {
		if (event.op !== "upsert_edge") continue;
		for (const field of ["sourceFactId", "targetFactId"] as const) {
			const id = stringField(event.payload, field);
			if (id && !carried.has(id)) wanted.add(id);
		}
	}
	const hydrated: SyncEvent[] = [];
	for (const entityId of wanted) {
		const row = await getProjectionFact(db, { organizationId, entityId });
		// A fact deleted from D1 cannot be projected. Leave the edge to fail its
		// own verification rather than inventing a node the canonical store does
		// not have.
		if (!row) continue;
		hydrated.push(
			stampDirectDrainUpsert(
				{
					op: "upsert_fact",
					id: row.id,
					orgId: organizationId,
					timestamp: Date.now(),
					payload: graphFactFromCanonical(row),
				},
				projectionEpoch,
			),
		);
	}
	return hydrated;
}

/**
 * Hydrate one coalesced batch for the inline drain.
 *
 * Unlike the Workflow, this path reads canonical rows event by event, so it
 * can name the exact outbox event that failed. The engine records the failure
 * against that single event instead of the whole batch.
 */
async function hydrateDirectDrainBatch(input: {
	db: DbClient;
	organizationId: string;
	events: GraphProjectionOutboxEvent[];
	projectionEpoch: string;
	extensionHydrator?: GraphProjectionExtensionHydrator;
}): Promise<SyncEvent[]> {
	const syncEvents: SyncEvent[] = [];
	const projectedFactIds = new Set<string>();
	for (const event of input.events) {
		try {
			const hydrated = await hydrateGraphProjectionEvent(
				input.db,
				event,
				input.projectionEpoch,
				input.extensionHydrator,
			);
			for (const endpoint of await edgeEndpointFactEvents(
				input.db,
				input.organizationId,
				[hydrated],
				input.projectionEpoch,
				projectedFactIds,
			)) {
				syncEvents.push(endpoint);
				if (typeof endpoint.id === "string") {
					projectedFactIds.add(endpoint.id);
				}
			}
			if (hydrated.op === "upsert_fact") projectedFactIds.add(hydrated.id);
			syncEvents.push(hydrated);
		} catch (error) {
			throw new GraphProjectionHydrationError(error, [event]);
		}
	}
	return syncEvents;
}

/**
 * The inline drain: one bounded batch inside a `graph.sync` request.
 *
 * Batching, cursor advancement and lease fencing come from the shared engine —
 * the same one the durable Workflow runs, only with each unit executed
 * directly instead of as a `step.do`. This function owns the parts that are
 * genuinely request-shaped: a short lease, the projection-epoch guard, and a
 * result the router can report without throwing.
 */
export async function drainGraphProjectionOrganization(input: {
	db: DbClient;
	writer: GraphWriter;
	organizationId: string;
	projectionEpoch: string;
	batchSize?: number;
	now?: Date;
	extensionHydrator?: GraphProjectionExtensionHydrator;
}): Promise<GraphProjectionDrainResult> {
	const projectionEpoch = input.projectionEpoch.trim();
	if (projectionEpoch.length === 0) {
		throw new Error(
			"Direct graph projection drain requires a stable projectionEpoch",
		);
	}
	const leaseToken = crypto.randomUUID();
	const acquired = await acquireGraphProjectionLease(
		input.db,
		input.organizationId,
		leaseToken,
		DIRECT_DRAIN_LEASE_MS,
	);
	if (!acquired) {
		return {
			organizationId: input.organizationId,
			acquired: false,
			processed: 0,
			cursorBefore: 0,
			cursorAfter: 0,
			highWaterSequence: null,
			blocked: "leased",
			failedSequence: null,
		};
	}

	try {
		const readiness = await getGraphProjectionReadState(
			input.db,
			input.organizationId,
		);
		if (readiness?.projectionEpoch !== projectionEpoch) {
			return {
				organizationId: input.organizationId,
				acquired: true,
				processed: 0,
				cursorBefore: 0,
				cursorAfter: 0,
				highWaterSequence: null,
				blocked: "epoch_changed",
				failedSequence: null,
			};
		}
		const nowMs = (input.now ?? new Date()).getTime();
		const run = await runGraphProjectionDrain({
			db: input.db,
			organizationId: input.organizationId,
			leaseToken,
			leaseMs: DIRECT_DRAIN_LEASE_MS,
			batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
			// One batch per request. Remaining backlog stays durable for the
			// Workflow or the next sync request; the router loops if it has budget.
			maxBatches: 1,
			now: () => nowMs,
			hydrate: (events) =>
				hydrateDirectDrainBatch({
					db: input.db,
					organizationId: input.organizationId,
					events,
					projectionEpoch,
					extensionHydrator: input.extensionHydrator,
				}),
			project: (events) => processProjectionBatch(events, input.writer),
		});
		const result = {
			organizationId: input.organizationId,
			acquired: true as const,
			processed: run.processed,
			cursorBefore: run.cursorBefore,
			cursorAfter: run.cursor,
			highWaterSequence: run.highWaterSequence,
		};
		switch (run.stop.kind) {
			case "drained":
			case "batch_budget":
				return { ...result, blocked: null, failedSequence: null };
			case "retry_backoff":
				return {
					...result,
					blocked: "retry_backoff",
					failedSequence: run.stop.headSequence,
				};
			case "hydration_failed":
			case "projection_failed":
				return {
					...result,
					blocked: "projection_error",
					failedSequence: run.stop.failedSequence,
				};
			case "lease_lost":
			case "cursor_fenced":
				return { ...result, blocked: "lease_lost", failedSequence: null };
			case "coordination_failed":
				// A lease-store or D1 failure is not an outbox condition the router
				// can report as blocked progress; surface it as the error it is.
				throw run.stop.error;
		}
	} finally {
		await releaseGraphProjectionLease(
			input.db,
			input.organizationId,
			leaseToken,
		);
	}
}

async function requireSuccessfulBatch(
	events: SyncEvent[],
	writer: GraphWriter,
): Promise<void> {
	await processProjectionBatch(events, writer);
}

async function projectFactRepairPage(
	writer: GraphWriter,
	rows: Array<typeof memoryFacts.$inferSelect>,
	projectionEpoch: string,
	repairEpoch: string,
): Promise<void> {
	const facts = rows.map((row) => ({
		...graphFactFromCanonical(row),
		projectionEpoch,
		projectionRepairEpoch: repairEpoch,
	}));
	if (writer.upsertFacts) {
		await writer.upsertFacts(facts);
		return;
	}
	await requireSuccessfulBatch(
		facts.map((fact) => ({
			op: "upsert_fact",
			id: fact.id,
			orgId: fact.orgId,
			timestamp: Date.now(),
			payload: fact,
		})),
		writer,
	);
}

async function projectEdgeRepairPage(
	writer: GraphWriter,
	rows: Array<typeof memoryEdges.$inferSelect & { organizationId: string }>,
	projectionEpoch: string,
	repairEpoch: string,
): Promise<void> {
	const edges = rows.map((row) => ({
		...graphEdgeFromCanonical(row),
		projectionEpoch,
		projectionRepairEpoch: repairEpoch,
	}));
	if (writer.upsertEdges) {
		await writer.upsertEdges(edges);
		return;
	}
	await requireSuccessfulBatch(
		edges.map((edge) => ({
			op: "upsert_edge",
			id: edge.id,
			orgId: edge.orgId,
			timestamp: Date.now(),
			payload: edge,
		})),
		writer,
	);
}

const REPAIR_PHASE_ENTITY_KIND = {
	tedis: "tedi",
	decisions: "decision",
	decision_predecessors: "decision",
	knowledge_entries: "knowledge_entry",
	skills: "skill",
	tedi_expertise: "tedi_expertise",
	capabilities: "capability",
	capability_links: "capability_link",
	entities: "entity",
	entity_resolutions: "entity_resolution",
	projects: "project",
	work_items: "work_item",
	work_item_sources: "work_item_source",
} as const satisfies Record<
	Exclude<
		GraphProjectionRepairPhase,
		"domains" | "facts" | "edges" | "sweep" | "complete"
	>,
	GraphProjectionEntityKind
>;

function syntheticRepairEvent(input: {
	organizationId: string;
	entityKind: GraphProjectionEntityKind;
	entityId: string;
	repairEpoch: string;
}): GraphProjectionOutboxEvent {
	return {
		sequence: 0,
		eventId: `repair:${input.repairEpoch}:${input.entityKind}:${input.entityId}`,
		organizationId: input.organizationId,
		entityKind: input.entityKind,
		entityId: input.entityId,
		operation: "upsert",
		payload: null,
		schemaVersion: 1,
		attemptCount: 0,
		nextAttemptAt: null,
		lastError: null,
		poisonedAt: null,
		createdAt: new Date().toISOString(),
	};
}

function attachProjectionEpochs(
	event: SyncEvent,
	projectionEpoch: string,
	repairEpoch: string,
): SyncEvent {
	if (!event.payload || typeof event.payload !== "object") return event;
	return {
		...event,
		payload: {
			...event.payload,
			projectionEpoch,
			projectionRepairEpoch: repairEpoch,
		} as SyncEvent["payload"],
	};
}

/**
 * Run a bounded, full-manifest baseline repair. Every successful page invokes
 * `onCheckpoint` before the next page so a Worker timeout can only replay one
 * idempotent page. The final sweep removes managed Neo4j rows that were not
 * stamped by this repair epoch; only then may the checkpoint become complete.
 */
export async function repairGraphProjectionCore(input: {
	db: DbClient;
	writer: GraphWriter;
	organizationId: string;
	projectionEpoch: string;
	repairEpoch: string;
	checkpoint?: GraphProjectionRepairCheckpoint;
	pageSize?: number;
	maxPages?: number;
	d1QueryBudget?: number;
	beforePage?: (checkpoint: GraphProjectionRepairCheckpoint) => Promise<void>;
	onCheckpoint?: (checkpoint: GraphProjectionRepairCheckpoint) => Promise<void>;
	sweepRepair: (repairEpoch: string) => Promise<void>;
}): Promise<GraphProjectionRepairResult> {
	let checkpoint: GraphProjectionRepairCheckpoint = input.checkpoint ?? {
		phase: "domains",
		cursor: null,
	};
	const pageSize = Math.max(
		1,
		Math.min(500, Math.trunc(input.pageSize ?? DEFAULT_REPAIR_PAGE_SIZE)),
	);
	const maxPages = Math.max(
		1,
		Math.min(
			GRAPH_PROJECTION_REPAIR_MAX_PAGES,
			Math.trunc(input.maxPages ?? 10),
		),
	);
	const d1QueryBudget = Math.max(
		1,
		Math.min(
			GRAPH_PROJECTION_REPAIR_D1_QUERY_BUDGET,
			Math.trunc(
				input.d1QueryBudget ?? GRAPH_PROJECTION_REPAIR_D1_QUERY_BUDGET,
			),
		),
	);
	let pagesProcessed = 0;
	let domainsProjected = 0;
	let factsProjected = 0;
	let edgesProjected = 0;
	let d1QueriesUsed = 0;
	let stoppedForQueryBudget = false;
	const projectedByKind: Partial<Record<GraphProjectionEntityKind, number>> =
		{};

	while (checkpoint.phase !== "complete" && pagesProcessed < maxPages) {
		if (checkpoint.phase === "domains") {
			if (d1QueriesUsed >= d1QueryBudget) {
				stoppedForQueryBudget = true;
				break;
			}
			d1QueriesUsed++;
			const page = await readGraphDomainBackfillPage(
				input.db,
				input.organizationId,
				{ afterId: checkpoint.cursor ?? undefined, limit: pageSize },
			);
			await input.beforePage?.(checkpoint);
			await requireSuccessfulBatch(
				page.rows.map((row) => {
					const domain = {
						...graphDomainFromCanonical(row),
						projectionEpoch: input.projectionEpoch,
						projectionRepairEpoch: input.repairEpoch,
					};
					return {
						op: "upsert_domain" as const,
						id: domain.id,
						orgId: domain.orgId,
						timestamp: Date.now(),
						payload: domain,
					};
				}),
				input.writer,
			);
			domainsProjected += page.rows.length;
			projectedByKind.domain = (projectedByKind.domain ?? 0) + page.rows.length;
			checkpoint = page.done
				? { phase: nextRepairPhase("domains"), cursor: null }
				: { phase: "domains", cursor: page.nextCursor };
		} else if (checkpoint.phase === "facts") {
			if (d1QueriesUsed >= d1QueryBudget) {
				stoppedForQueryBudget = true;
				break;
			}
			d1QueriesUsed++;
			const page = await readGraphFactBackfillPage(
				input.db,
				input.organizationId,
				{ afterId: checkpoint.cursor ?? undefined, limit: pageSize },
			);
			await input.beforePage?.(checkpoint);
			await projectFactRepairPage(
				input.writer,
				page.rows,
				input.projectionEpoch,
				input.repairEpoch,
			);
			factsProjected += page.rows.length;
			projectedByKind.fact = (projectedByKind.fact ?? 0) + page.rows.length;
			checkpoint = page.done
				? { phase: nextRepairPhase("facts"), cursor: null }
				: { phase: "facts", cursor: page.nextCursor };
		} else if (checkpoint.phase === "edges") {
			if (d1QueriesUsed >= d1QueryBudget) {
				stoppedForQueryBudget = true;
				break;
			}
			d1QueriesUsed++;
			const page = await readGraphEdgeBackfillPage(
				input.db,
				input.organizationId,
				{ afterId: checkpoint.cursor ?? undefined, limit: pageSize },
			);
			await input.beforePage?.(checkpoint);
			await projectEdgeRepairPage(
				input.writer,
				page.rows,
				input.projectionEpoch,
				input.repairEpoch,
			);
			edgesProjected += page.rows.length;
			projectedByKind.edge = (projectedByKind.edge ?? 0) + page.rows.length;
			checkpoint = page.done
				? { phase: nextRepairPhase("edges"), cursor: null }
				: { phase: "edges", cursor: page.nextCursor };
		} else if (checkpoint.phase === "sweep") {
			await input.beforePage?.(checkpoint);
			try {
				await input.sweepRepair(input.repairEpoch);
			} catch (error) {
				if (error instanceof GraphProjectionRepairQueryBudgetError) {
					stoppedForQueryBudget = true;
					break;
				}
				throw error;
			}
			checkpoint = { phase: "complete", cursor: null };
		} else if (checkpoint.phase === "decision_predecessors") {
			if (
				d1QueryBudget - d1QueriesUsed <
				GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND
			) {
				stoppedForQueryBudget = true;
				break;
			}
			d1QueriesUsed += GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND;
			const page = await readManagedRepairEventPage({
				db: input.db,
				organizationId: input.organizationId,
				repairEpoch: input.repairEpoch,
				phase: "decision_predecessors",
				afterId: checkpoint.cursor,
				limit: Math.min(
					pageSize,
					GRAPH_PROJECTION_DECISION_PREDECESSOR_PAGE_SIZE,
				),
			});
			const decisions: GraphDecision[] = page.events.map((event) => {
				if (event.op !== "upsert_decision" || !event.payload) {
					throw new Error(
						`Decision predecessor repair could not hydrate ${event.id}`,
					);
				}
				return {
					...(event.payload as GraphDecision),
					projectionEpoch: input.projectionEpoch,
					projectionRepairEpoch: input.repairEpoch,
				};
			});
			await input.beforePage?.(checkpoint);
			if (input.writer.rebuildDecisionPredecessors) {
				await input.writer.rebuildDecisionPredecessors(decisions);
			} else {
				for (const decision of decisions) {
					await input.writer.upsertDecision(decision);
				}
			}
			checkpoint = page.done
				? { phase: nextRepairPhase("decision_predecessors"), cursor: null }
				: { phase: "decision_predecessors", cursor: page.nextCursor };
		} else {
			const phase = checkpoint.phase;
			const entityKind = REPAIR_PHASE_ENTITY_KIND[phase];
			if (
				d1QueryBudget - d1QueriesUsed <
				GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND
			) {
				stoppedForQueryBudget = true;
				break;
			}
			d1QueriesUsed += GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND;
			const page = await readManagedRepairEventPage({
				db: input.db,
				organizationId: input.organizationId,
				repairEpoch: input.repairEpoch,
				phase,
				afterId: checkpoint.cursor,
				limit: pageSize,
			});
			const events = page.events.map((event) =>
				attachProjectionEpochs(event, input.projectionEpoch, input.repairEpoch),
			);
			await input.beforePage?.(checkpoint);
			if (phase === "decisions" && input.writer.upsertDecisionContexts) {
				await processProjectionBatch(events, input.writer, {
					deferDecisionPredecessors: true,
				});
			} else {
				await requireSuccessfulBatch(events, input.writer);
			}
			projectedByKind[entityKind] =
				(projectedByKind[entityKind] ?? 0) + page.events.length;
			checkpoint = page.done
				? { phase: nextRepairPhase(phase), cursor: null }
				: { phase, cursor: page.nextCursor };
		}
		pagesProcessed++;
		await input.onCheckpoint?.(checkpoint);
	}

	return {
		checkpoint,
		pagesProcessed,
		domainsProjected,
		factsProjected,
		edgesProjected,
		projectedByKind,
		canonicalD1QueriesUsed: d1QueriesUsed,
		stoppedReason:
			checkpoint.phase === "complete"
				? null
				: stoppedForQueryBudget
					? "query_budget"
					: "max_pages",
	};
}
