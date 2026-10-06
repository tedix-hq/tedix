/**
 * Graph DB Projection Consumer — D1 → Graph Database
 *
 * Migration-owned D1 triggers atomically append canonical projection events.
 * The strict outbox drain hydrates those events and dispatches them here.
 */

import type {
	GraphCapability,
	GraphCapabilityLink,
	GraphDecision,
	GraphDomain,
	GraphEntity,
	GraphEntityResolution,
	GraphProject,
	GraphWorkItem,
	GraphWorkItemSource,
	GraphEntityResolutionRevocation,
	GraphFact,
	GraphKnowledgeEntry,
	GraphSkill,
	GraphSyncEdge,
	GraphTedi,
	GraphTediExpertise,
	SyncEvent,
} from "./types";

/**
 * Graph write interface — implemented by each driver (neo4j, memgraph, etc.)
 * Separated from GraphClient because sync writes need different operations
 * than read queries.
 */
export interface GraphWriter {
	upsertFact(fact: GraphFact): Promise<void>;
	/** Optional UNWIND path with legacy adoption and committed-state verification. */
	upsertFacts?(facts: GraphFact[]): Promise<void>;
	upsertEdge(edge: GraphSyncEdge): Promise<void>;
	/** Optional allowlisted UNWIND path with per-type committed-state verification. */
	upsertEdges?(edges: GraphSyncEdge[]): Promise<void>;
	/** Optional UNWIND path for large decision repair pages. */
	upsertDecisions?(decisions: GraphDecision[]): Promise<void>;
	/**
	 * Materialize decision context without PRECEDED_BY. Baseline repair uses
	 * this before the complete decision manifest exists, then runs one ordered
	 * predecessor pass over the finished manifest.
	 */
	upsertDecisionContexts?(
		decisions: GraphDecision[],
		options?: {
			requireProjectionEpoch?: boolean;
			requireRepairEpoch?: boolean;
		},
	): Promise<void>;
	/**
	 * Rebuild PRECEDED_BY only after the complete decision manifest is present.
	 * Baseline keyset order is unrelated to decision chronology.
	 */
	rebuildDecisionPredecessors?(decisions: GraphDecision[]): Promise<void>;
	upsertDomain(domain: GraphDomain): Promise<void>;
	upsertTedi(tedi: GraphTedi): Promise<void>;
	upsertDecision(decision: GraphDecision): Promise<void>;
	upsertKnowledgeEntry(entry: GraphKnowledgeEntry): Promise<void>;
	upsertSkill(skill: GraphSkill): Promise<void>;
	upsertCapability(capability: GraphCapability): Promise<void>;
	upsertCapabilityLink(link: GraphCapabilityLink): Promise<void>;
	upsertEntity(entity: GraphEntity): Promise<void>;
	/** Work graph: the project anchor and its items, plus attached sources. */
	upsertProject(project: GraphProject): Promise<void>;
	upsertWorkItem(item: GraphWorkItem): Promise<void>;
	upsertWorkItemSource(source: GraphWorkItemSource): Promise<void>;
	upsertEntityResolution(resolution: GraphEntityResolution): Promise<void>;
	deleteCapability(id: string, orgId: string): Promise<void>;
	deleteCapabilityLink(link: GraphCapabilityLink): Promise<void>;
	deleteFact(id: string, orgId: string): Promise<void>;
	deleteEdge(
		sourceFactId: string,
		targetFactId: string,
		relationType: string,
		orgId: string,
	): Promise<void>;
	deleteDomain(id: string, orgId: string): Promise<void>;
	deleteTedi(id: string, orgId: string): Promise<void>;
	deleteDecision(id: string, orgId: string): Promise<void>;
	deleteKnowledgeEntry(id: string, orgId: string): Promise<void>;
	deleteSkill(id: string, orgId: string): Promise<void>;
	deleteEntity(id: string, orgId: string): Promise<void>;
	deleteProject(id: string, orgId: string): Promise<void>;
	deleteWorkItem(id: string, orgId: string): Promise<void>;
	deleteWorkItemSource(id: string, orgId: string): Promise<void>;
	revokeEntityResolution(
		id: string,
		orgId: string,
		validTo: string,
	): Promise<void>;
	upsertTediExpertise(
		tediId: string,
		domainId: string,
		level: string,
		avgConfidence: number,
		orgId: string,
		projectionRepairEpoch?: string,
		projectionEpoch?: string,
	): Promise<void>;
	deleteTediExpertise(
		tediId: string,
		domainId: string,
		orgId: string,
	): Promise<void>;
}

