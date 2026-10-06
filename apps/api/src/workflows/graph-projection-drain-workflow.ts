/**
 * Durable D1 -> Neo4j projection consumer.
 *
 * D1 triggers own event creation. This Workflow reads an ordered keyset batch,
 * hydrates current canonical rows in one D1 batch, writes nodes before
 * relationships, verifies Neo4j write counts, and only then advances the
 * tenant cursor. Product graph reads remain disabled until a full catch-up,
 * baseline repair, stale-generation cleanup, and governed certification all
 * succeed. GDS refresh is an explicit maintenance operation with its own
 * admission watermark; the ordinary projection drain never mutates it.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import {
	acquireGraphProjectionLease,
	confirmGraphProjectionReadyWithoutBacklog,
	countPendingGraphProjectionEvents,
	getGraphProjectionReadState,
	hydrateCanonicalGraphProjectionRows,
	releaseGraphProjectionLease,
	renewGraphProjectionLease,
	setGraphProjectionReadiness,
} from "@tedix/db/queries/graph-projection";
import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import type {
	GraphCapability,
	GraphCapabilityLink,
	GraphDecision,
	GraphDomain,
	GraphEdge,
	GraphFact,
	GraphKnowledgeEntry,
	GraphSkill,
	GraphTedi,
	GraphTediExpertise,
	SyncEvent,
	SyncOperation,
} from "../integrations/graph-db/types";
import {
	type GraphProjectionDrainStop,
	runGraphProjectionDrain,
} from "../services/graph-projection-drain-engine";

export interface GraphProjectionDrainParams {
	organizationId: string;
	maxBatches?: number;
}

type CanonicalRow = Record<string, unknown>;

const DEFAULT_MAX_BATCHES = 20;
const MAX_BATCHES = 50;

function parseJson<T>(value: unknown, fallback: T): T {
	if (value == null) return fallback;
	if (typeof value !== "string") return value as T;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function deleteOperation(event: GraphProjectionOutboxEvent): SyncOperation {
	switch (event.entityKind) {
		case "fact":
			return "delete_fact";
		case "edge":
			return "delete_edge";
		case "domain":
			return "delete_domain";
		case "tedi":
			return "delete_tedi";
		case "decision":
			return "delete_decision";
		case "knowledge_entry":
			return "delete_knowledge_entry";
		case "skill":
			return "delete_skill";
		case "tedi_expertise":
			return "delete_tedi_expertise";
		case "capability":
			return "delete_capability";
		case "capability_link":
			return "delete_capability_link";
		case "entity":
			return "delete_entity";
		case "entity_resolution":
			return "revoke_entity_resolution";
		case "project":
			return "delete_project";
		case "work_item":
			return "delete_work_item";
		case "work_item_source":
			return "delete_work_item_source";
	}
}

function upsertPayload(
	event: GraphProjectionOutboxEvent,
	row: CanonicalRow,
	projectionEpoch: string,
): { op: SyncOperation; id: string; payload: SyncEvent["payload"] } {
	const common = { projectionEpoch };
	switch (event.entityKind) {
		case "fact":
			return {
				op: "upsert_fact",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					tediId: (row.tedi_id as string | null) ?? null,
					domainId: (row.domain_id as string | null) ?? null,
					content: String(row.content),
					summary: (row.summary as string | null) ?? null,
					factType: String(row.fact_type),
					confidence: Number(row.confidence ?? 0),
					validTo: (row.valid_to as string | null) ?? null,
					archivedAt: (row.archived_at as string | null) ?? null,
					priority: (row.priority as string | null) ?? null,
					visibility: (row.visibility as string | null) ?? null,
					accessCount: Number(row.access_count ?? 0),
					usageCount: Number(row.usage_count ?? 0),
					createdAt: (row.created_at as string | null) ?? null,
					updatedAt: (row.updated_at as string | null) ?? null,
					...common,
				} as GraphFact,
			};
		case "edge":
			return {
				op: "upsert_edge",
				id: event.entityId,
				payload: {
					orgId: String(row.organization_id),
					sourceFactId: String(row.source_fact_id),
					targetFactId: String(row.target_fact_id),
					relationType: String(row.relation_type) as GraphEdge["relationType"],
					strength: Number(row.strength ?? 0),
					context: (row.context as string | null) ?? null,
					...common,
				} as GraphEdge,
			};
		case "domain":
			return {
				op: "upsert_domain",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					name: String(row.name),
					parentId: (row.parent_id as string | null) ?? null,
					description: (row.description as string | null) ?? null,
					...common,
				} as GraphDomain,
			};
		case "tedi":
			return {
				op: "upsert_tedi",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					slug: String(row.slug),
					name: String(row.display_name ?? row.name),
					...common,
				} as GraphTedi,
			};
		case "decision":
			return {
				op: "upsert_decision",
				id: event.entityId,
				payload: {
					id: String(row.id),
					tediId: String(row.tedi_id),
					orgId: String(row.org_id),
					action: String(row.action),
					rationale: String(row.rationale),
					category: String(row.category),
					confidence: Number(row.confidence ?? 0),
					outcomeStatus: String(row.outcome_status),
					evidence:
						typeof row.evidence === "string"
							? row.evidence
							: JSON.stringify(row.evidence ?? {}),
					objectiveId: (row.objective_id as string | null) ?? null,
					approvalRequestId: (row.approval_request_id as string | null) ?? null,
					createdAt: String(row.created_at),
					completedAt: (row.completed_at as string | null) ?? null,
					...common,
				} as GraphDecision,
			};
		case "knowledge_entry":
			return {
				op: "upsert_knowledge_entry",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					tediId: (row.tedi_id as string | null) ?? null,
					domainId: (row.domain_id as string | null) ?? null,
					title: String(row.title),
					content: String(row.content),
					entryType: String(row.entry_type),
					confidence: Number(row.confidence ?? 0),
					visibility: String(row.visibility),
					revision: Number(row.revision ?? 1),
					sourceFactIds: parseJson<string[]>(row.source_fact_ids, []),
					createdAt: String(row.created_at ?? ""),
					updatedAt: String(row.updated_at ?? ""),
					...common,
				} as GraphKnowledgeEntry,
			};
		case "skill":
			return {
				op: "upsert_skill",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					tediId: (row.tedi_id as string | null) ?? null,
					domainId: (row.domain_id as string | null) ?? null,
					title: String(row.title),
					content: String(row.content),
					visibility: String(row.visibility),
					slug: (row.slug as string | null) ?? null,
					successCount: Number(row.success_count ?? 0),
					failureCount: Number(row.failure_count ?? 0),
					revision: Number(row.revision ?? 1),
					createdAt: String(row.created_at ?? ""),
					updatedAt: String(row.updated_at ?? ""),
					...common,
				} as GraphSkill,
			};
		case "tedi_expertise":
			return {
				op: "upsert_tedi_expertise",
				id: event.entityId,
				payload: {
					tediId: String(row.tedi_id),
					domainId: String(row.domain_id),
					level: String(row.expertise_level),
					avgConfidence: Number(row.avg_confidence ?? 0),
					...common,
				} as GraphTediExpertise,
			};
		case "capability":
			return {
				op: "upsert_capability",
				id: event.entityId,
				payload: {
					id: String(row.id),
					orgId: String(row.organization_id),
					parentId: (row.parent_id as string | null) ?? null,
					name: String(row.name),
					slug: String(row.slug),
					valueStream: (row.value_stream as string | null) ?? null,
					paceLayer: String(row.pace_layer),
					maturityScore:
						row.maturity_score == null ? null : Number(row.maturity_score),
					status: String(row.status),
					...common,
				} as GraphCapability,
			};
		case "capability_link":
			return {
				op: "upsert_capability_link",
				id: event.entityId,
				payload: {
					capabilityId: String(row.capability_id),
					orgId: String(row.organization_id),
					entityKind: String(
						row.entity_kind,
					) as GraphCapabilityLink["entityKind"],
					entityId: String(row.entity_id),
					...common,
				} as GraphCapabilityLink,
			};
		case "entity":
		case "entity_resolution":
		// Work-graph kinds are materialized by the repair sweep with a complete
		// payload; this incremental path has nothing to hydrate them from.
		case "project":
		case "work_item":
		case "work_item_source":
			throw new Error(
				`Entity projection kind ${event.entityKind} requires governed hydration`,
			);
	}
}

function entityDeleteEvent(event: GraphProjectionOutboxEvent): SyncEvent {
	if (event.entityKind === "entity") {
		return {
			op: "delete_entity",
			id: event.entityId,
			orgId: event.organizationId,
			timestamp: Date.parse(event.createdAt) || Date.now(),
		};
	}
	const payload = event.payload ?? {};
	const validTo =
		typeof payload.validTo === "string" && payload.validTo.length > 0
			? payload.validTo
			: event.createdAt;
	return {
		op: "revoke_entity_resolution",
		id: event.entityId,
		orgId: event.organizationId,
		timestamp: Date.parse(event.createdAt) || Date.now(),
		payload: { validTo },
	};
}

async function hydrateEntityProjectionEvent(
	db: ReturnType<typeof createDbClient>,
	event: GraphProjectionOutboxEvent,
	projectionEpoch: string,
): Promise<SyncEvent> {
	if (
		event.entityKind !== "entity" &&
		event.entityKind !== "entity_resolution"
	) {
		throw new Error(`Unsupported entity projection kind: ${event.entityKind}`);
	}
	if (event.operation === "delete") return entityDeleteEvent(event);
	const { hydrateMemoryEntityProjectionEvent } =
		await import("../services/graph-projection-entities");
	const hydrated = await hydrateMemoryEntityProjectionEvent(db, event);
	if (!hydrated?.payload) {
		// An upsert whose canonical row disappeared is the final delete state.
		return entityDeleteEvent(event);
	}
	return {
		...hydrated,
		payload: {
			...(hydrated.payload as unknown as Record<string, unknown>),
			projectionEpoch,
		} as SyncEvent["payload"],
	};
}

async function hydrateBatch(
	d1: D1Database,
	events: GraphProjectionOutboxEvent[],
	projectionEpoch: string,
): Promise<SyncEvent[]> {
	const coreEvents = events.filter(
		(event) =>
			event.entityKind !== "entity" && event.entityKind !== "entity_resolution",
	);
	const results =
		coreEvents.length === 0
			? []
			: await hydrateCanonicalGraphProjectionRows(
					createDbClient(d1),
					coreEvents,
				);
	const db = createDbClient(d1);
	let coreIndex = 0;
	const hydratedEvents = await Promise.all(
		events.map(async (event) => {
			if (
				event.entityKind === "entity" ||
				event.entityKind === "entity_resolution"
			) {
				return hydrateEntityProjectionEvent(db, event, projectionEpoch);
			}
			const row = results[coreIndex++] ?? null;
			if (event.operation === "delete" || !row) {
				const hint = event.payload ?? {};
				const edgeHint = hint as {
					sourceFactId?: string;
					targetFactId?: string;
					relationType?: string;
				};
				const id =
					event.entityKind === "edge" &&
					edgeHint.sourceFactId &&
					edgeHint.targetFactId &&
					edgeHint.relationType
						? `${edgeHint.sourceFactId}:${edgeHint.targetFactId}:${edgeHint.relationType}`
						: event.entityId;
				return {
					op: deleteOperation(event),
					id,
					orgId: event.organizationId,
					timestamp: Date.parse(event.createdAt),
					payload: hint as unknown as SyncEvent["payload"],
				};
			}
			const hydrated = upsertPayload(event, row, projectionEpoch);
			return {
				...hydrated,
				orgId: event.organizationId,
				timestamp: Date.parse(event.createdAt),
			};
		}),
	);
	const organizationId = events[0]?.organizationId;
	if (!organizationId) return hydratedEvents;
	// Same safety net the service drain uses: an edge whose endpoint Fact is not
	// in Neo4j yet cannot merge, and the endpoint's own event may sit far later
	// in the sequence. processProjectionBatch writes nodes before relationships,
	// so carrying the endpoints in the batch makes the edge satisfiable. Without
	// this the edge fails, is retried, and is finally poisoned and skipped —
	// which no longer deadlocks the organization but does silently drop the edge.
	const { edgeEndpointFactEvents } =
		await import("../services/graph-projection-drain");
	const endpoints = await edgeEndpointFactEvents(
		db,
		organizationId,
		hydratedEvents,
		projectionEpoch,
	);
	return endpoints.length === 0
		? hydratedEvents
		: [...endpoints, ...hydratedEvents];
}

/**
 * The readiness reason a stop publishes, or `null` when the stop is pure
 * coordination. A lost lease or a fenced cursor says nothing about the
 * projection's data, so it must not mark the organization degraded.
 */