export type SyncEventResult =
	| { event: SyncEvent; success: true }
	| { event: SyncEvent; success: false; error: unknown };

export type SyncBatchResult = {
	processed: number;
	errors: number;
	results: SyncEventResult[];
};

function assertCanonicalEnvelope(event: SyncEvent): void {
	if (typeof event.id !== "string" || event.id.length === 0) {
		throw new Error("Graph projection event is missing its canonical identity");
	}
	if (typeof event.orgId !== "string" || event.orgId.length === 0) {
		throw new Error("Graph projection event is missing its organization scope");
	}
}

function payloadRecord(
	event: SyncEvent,
	operation: string,
): Record<string, unknown> {
	if (!event.payload) throw new Error(`${operation} requires payload`);
	return event.payload as unknown as Record<string, unknown>;
}

function assertCanonicalScope(
	event: SyncEvent,
	payload: Record<string, unknown>,
	operation: string,
	options?: { requireId?: boolean; allowMissingOrgId?: boolean },
): void {
	const payloadOrgId = payload.orgId;
	if (
		payloadOrgId !== undefined &&
		payloadOrgId !== null &&
		payloadOrgId !== event.orgId
	) {
		throw new Error(
			`${operation} payload organization does not match its canonical event envelope`,
		);
	}
	if (
		!options?.allowMissingOrgId &&
		(typeof payloadOrgId !== "string" || payloadOrgId.length === 0)
	) {
		throw new Error(`${operation} payload is missing its organization scope`);
	}
	if (
		options?.requireId &&
		(typeof payload.id !== "string" || payload.id !== event.id)
	) {
		throw new Error(
			`${operation} payload identity does not match its canonical event envelope`,
		);
	}
}

function normalizedEdge(event: SyncEvent): GraphSyncEdge {
	const payload = payloadRecord(event, "upsert_edge");
	assertCanonicalScope(event, payload, "upsert_edge", {
		allowMissingOrgId: true,
	});
	if (
		payload.id !== undefined &&
		payload.id !== null &&
		payload.id !== event.id
	) {
		throw new Error(
			"upsert_edge payload identity does not match its canonical event envelope",
		);
	}
	const normalized: Record<string, unknown> = {
		...payload,
		id: event.id,
		orgId: event.orgId,
		updatedAt: payload.updatedAt ?? null,
	};
	if (
		!normalized.sourceFactId ||
		!normalized.targetFactId ||
		!normalized.relationType
	) {
		throw new Error(
			"Invalid edge payload: missing sourceFactId, targetFactId, or relationType",
		);
	}
	return normalized as unknown as GraphSyncEdge;
}

type ProjectionBatchPhase =
	| "node_upsert"
	| "relationship_delete"
	| "relationship_upsert"
	| "node_delete";

function projectionBatchPhase(event: SyncEvent): ProjectionBatchPhase {
	switch (event.op) {
		case "upsert_fact":
		case "upsert_domain":
		case "upsert_tedi":
		case "upsert_decision":
		case "upsert_knowledge_entry":
		case "upsert_skill":
		case "upsert_capability":
		case "upsert_entity":
		case "upsert_project":
		case "upsert_work_item":
		case "upsert_work_item_source":
			return "node_upsert";
		case "delete_edge":
		case "delete_tedi_expertise":
		case "delete_capability_link":
		case "revoke_entity_resolution":
			return "relationship_delete";
		case "upsert_edge":
		case "upsert_tedi_expertise":
		case "upsert_capability_link":
		case "upsert_entity_resolution":
			return "relationship_upsert";
		case "delete_fact":
		case "delete_domain":
		case "delete_tedi":
		case "delete_decision":
		case "delete_knowledge_entry":
		case "delete_skill":
		case "delete_capability":
		case "delete_entity":
		case "delete_project":
		case "delete_work_item":
		case "delete_work_item_source":
			return "node_delete";
		default:
			throw new Error(`Unknown sync operation: ${event.op satisfies never}`);
	}
}

/**
 * Projection-optimized batch processing. Node and relationship batches use
 * UNWIND when the driver supports it; all other event types retain the strict
 * per-event path. Any error rejects the batch so the durable cursor cannot
 * advance past an unverified Neo4j commit.
 */
export async function processProjectionBatch(
	events: SyncEvent[],
	writer: GraphWriter,
	options?: { deferDecisionPredecessors?: boolean },
): Promise<void> {
	for (const event of events) assertCanonicalEnvelope(event);
	const phases: Record<ProjectionBatchPhase, SyncEvent[]> = {
		node_upsert: [],
		relationship_delete: [],
		relationship_upsert: [],
		node_delete: [],
	};
	for (const event of events) {
		phases[projectionBatchPhase(event)].push(event);
	}
	const factEvents = phases.node_upsert.filter(
		(event) => event.op === "upsert_fact",
	);
	const decisionEvents = phases.node_upsert.filter(
		(event) => event.op === "upsert_decision",
	);
	const otherNodeUpserts = phases.node_upsert.filter(
		(event) => event.op !== "upsert_fact" && event.op !== "upsert_decision",
	);
	const edgeEvents = phases.relationship_upsert.filter(
		(event) => event.op === "upsert_edge",
	);
	const otherRelationshipUpserts = phases.relationship_upsert.filter(
		(event) => event.op !== "upsert_edge",
	);

	if (factEvents.length > 0 && writer.upsertFacts) {
		const facts = factEvents.map((event) => {
			const payload = payloadRecord(event, "upsert_fact");
			assertCanonicalScope(event, payload, "upsert_fact", { requireId: true });
			return payload as unknown as GraphFact;
		});
		await writer.upsertFacts(facts);
	} else {
		for (const event of factEvents) await processSyncEvent(event, writer);
	}

	if (decisionEvents.length > 0) {
		const decisions = decisionEvents.map((event) => {
			const payload = payloadRecord(event, "upsert_decision");
			assertCanonicalScope(event, payload, "upsert_decision", {
				requireId: true,
			});
			return payload as unknown as GraphDecision;
		});
		if (options?.deferDecisionPredecessors && writer.upsertDecisionContexts) {
			await writer.upsertDecisionContexts(decisions, {
				requireProjectionEpoch: true,
				requireRepairEpoch: true,
			});
		} else if (writer.upsertDecisions) {
			await writer.upsertDecisions(decisions);
		} else {
			for (const event of decisionEvents) await processSyncEvent(event, writer);
		}
	}

	for (const event of otherNodeUpserts) {
		await processSyncEvent(event, writer);
	}

	for (const event of phases.relationship_delete) {
		await processSyncEvent(event, writer);
	}

	if (edgeEvents.length > 0 && writer.upsertEdges) {
		const edges = edgeEvents.map(normalizedEdge);
		await writer.upsertEdges(edges);
	} else {
		for (const event of edgeEvents) await processSyncEvent(event, writer);
	}

	for (const event of otherRelationshipUpserts) {
		await processSyncEvent(event, writer);
	}

	for (const event of phases.node_delete) {
		await processSyncEvent(event, writer);
	}
}

/**
 * Process one canonical outbox batch. Events are processed sequentially to
 * preserve D1 sequence order. Callers choose whether to stop at the first error.
 */
export async function processSyncBatch(
	events: SyncEvent[],
	writer: GraphWriter,
	options?: {
		onError?: (event: SyncEvent, error: unknown) => void;
		stopOnError?: boolean;
	},
): Promise<SyncBatchResult> {
	let processed = 0;
	let errors = 0;
	const results: SyncEventResult[] = [];

	for (const event of events) {
		try {
			await processSyncEvent(event, writer);
			processed++;
			results.push({ event, success: true });
		} catch (error) {
			errors++;
			results.push({ event, success: false, error });
			options?.onError?.(event, error);
			if (options?.stopOnError) break;
		}
	}

	return { processed, errors, results };
}