function degradedReadinessReason(
	stop: GraphProjectionDrainStop,
): string | null {
	if (stop.kind === "hydration_failed") {
		return stop.error instanceof Error
			? `projection_hydration_failed:${stop.error.message}`.slice(0, 1000)
			: "projection_hydration_failed";
	}
	if (stop.kind === "projection_failed") {
		return `projection_write_failed:${stop.error.message}`.slice(0, 1000);
	}
	return null;
}

export class GraphProjectionDrainWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	GraphProjectionDrainParams
> {
	async run(
		event: WorkflowEvent<GraphProjectionDrainParams>,
		step: WorkflowStep,
	) {
		const organizationId = event.payload.organizationId;
		const maxBatches = Math.max(
			1,
			Math.min(
				MAX_BATCHES,
				Math.trunc(event.payload.maxBatches ?? DEFAULT_MAX_BATCHES),
			),
		);
		const db = createDbClient(this.env.DB);
		if (
			!this.env.GRAPH_DB_URI ||
			!this.env.GRAPH_DB_USER ||
			!this.env.GRAPH_DB_PASSWORD
		) {
			await step.do(
				"disable-unconfigured",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				() =>
					setGraphProjectionReadiness(db, {
						organizationId,
						state: "disabled",
						reason: "graph_db_not_configured",
					}),
			);
			return { status: "disabled" as const, processed: 0 };
		}
		const config = {
			uri: this.env.GRAPH_DB_URI,
			user: this.env.GRAPH_DB_USER,
			password: this.env.GRAPH_DB_PASSWORD,
		};
		const [
			{ createNeo4jGraphClient },
			{ processProjectionBatch },
			{ certifyGraphProjection },
			{ ensureGraphProjectionSchema, sweepGraphProjectionEpoch },
		] = await Promise.all([
			import("../integrations/graph-db/neo4j"),
			import("../integrations/graph-db/sync"),
			import("../services/graph-projection-certification"),
			import("../services/graph-projection-schema"),
		]);
		const leaseToken = await step.do("lease-token", async (): Promise<string> =>
			crypto.randomUUID(),
		);
		const acquired = await step.do(
			"acquire-lease",
			{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
			() => acquireGraphProjectionLease(db, organizationId, leaseToken),
		);
		if (!acquired) return { status: "busy" as const, processed: 0 };

		const readinessJson = await step.do(
			"initialize-readiness",
			{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				const current = await getGraphProjectionReadState(db, organizationId);
				const epoch = current?.projectionEpoch ?? crypto.randomUUID();
				await setGraphProjectionReadiness(db, {
					organizationId,
					state: "catching_up",
					reason: "outbox_drain_in_progress",
					projectionEpoch: epoch,
					persistedWatermark: current?.persistedWatermark ?? 0,
				});
				return JSON.stringify({
					...current,
					projectionEpoch: epoch,
				});
			},
		);
		const readiness = JSON.parse(readinessJson) as Awaited<
			ReturnType<typeof getGraphProjectionReadState>
		>;
		const projectionEpoch = readiness?.projectionEpoch ?? crypto.randomUUID();

		const { writer } = createNeo4jGraphClient(config);
		await step.do(
			"ensure-governed-schema",
			{ retries: { limit: 3, delay: "5 seconds" }, timeout: "2 minutes" },
			() => ensureGraphProjectionSchema(this.env),
		);
		// Batching, cursor advancement and lease fencing are the shared engine's;
		// this Workflow contributes the durable step adapter, batched hydration,
		// and what an abort means for readiness.
		const drain = await runGraphProjectionDrain({
			db,
			organizationId,
			leaseToken,
			maxBatches,
			runStep: <T>(
				name: string,
				options: WorkflowStepConfig,
				body: () => Promise<T>,
			) =>
				// Every engine step result is plain JSON by construction, so the
				// `Serializable<T>` Workflows round-trips is the same value. The
				// cast is here rather than in the engine because `Serializable` is
				// deeply recursive and instantiating it on every step body is what
				// the compiler cannot afford.
				step.do(name, options, body as () => Promise<never>) as Promise<T>,
			hydrate: (events) => hydrateBatch(this.env.DB, events, projectionEpoch),
			project: (events) => processProjectionBatch(events, writer),
			onAbort: async (stop, context) => {
				const reason = degradedReadinessReason(stop);
				if (reason) {
					await setGraphProjectionReadiness(db, {
						organizationId,
						state: "degraded",
						reason,
						projectionEpoch,
						persistedWatermark: context.cursor,
					});
				}
				await releaseGraphProjectionLease(db, organizationId, leaseToken);
			},
		});
		const processed = drain.processed;
		const cursor = drain.cursor;
		const blockedReason = drain.degradedReason;
		// Every abort already published readiness and released the lease inside
		// the engine's abort step. The Workflow's remaining job is to fail the run
		// so it is retried, instead of certifying a projection that did not catch
		// up.
		switch (drain.stop.kind) {
			case "drained":
			case "retry_backoff":
			case "batch_budget":
				break;
			case "hydration_failed":
			case "coordination_failed":
				throw drain.stop.error;
			case "projection_failed":
				throw drain.stop.error;
			case "lease_lost":
				throw new Error(
					drain.stop.phase === "project"
						? "graph projection lease was lost before projection"
						: "graph projection lease was lost",
				);
			case "cursor_fenced":
				throw new Error("graph projection cursor checkpoint was fenced");
		}

		const pendingCount = await step.do(
			`pending-${cursor}`,
			{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				return countPendingGraphProjectionEvents(db, organizationId, cursor);
			},
		);
		if (pendingCount > 0) {
			await step.do(
				`mark-backlog-${cursor}`,
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					await setGraphProjectionReadiness(db, {
						organizationId,
						state: blockedReason ? "degraded" : "catching_up",
						reason: blockedReason ?? "outbox_backlog_remaining",
						projectionEpoch,
						persistedWatermark: cursor,
					});
					await releaseGraphProjectionLease(db, organizationId, leaseToken);
				},
			);
			return {
				status: "catching_up" as const,
				processed,
				cursor,
				pending: pendingCount,
			};
		}

		const baselineJson = await step.do(
			"read-baseline-state",
			{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
			async () =>
				JSON.stringify(await getGraphProjectionReadState(db, organizationId)),
		);
		const baseline = JSON.parse(baselineJson) as Awaited<
			ReturnType<typeof getGraphProjectionReadState>
		>;
		const baselineComplete =
			baseline?.repairPhase === "complete" &&
			baseline.repairId !== null &&
			baseline.repairHighWater !== null &&
			cursor >= baseline.repairHighWater;
		if (!baselineComplete) {
			await step.do(
				"mark-baseline-incomplete",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					await setGraphProjectionReadiness(db, {
						organizationId,
						state: "catching_up",
						reason: "baseline_repair_incomplete",
						projectionEpoch,
						persistedWatermark: cursor,
					});
					await releaseGraphProjectionLease(db, organizationId, leaseToken);
				},
			);
			return {
				status: "catching_up" as const,
				processed,
				cursor,
				pending: 0,
				reason: "baseline_repair_incomplete",
			};
		}

		const cleanup = await step.do(
			"remove-stale-generation",
			{ retries: { limit: 5, delay: "5 seconds" }, timeout: "5 minutes" },
			async () => {
				const renewed = await renewGraphProjectionLease(
					db,
					organizationId,
					leaseToken,
				);
				if (!renewed) throw new Error("graph projection lease was lost");
				return sweepGraphProjectionEpoch({
					env: this.env,
					organizationId,
					projectionEpoch,
					beforeBatch: async () => {
						const renewed = await renewGraphProjectionLease(
							db,
							organizationId,
							leaseToken,
						);
						if (!renewed) throw new Error("graph projection lease was lost");
					},
				});
			},
		);

		const certificationJson = await step.do(
			"certify-projection",
			{ retries: { limit: 3, delay: "5 seconds" }, timeout: "5 minutes" },
			async () => {
				const inspection = await certifyGraphProjection({
					db,
					env: this.env,
					organizationId,
				});
				return JSON.stringify({
					state: inspection.readiness?.state ?? "catching_up",
					reason: inspection.readiness?.reason ?? null,
					parityPasses: inspection.parityPasses,
					schemaComplete: inspection.schema.complete,
				});
			},
		);
		const certification = JSON.parse(certificationJson) as {
			state: "disabled" | "catching_up" | "ready" | "degraded";
			reason: string | null;
			parityPasses: boolean;
			schemaComplete: boolean;
		};
		if (certification.state !== "ready") {
			await step.do(
				"release-after-certification",
				{ retries: { limit: 3, delay: "2 seconds" }, timeout: "30 seconds" },
				() => releaseGraphProjectionLease(db, organizationId, leaseToken),
			);
			return {
				status:
					certification.state === "degraded"
						? ("degraded" as const)
						: ("catching_up" as const),
				processed,
				cursor,
				certification,
				cleanup,
			};
		}

		const readyConfirmationJson = await step.do(
			"confirm-ready-with-no-new-backlog",
			{ retries: { limit: 5, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				const renewed = await renewGraphProjectionLease(
					db,
					organizationId,
					leaseToken,
				);
				if (!renewed) throw new Error("graph projection lease was lost");
				const now = new Date().toISOString();
				const ready = await confirmGraphProjectionReadyWithoutBacklog(db, {
					organizationId,
					projectionEpoch,
					persistedWatermark: cursor,
					updatedAt: now,
				});
				const pending = ready
					? 0
					: await countPendingGraphProjectionEvents(db, organizationId, cursor);
				if (!ready) {
					await setGraphProjectionReadiness(db, {
						organizationId,
						state: "catching_up",
						reason: "outbox_backlog_arrived_during_certification",
						projectionEpoch,
						persistedWatermark: cursor,
					});
				}
				await releaseGraphProjectionLease(db, organizationId, leaseToken);
				return JSON.stringify({
					ready,
					pending,
				});
			},
		);
		const readyConfirmation = JSON.parse(readyConfirmationJson) as {
			ready: boolean;
			pending: number;
		};
		if (!readyConfirmation.ready) {
			return {
				status: "catching_up" as const,
				processed,
				cursor,
				pending: readyConfirmation.pending,
				cleanup,
			};
		}
		return {
			status: "ready" as const,
			processed,
			cursor,
			certification,
			cleanup,
		};
	}
}