export async function processSyncEvent(
	event: SyncEvent,
	writer: GraphWriter,
): Promise<void> {
	assertCanonicalEnvelope(event);
	const { op, payload } = event;

	switch (op) {
		case "upsert_fact": {
			const p = payloadRecord(event, "upsert_fact");
			assertCanonicalScope(event, p, "upsert_fact", { requireId: true });
			if (!p.id || !p.content)
				throw new Error("Invalid fact payload: missing id or content");
			await writer.upsertFact(p as unknown as GraphFact);
			break;
		}

		case "upsert_edge": {
			await writer.upsertEdge(normalizedEdge(event));
			break;
		}

		case "upsert_domain": {
			const p = payloadRecord(event, "upsert_domain");
			assertCanonicalScope(event, p, "upsert_domain", { requireId: true });
			if (!p.id || !p.name)
				throw new Error("Invalid domain payload: missing id or name");
			await writer.upsertDomain(p as unknown as GraphDomain);
			break;
		}

		case "upsert_tedi": {
			const p = payloadRecord(event, "upsert_tedi");
			assertCanonicalScope(event, p, "upsert_tedi", { requireId: true });
			if (!p.id || !p.slug)
				throw new Error("Invalid tedi payload: missing id or slug");
			await writer.upsertTedi(p as unknown as GraphTedi);
			break;
		}

		case "upsert_decision": {
			const p = payloadRecord(event, "upsert_decision");
			assertCanonicalScope(event, p, "upsert_decision", { requireId: true });
			if (!p.id || !p.action || !p.rationale)
				throw new Error(
					"Invalid decision payload: missing id, action, or rationale",
				);
			await writer.upsertDecision(p as unknown as GraphDecision);
			break;
		}

		case "upsert_knowledge_entry": {
			const p = payloadRecord(event, "upsert_knowledge_entry");
			assertCanonicalScope(event, p, "upsert_knowledge_entry", {
				requireId: true,
			});
			if (!p.id || !p.title || !p.content)
				throw new Error(
					"Invalid knowledge_entry payload: missing id, title, or content",
				);
			await writer.upsertKnowledgeEntry(p as unknown as GraphKnowledgeEntry);
			break;
		}

		case "upsert_skill": {
			const p = payloadRecord(event, "upsert_skill");
			assertCanonicalScope(event, p, "upsert_skill", { requireId: true });
			if (!p.id || !p.title || !p.content)
				throw new Error("Invalid skill payload: missing id, title, or content");
			await writer.upsertSkill(p as unknown as GraphSkill);
			break;
		}

		case "upsert_tedi_expertise": {
			const p = payloadRecord(event, "upsert_tedi_expertise");
			// The canonical envelope owns tenant scope for this composite-key
			// payload; older workflow hydration omitted a duplicate orgId field.
			assertCanonicalScope(event, p, "upsert_tedi_expertise", {
				allowMissingOrgId: true,
			});
			if (
				!p.tediId ||
				!p.domainId ||
				!p.level ||
				typeof p.avgConfidence !== "number"
			)
				throw new Error(
					"Invalid tedi_expertise payload: missing tediId, domainId, level, or avgConfidence",
				);
			await writer.upsertTediExpertise(
				p.tediId as string,
				p.domainId as string,
				p.level as string,
				p.avgConfidence,
				event.orgId,
				typeof p.projectionRepairEpoch === "string"
					? p.projectionRepairEpoch
					: undefined,
				typeof p.projectionEpoch === "string" ? p.projectionEpoch : undefined,
			);
			break;
		}

		case "upsert_capability": {
			const p = payloadRecord(event, "upsert_capability");
			assertCanonicalScope(event, p, "upsert_capability", { requireId: true });
			if (!p.id || !p.name || !p.slug)
				throw new Error(
					"Invalid capability payload: missing id, name, or slug",
				);
			await writer.upsertCapability(p as unknown as GraphCapability);
			break;
		}

		case "upsert_entity": {
			const p = payloadRecord(event, "upsert_entity");
			assertCanonicalScope(event, p, "upsert_entity", { requireId: true });
			if (!p.id || !p.orgId || !p.entityType || !p.normalizedName)
				throw new Error(
					"Invalid entity payload: missing id, orgId, entityType, or normalizedName",
				);
			await writer.upsertEntity(p as unknown as GraphEntity);
			break;
		}

		case "upsert_project": {
			const p = payloadRecord(event, "upsert_project");
			assertCanonicalScope(event, p, "upsert_project", { requireId: true });
			if (!p.id || !p.key || !p.name)
				throw new Error("Invalid project payload: missing id, key, or name");
			await writer.upsertProject(p as unknown as GraphProject);
			break;
		}

		case "upsert_work_item": {
			const p = payloadRecord(event, "upsert_work_item");
			assertCanonicalScope(event, p, "upsert_work_item", { requireId: true });
			if (!p.id || !p.title || !p.disposition)
				throw new Error(
					"Invalid work_item payload: missing id, title, or disposition",
				);
			await writer.upsertWorkItem(p as unknown as GraphWorkItem);
			break;
		}

		case "upsert_work_item_source": {
			const p = payloadRecord(event, "upsert_work_item_source");
			assertCanonicalScope(event, p, "upsert_work_item_source", {
				requireId: true,
			});
			if (!p.id || !p.provider || !p.externalId)
				throw new Error(
					"Invalid work_item_source payload: missing id, provider, or externalId",
				);
			await writer.upsertWorkItemSource(p as unknown as GraphWorkItemSource);
			break;
		}

		case "upsert_entity_resolution": {
			const p = payloadRecord(event, "upsert_entity_resolution");
			assertCanonicalScope(event, p, "upsert_entity_resolution", {
				requireId: true,
			});
			if (!p.id || !p.orgId || !p.mentionId || !p.entityId)
				throw new Error(
					"Invalid entity resolution payload: missing id, orgId, mentionId, or entityId",
				);
			await writer.upsertEntityResolution(
				p as unknown as GraphEntityResolution,
			);
			break;
		}

		case "upsert_capability_link":
		case "delete_capability_link": {
			const p = payloadRecord(event, op);
			assertCanonicalScope(event, p, op, { allowMissingOrgId: true });
			if (!p.capabilityId || !p.entityKind || !p.entityId)
				throw new Error(
					"Invalid capability_link payload: missing capabilityId, entityKind, or entityId",
				);
			const link = {
				...p,
				orgId: event.orgId,
			} as unknown as GraphCapabilityLink;
			if (op === "upsert_capability_link")
				await writer.upsertCapabilityLink(link);
			else await writer.deleteCapabilityLink(link);
			break;
		}

		case "delete_capability":
			await writer.deleteCapability(event.id, event.orgId);
			break;

		case "delete_fact":
			await writer.deleteFact(event.id, event.orgId);
			break;

		case "delete_edge": {
			if (!payload) throw new Error("delete_edge requires tombstone payload");
			const edgePayload = payload as unknown as Record<string, unknown>;
			assertCanonicalScope(event, edgePayload, "delete_edge", {
				allowMissingOrgId: true,
			});
			const edge = edgePayload as unknown as GraphSyncEdge;
			if (!edge.sourceFactId || !edge.targetFactId || !edge.relationType)
				throw new Error("Invalid edge tombstone payload");
			await writer.deleteEdge(
				edge.sourceFactId,
				edge.targetFactId,
				edge.relationType,
				event.orgId,
			);
			break;
		}

		case "delete_domain":
			await writer.deleteDomain(event.id, event.orgId);
			break;

		case "delete_tedi":
			await writer.deleteTedi(event.id, event.orgId);
			break;

		case "delete_decision":
			await writer.deleteDecision(event.id, event.orgId);
			break;

		case "delete_knowledge_entry":
			await writer.deleteKnowledgeEntry(event.id, event.orgId);
			break;

		case "delete_skill":
			await writer.deleteSkill(event.id, event.orgId);
			break;

		case "delete_tedi_expertise": {
			if (!payload)
				throw new Error("delete_tedi_expertise requires tombstone payload");
			const expertisePayload = payload as unknown as Record<string, unknown>;
			assertCanonicalScope(event, expertisePayload, "delete_tedi_expertise", {
				allowMissingOrgId: true,
			});
			const expertise = expertisePayload as unknown as GraphTediExpertise;
			await writer.deleteTediExpertise(
				expertise.tediId,
				expertise.domainId,
				event.orgId,
			);
			break;
		}

		case "delete_project":
			await writer.deleteProject(event.id, event.orgId);
			break;

		case "delete_work_item":
			await writer.deleteWorkItem(event.id, event.orgId);
			break;

		case "delete_work_item_source":
			await writer.deleteWorkItemSource(event.id, event.orgId);
			break;

		case "delete_entity":
			await writer.deleteEntity(event.id, event.orgId);
			break;

		case "revoke_entity_resolution": {
			if (!payload)
				throw new Error(
					"revoke_entity_resolution requires a canonical validity tombstone",
				);
			const revocation = payload as unknown as GraphEntityResolutionRevocation;
			if (
				typeof revocation.validTo !== "string" ||
				revocation.validTo.length === 0
			) {
				throw new Error(
					"Invalid entity resolution revocation payload: missing validTo",
				);
			}
			await writer.revokeEntityResolution(
				event.id,
				event.orgId,
				revocation.validTo,
			);
			break;
		}

		default:
			throw new Error(`Unknown sync operation: ${op satisfies never}`);
	}
}
