import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import type { GraphWriter } from "../integrations/graph-db/sync";
import { describe, expect, it, vi } from "vite-plus/test";

const queryMocks = vi.hoisted(() => ({
	acquireGraphProjectionLease: vi.fn(),
	advanceGraphProjectionCursor: vi.fn(),
	getGraphProjectionCursor: vi.fn(),
	getGraphProjectionReadState: vi.fn(),
	readGraphProjectionBatch: vi.fn(),
	readGraphDomainBackfillPage: vi.fn(),
	readGraphEdgeBackfillPage: vi.fn(),
	readGraphFactBackfillPage: vi.fn(),
	recordGraphProjectionFailure: vi.fn(),
	releaseGraphProjectionLease: vi.fn(),
	renewGraphProjectionLease: vi.fn(),
}));

vi.mock("@tedix/db/queries/graph-projection", async () => {
	const actual = await vi.importActual<
		typeof import("@tedix/db/queries/graph-projection")
	>("@tedix/db/queries/graph-projection");
	return {
		...actual,
		acquireGraphProjectionLease: queryMocks.acquireGraphProjectionLease,
		advanceGraphProjectionCursor: queryMocks.advanceGraphProjectionCursor,
		getGraphProjectionCursor: queryMocks.getGraphProjectionCursor,
		getGraphProjectionReadState: queryMocks.getGraphProjectionReadState,
		readGraphProjectionBatch: queryMocks.readGraphProjectionBatch,
		readGraphDomainBackfillPage: queryMocks.readGraphDomainBackfillPage,
		readGraphEdgeBackfillPage: queryMocks.readGraphEdgeBackfillPage,
		readGraphFactBackfillPage: queryMocks.readGraphFactBackfillPage,
		recordGraphProjectionFailure: queryMocks.recordGraphProjectionFailure,
		releaseGraphProjectionLease: queryMocks.releaseGraphProjectionLease,
		renewGraphProjectionLease: queryMocks.renewGraphProjectionLease,
	};
});

import {
	drainGraphProjectionOrganization,
	edgeEndpointFactEvents,
	GRAPH_PROJECTION_DECISION_PREDECESSOR_PAGE_SIZE,
	GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_HEADROOM,
	GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_UPPER_BOUND,
	GRAPH_PROJECTION_REPAIR_D1_QUERY_CEILING,
	GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND,
	GRAPH_PROJECTION_REPAIR_PHASE_ORDER,
	GRAPH_PROJECTION_SYNC_D1_QUERY_CEILING,
	GraphProjectionRepairQueryBudgetError,
	planPostRepairGraphProjectionDrain,
	repairGraphProjectionCore,
} from "./graph-projection-drain";

const PROJECTION_EPOCH = "generation-a";

function outbox(
	sequence: number,
	entityKind: GraphProjectionOutboxEvent["entityKind"],
	operation: GraphProjectionOutboxEvent["operation"],
	entityId = "shared-id",
): GraphProjectionOutboxEvent {
	return {
		sequence,
		eventId: `event-${sequence}`,
		organizationId: "org-1",
		entityKind,
		entityId,
		operation,
		payload: null,
		schemaVersion: 1,
		attemptCount: 0,
		nextAttemptAt: null,
		lastError: null,
		poisonedAt: null,
		createdAt: "2026-07-27T00:00:00.000Z",
	};
}

function writer(overrides: Partial<GraphWriter> = {}): GraphWriter {
	const noop = vi.fn(async () => undefined);
	return {
		upsertFact: noop,
		upsertEdge: noop,
		upsertDomain: noop,
		upsertTedi: noop,
		upsertDecision: noop,
		upsertKnowledgeEntry: noop,
		upsertSkill: noop,
		upsertCapability: noop,
		upsertCapabilityLink: noop,
		upsertEntity: noop,
		upsertEntityResolution: noop,
		deleteCapability: noop,
		deleteCapabilityLink: noop,
		deleteFact: noop,
		deleteEdge: noop,
		deleteDomain: noop,
		deleteTedi: noop,
		deleteDecision: noop,
		deleteKnowledgeEntry: noop,
		deleteSkill: noop,
		deleteEntity: noop,
		revokeEntityResolution: noop,
		upsertTediExpertise: noop,
		deleteTediExpertise: noop,
		...overrides,
	};
}

function arrange(events: GraphProjectionOutboxEvent[]): void {
	vi.clearAllMocks();
	queryMocks.acquireGraphProjectionLease.mockResolvedValue(true);
	queryMocks.getGraphProjectionReadState.mockResolvedValue({
		projectionEpoch: PROJECTION_EPOCH,
	});
	queryMocks.getGraphProjectionCursor.mockResolvedValue(0);
	queryMocks.readGraphProjectionBatch.mockResolvedValue(events);
	queryMocks.advanceGraphProjectionCursor.mockResolvedValue(true);
	queryMocks.recordGraphProjectionFailure.mockResolvedValue({
		attemptCount: 1,
		poisoned: false,
		nextAttemptAt: "2026-07-27T00:00:02.000Z",
	});
	queryMocks.releaseGraphProjectionLease.mockResolvedValue(undefined);
	queryMocks.renewGraphProjectionLease.mockResolvedValue(true);
}

describe("edge endpoint fact hydration", () => {
	const factRow = (id: string) => ({
		id,
		organizationId: "org-1",
		tediId: null,
		domainId: null,
		content: `content for ${id}`,
		summary: null,
		factType: "observation",
		confidence: 0.9,
		validTo: null,
		archivedAt: null,
		priority: null,
		visibility: null,
		accessCount: 0,
		usageCount: 0,
		createdAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:00.000Z",
	});
	const edgeEvent = (id: string, source: string, target: string) => ({
		op: "upsert_edge" as const,
		id,
		orgId: "org-1",
		timestamp: 0,
		payload: {
			id,
			orgId: "org-1",
			sourceFactId: source,
			targetFactId: target,
			relationType: "supersedes",
			strength: 0.5,
			context: null,
			updatedAt: "2026-07-27T00:00:00.000Z",
		} as never,
	});
	function fakeDb(rows: unknown[]) {
		return {
			select: vi.fn(() => {
				const builder = {
					from: () => builder,
					innerJoin: () => builder,
					where: () => builder,
					limit: async () => [rows.shift()],
				};
				return builder;
			}),
		} as never;
	}

	it("does not refetch an endpoint the batch already carries", async () => {
		// The edge's source arrives as its own event in this batch, so only the
		// target needs hydrating. Refetching the source would be a wasted D1 read
		// on every batch that pairs a fact with an edge touching it.
		const db = fakeDb([factRow("fact-target")]);
		const events = [
			{
				op: "upsert_fact" as const,
				id: "fact-source",
				orgId: "org-1",
				timestamp: 0,
				payload: factRow("fact-source") as never,
			},
			edgeEvent("edge-1", "fact-source", "fact-target"),
		];

		const hydrated = await edgeEndpointFactEvents(
			db,
			"org-1",
			events,
			PROJECTION_EPOCH,
		);

		expect(hydrated.map((item) => item.id)).toEqual(["fact-target"]);
	});

	it("hydrates each missing endpoint once across several edges", async () => {
		// Two edges sharing an endpoint must not produce two upserts for it.
		const db = fakeDb([
			factRow("fact-a"),
			factRow("fact-b"),
			factRow("fact-c"),
		]);
		const hydrated = await edgeEndpointFactEvents(
			db,
			"org-1",
			[
				edgeEvent("edge-1", "fact-a", "fact-b"),
				edgeEvent("edge-2", "fact-a", "fact-c"),
			],
			PROJECTION_EPOCH,
		);

		expect(hydrated.map((item) => item.id).sort()).toEqual([
			"fact-a",
			"fact-b",
			"fact-c",
		]);
	});

	it("skips an endpoint that no longer exists in D1", async () => {
		// Inventing a node the canonical store does not have would be worse than
		// letting the edge fail its own verification.
		const db = fakeDb([undefined]);
		const hydrated = await edgeEndpointFactEvents(
			db,
			"org-1",
			[edgeEvent("edge-1", "fact-gone", "fact-gone")],
			PROJECTION_EPOCH,
		);

		expect(hydrated).toEqual([]);
	});
});

describe("durable graph projection drain", () => {
	it("projects an edge's endpoint facts even when their own events queue later", async () => {
		// The regression this guards: the Neo4j driver MATCHes both endpoints
		// before merging a relationship and throws when it wrote nothing. An edge
		// whose endpoint fact has not been projected yet is therefore a permanent
		// failure, not a transient one — the endpoint's own upsert event can sit
		// hundreds of thousands of sequences later, behind the very edge waiting
		// on it. One organization deadlocked exactly this way and stopped
		// projecting for 37 days.
		arrange([outbox(1, "edge", "upsert", "edge-1")]);
		const fact = (id: string) => ({
			id,
			organizationId: "org-1",
			tediId: null,
			domainId: null,
			content: `content for ${id}`,
			summary: null,
			factType: "observation",
			confidence: 0.9,
			validTo: null,
			archivedAt: null,
			priority: null,
			visibility: null,
			accessCount: 0,
			usageCount: 0,
			createdAt: "2026-07-27T00:00:00.000Z",
			updatedAt: "2026-07-27T00:00:00.000Z",
		});
		// Read in call order: the edge itself, then each endpoint fact.
		const rows: unknown[] = [
			{
				id: "edge-1",
				organizationId: "org-1",
				sourceFactId: "fact-source",
				targetFactId: "fact-target",
				relationType: "supersedes",
				strength: 0.5,
				context: null,
				createdAt: "2026-07-27T00:00:00.000Z",
			},
			fact("fact-source"),
			fact("fact-target"),
		];
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				innerJoin: () => builder,
				where: () => builder,
				limit: async () => [rows.shift()],
			};
			return builder;
		});
		const order: string[] = [];
		const upsertFact = vi.fn(async (fact: { id: string }) => {
			order.push(`fact:${fact.id}`);
		});
		const upsertEdge = vi.fn(async (edge: { id: string }) => {
			order.push(`edge:${edge.id}`);
		});

		const result = await drainGraphProjectionOrganization({
			db: { select } as never,
			writer: writer({ upsertFact, upsertEdge }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(result.blocked).toBeNull();
		// Both endpoints are written, and both land before the edge needing them.
		expect(order).toEqual([
			"fact:fact-source",
			"fact:fact-target",
			"edge:edge-1",
		]);
		// The cursor still advances by outbox sequence, not by sync-event count.
		expect(result.cursorAfter).toBe(1);
	});

	it("acknowledges a poisoned head instead of parking the cursor on it", async () => {
		// A poisoned event has spent its retry budget: nothing will ever make it
		// projectable, so stopping on it freezes the organization permanently and
		// keeps every later row above the prune cursor.
		const poisonedHead = outbox(1, "fact", "upsert", "fact-poisoned");
		poisonedHead.poisonedAt = "2026-07-27T06:50:00.000Z";
		arrange([poisonedHead, outbox(2, "domain", "upsert", "domain-1")]);
		const rows: unknown[] = [
			{
				id: "domain-1",
				organizationId: "org-1",
				name: "Domain 1",
				parentId: null,
				description: null,
			},
		];
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				innerJoin: () => builder,
				where: () => builder,
				limit: async () => [rows.shift()],
			};
			return builder;
		});
		const upsertFact = vi.fn(async () => undefined);
		const upsertDomain = vi.fn(async () => undefined);

		const result = await drainGraphProjectionOrganization({
			db: { select } as never,
			writer: writer({ upsertFact, upsertDomain }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(result.blocked).toBeNull();
		// The poisoned event is never projected, but the cursor clears it.
		expect(upsertFact).not.toHaveBeenCalled();
		expect(upsertDomain).toHaveBeenCalledTimes(1);
		expect(result.cursorAfter).toBe(2);
	});

	it("rejects an empty projection epoch before acquiring the drain lease", async () => {
		vi.clearAllMocks();

		await expect(
			drainGraphProjectionOrganization({
				db: {} as never,
				writer: writer(),
				organizationId: "org-1",
				projectionEpoch: "   ",
			}),
		).rejects.toThrow(
			"Direct graph projection drain requires a stable projectionEpoch",
		);

		expect(queryMocks.acquireGraphProjectionLease).not.toHaveBeenCalled();
	});

	it("releases the token when the cursor read fails after acquisition", async () => {
		arrange([]);
		const cursorError = new Error("D1 cursor unavailable");
		queryMocks.getGraphProjectionCursor.mockRejectedValueOnce(cursorError);

		await expect(
			drainGraphProjectionOrganization({
				db: {} as never,
				writer: writer(),
				organizationId: "org-1",
				projectionEpoch: PROJECTION_EPOCH,
			}),
		).rejects.toThrow(cursorError);

		const leaseToken = queryMocks.acquireGraphProjectionLease.mock.calls[0]![2];
		expect(queryMocks.releaseGraphProjectionLease).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			leaseToken,
		);
	});

	it("does not hydrate or acknowledge after a newer repair rotates the epoch", async () => {
		const pending = outbox(6, "fact", "delete", "fact-1");
		arrange([pending]);
		queryMocks.getGraphProjectionReadState.mockResolvedValueOnce({
			projectionEpoch: "generation-b",
		});
		const deleteFact = vi.fn(async () => undefined);

		const result = await drainGraphProjectionOrganization({
			db: {} as never,
			writer: writer({ deleteFact }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(result).toMatchObject({
			acquired: true,
			processed: 0,
			blocked: "epoch_changed",
			failedSequence: null,
		});
		expect(queryMocks.getGraphProjectionCursor).not.toHaveBeenCalled();
		expect(queryMocks.readGraphProjectionBatch).not.toHaveBeenCalled();
		expect(deleteFact).not.toHaveBeenCalled();
		expect(queryMocks.recordGraphProjectionFailure).not.toHaveBeenCalled();
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
		expect(queryMocks.releaseGraphProjectionLease).toHaveBeenCalledTimes(1);
	});

	it("records hydration failure on the exact outbox event and does not advance", async () => {
		const failed = outbox(7, "entity", "upsert", "entity-1");
		arrange([failed]);
		const hydrationError = new Error("canonical entity unavailable");

		const result = await drainGraphProjectionOrganization({
			db: {} as never,
			writer: writer(),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
			extensionHydrator: async () => {
				throw hydrationError;
			},
		});

		expect(result).toMatchObject({
			blocked: "projection_error",
			failedSequence: 7,
			cursorAfter: 0,
		});
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledWith(
			expect.anything(),
			failed,
			hydrationError,
		);
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
		expect(queryMocks.releaseGraphProjectionLease).toHaveBeenCalledTimes(1);
	});

	it("retains every coalesced source event when the shared phased writer fails", async () => {
		const factDelete = outbox(11, "fact", "delete");
		const domainDelete = outbox(12, "domain", "delete");
		arrange([factDelete, domainDelete]);
		const projectionError = new Error("domain write failed");
		const deleteFact = vi.fn(async () => undefined);
		const deleteDomain = vi.fn(async () => {
			throw projectionError;
		});

		const result = await drainGraphProjectionOrganization({
			db: {} as never,
			writer: writer({ deleteFact, deleteDomain }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(deleteFact).toHaveBeenCalledWith("shared-id", "org-1");
		expect(deleteDomain).toHaveBeenCalledWith("shared-id", "org-1");
		expect(result).toMatchObject({
			blocked: "projection_error",
			failedSequence: 11,
			processed: 0,
			cursorAfter: 0,
		});
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledWith(
			expect.anything(),
			factDelete,
			projectionError,
		);
		expect(queryMocks.recordGraphProjectionFailure).toHaveBeenCalledWith(
			expect.anything(),
			domainDelete,
			projectionError,
		);
		expect(queryMocks.advanceGraphProjectionCursor).not.toHaveBeenCalled();
	});

	it("advances only after every coalesced event succeeds", async () => {
		const events = [
			outbox(21, "fact", "delete", "fact-1"),
			outbox(22, "domain", "delete", "domain-1"),
		];
		arrange(events);

		const result = await drainGraphProjectionOrganization({
			db: {} as never,
			writer: writer(),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(queryMocks.recordGraphProjectionFailure).not.toHaveBeenCalled();
		const leaseToken = queryMocks.acquireGraphProjectionLease.mock.calls[0]![2];
		expect(queryMocks.advanceGraphProjectionCursor).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			leaseToken,
			22,
			{ expectedCursor: 0 },
		);
		expect(queryMocks.releaseGraphProjectionLease).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			leaseToken,
		);
		expect(result).toMatchObject({
			blocked: null,
			processed: 2,
			cursorAfter: 22,
		});
	});

	it("stamps core and extension upserts with the active projection epoch", async () => {
		const events = [
			outbox(23, "fact", "upsert", "fact-1"),
			outbox(24, "edge", "upsert", "edge-1"),
			outbox(25, "decision", "upsert", "decision-1"),
			outbox(26, "entity", "upsert", "entity-1"),
		];
		arrange(events);
		const rows = [
			{
				id: "fact-1",
				organizationId: "org-1",
				tediId: "tedi-1",
				domainId: null,
				content: "Canonical fact",
				summary: null,
				factType: "technical",
				confidence: 0.9,
				validTo: null,
				archivedAt: null,
				priority: null,
				visibility: null,
				accessCount: 0,
				usageCount: 0,
				createdAt: "2026-07-27T00:00:00.000Z",
				updatedAt: "2026-07-27T00:00:00.000Z",
			},
			{
				id: "decision-1",
				tediId: "tedi-1",
				orgId: "org-1",
				action: "ship",
				rationale: "Evidence passed",
				category: "deployment",
				confidence: 0.9,
				outcomeStatus: "completed",
				evidence: {},
				objectiveId: null,
				approvalRequestId: null,
				createdAt: "2026-07-27T00:00:00.000Z",
				completedAt: "2026-07-27T00:01:00.000Z",
			},
			{
				id: "edge-1",
				sourceFactId: "fact-1",
				targetFactId: "fact-2",
				relationType: "supports",
				strength: 0.8,
				context: "Verified support",
				createdAt: "2026-07-27T00:00:00.000Z",
				organizationId: "org-1",
			},
		];
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				innerJoin: () => builder,
				where: () => builder,
				limit: async () => [rows.shift()],
			};
			return builder;
		});
		const upsertFact = vi.fn(async () => undefined);
		const upsertEdge = vi.fn(async () => undefined);
		const upsertDecision = vi.fn(async () => undefined);
		const upsertEntity = vi.fn(async () => undefined);

		const result = await drainGraphProjectionOrganization({
			db: { select } as never,
			writer: writer({ upsertFact, upsertEdge, upsertDecision, upsertEntity }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
			extensionHydrator: async (_db, event) => ({
				op: "upsert_entity",
				id: event.entityId,
				orgId: event.organizationId,
				timestamp: Date.parse(event.createdAt),
				payload: {
					id: event.entityId,
					orgId: event.organizationId,
					entityType: "organization",
					displayName: "Entity 1",
					normalizedName: "entity 1",
					status: "active",
					mergedIntoEntityId: null,
					version: 1,
					updatedAt: event.createdAt,
				},
			}),
		});

		expect(upsertFact).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "fact-1",
				projectionEpoch: PROJECTION_EPOCH,
			}),
		);
		expect(upsertDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "decision-1",
				projectionEpoch: PROJECTION_EPOCH,
			}),
		);
		expect(upsertEdge).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "edge-1",
				projectionEpoch: PROJECTION_EPOCH,
			}),
		);
		expect(upsertEntity).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "entity-1",
				projectionEpoch: PROJECTION_EPOCH,
			}),
		);
		expect(result).toMatchObject({
			blocked: null,
			processed: 4,
			cursorAfter: 26,
		});
	});

	it("revokes a resolution with its canonical validity cutoff", async () => {
		const validTo = "2026-07-26T23:59:59.000Z";
		const resolutionDelete = {
			...outbox(31, "entity_resolution", "delete", "resolution-1"),
			payload: {
				mentionId: "mention-1",
				factId: "fact-1",
				entityId: null,
				decisionId: "rollback-1",
				validTo,
			},
		} satisfies GraphProjectionOutboxEvent;
		arrange([resolutionDelete]);
		const revokeEntityResolution = vi.fn(async () => undefined);

		const result = await drainGraphProjectionOrganization({
			db: {} as never,
			writer: writer({ revokeEntityResolution }),
			organizationId: "org-1",
			projectionEpoch: PROJECTION_EPOCH,
		});

		expect(revokeEntityResolution).toHaveBeenCalledWith(
			"resolution-1",
			"org-1",
			validTo,
		);
		expect(revokeEntityResolution).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			blocked: null,
			processed: 1,
			cursorAfter: 31,
		});
	});
});

describe("full-manifest graph projection repair", () => {
	it("reserves lease and checkpoint headroom below the D1 query ceiling", () => {
		expect(GRAPH_PROJECTION_REPAIR_D1_QUERY_CEILING).toBeLessThan(1_000);
		expect(GRAPH_PROJECTION_REPAIR_PAGE_D1_QUERY_UPPER_BOUND).toBe(1);
		expect(GRAPH_PROJECTION_DECISION_PREDECESSOR_PAGE_SIZE).toBe(50);
	});

	it("bounds baseline plus post-repair draining below the D1 query ceiling", () => {
		expect(GRAPH_PROJECTION_SYNC_D1_QUERY_CEILING).toBe(990);
		expect(GRAPH_PROJECTION_SYNC_D1_QUERY_CEILING).toBeLessThan(1_000);
		expect(
			GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_UPPER_BOUND,
		).toBeLessThanOrEqual(
			GRAPH_PROJECTION_POST_REPAIR_DRAIN_FIXED_D1_QUERY_HEADROOM,
		);
		expect(
			planPostRepairGraphProjectionDrain({
				repairComplete: true,
				requestedBatches: 20,
				requestedBatchSize: 500,
			}),
		).toEqual({
			maxBatches: 1,
			batchSize: 31,
			d1QueryCeiling: 40,
		});
		expect(
			planPostRepairGraphProjectionDrain({
				repairComplete: false,
				requestedBatches: 20,
				requestedBatchSize: 500,
			}),
		).toEqual({
			maxBatches: 0,
			batchSize: 0,
			d1QueryCeiling: 0,
		});
	});

	it("keeps every managed phase ahead of the destructive sweep", () => {
		expect(GRAPH_PROJECTION_REPAIR_PHASE_ORDER).toEqual([
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
			// Work graph, ordered so each phase's MERGE targets already exist:
			// Project before WorkItem before WorkItemSource. All three sit ahead of
			// the destructive sweep, which is what this guard exists to enforce.
			"projects",
			"work_items",
			"work_item_sources",
			"sweep",
			"complete",
		]);
	});

	it("asserts the repair lease immediately before a page mutation", async () => {
		const order: string[] = [];
		queryMocks.readGraphDomainBackfillPage.mockResolvedValueOnce({
			rows: [
				{
					id: "domain-1",
					organizationId: "org-1",
					name: "Operations",
					parentId: null,
					description: null,
				},
			],
			nextCursor: "domain-1",
			done: false,
		});
		const upsertDomain = vi.fn(async () => {
			order.push("neo4j");
		});
		const beforePage = vi.fn(async () => {
			order.push("lease");
		});

		await repairGraphProjectionCore({
			db: {} as never,
			writer: writer({ upsertDomain }),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "domains", cursor: null },
			maxPages: 1,
			beforePage,
			sweepRepair: vi.fn(async () => undefined),
		});

		expect(order).toEqual(["lease", "neo4j"]);
		expect(beforePage).toHaveBeenCalledWith({
			phase: "domains",
			cursor: null,
		});
	});

	it("does not mutate or checkpoint a page after its lease assertion fails", async () => {
		queryMocks.readGraphFactBackfillPage.mockResolvedValueOnce({
			rows: [
				{
					id: "fact-1",
					organizationId: "org-1",
					tediId: null,
					domainId: null,
					content: "Canonical evidence",
					summary: null,
					factType: "technical",
					confidence: 0.9,
					validTo: null,
					archivedAt: null,
					priority: null,
					visibility: null,
					accessCount: 0,
					usageCount: 0,
					createdAt: "2026-07-27T00:00:00.000Z",
					updatedAt: "2026-07-27T00:00:00.000Z",
				},
			],
			nextCursor: "fact-1",
			done: false,
		});
		const upsertFacts = vi.fn(async () => undefined);
		const onCheckpoint = vi.fn(async () => undefined);

		await expect(
			repairGraphProjectionCore({
				db: {} as never,
				writer: writer({ upsertFacts }),
				organizationId: "org-1",
				projectionEpoch: "generation-a",
				repairEpoch: "repair-7",
				checkpoint: { phase: "facts", cursor: null },
				maxPages: 1,
				beforePage: async () => {
					throw new Error("repair lease lost");
				},
				onCheckpoint,
				sweepRepair: vi.fn(async () => undefined),
			}),
		).rejects.toThrow("repair lease lost");

		expect(upsertFacts).not.toHaveBeenCalled();
		expect(onCheckpoint).not.toHaveBeenCalled();
	});

	it("hydrates a managed page set-wise and returns the last clean checkpoint", async () => {
		const entities = Array.from({ length: 10 }, (_, index) => ({
			id: `entity-${index + 1}`,
			organizationId: "org-1",
			entityType: "organization",
			displayName: `Entity ${index + 1}`,
			normalizedName: `entity ${index + 1}`,
			status: "active",
			mergedIntoEntityId: null,
			version: 1,
			updatedAt: "2026-07-27T00:00:00.000Z",
		}));
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit: async (limit: number) => entities.slice(0, limit),
			};
			return builder;
		});
		const upsertEntity = vi.fn(async () => undefined);

		const result = await repairGraphProjectionCore({
			db: { select } as never,
			writer: writer({ upsertEntity }),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "entities", cursor: null },
			pageSize: 500,
			maxPages: 50,
			d1QueryBudget: 1,
			sweepRepair: vi.fn(async () => undefined),
		});

		expect(result).toMatchObject({
			checkpoint: { phase: "entity_resolutions", cursor: null },
			pagesProcessed: 1,
			canonicalD1QueriesUsed: 1,
			stoppedReason: "query_budget",
		});
		expect(select).toHaveBeenCalledTimes(1);
		expect(upsertEntity).toHaveBeenCalledTimes(10);
	});

	it("materializes decision context without premature predecessor rebuilding", async () => {
		const canonicalDecision = {
			id: "decision-1",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "ship",
			rationale: "Evidence passed",
			category: "deployment",
			confidence: 0.9,
			outcomeStatus: "completed",
			evidence: {},
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: "2026-07-27T00:01:00.000Z",
		};
		const select = vi.fn((selection?: unknown) => {
			const rows = selection
				? [{ id: canonicalDecision.id }]
				: [canonicalDecision];
			const builder = {
				from: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit: async () => rows,
			};
			return builder;
		});
		const upsertDecisionContexts = vi.fn(async () => undefined);
		const rebuildDecisionPredecessors = vi.fn(async () => undefined);

		const result = await repairGraphProjectionCore({
			db: { select } as never,
			writer: writer({
				upsertDecisionContexts,
				rebuildDecisionPredecessors,
			}),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "decisions", cursor: null },
			pageSize: 500,
			maxPages: 1,
			sweepRepair: vi.fn(async () => undefined),
		});

		expect(upsertDecisionContexts).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					id: "decision-1",
					projectionEpoch: "generation-a",
					projectionRepairEpoch: "repair-7",
				}),
			],
			{
				requireProjectionEpoch: true,
				requireRepairEpoch: true,
			},
		);
		expect(rebuildDecisionPredecessors).not.toHaveBeenCalled();
		expect(result.checkpoint).toEqual({
			phase: "decision_predecessors",
			cursor: null,
		});
	});

	it("does not checkpoint a decision page when context materialization fails", async () => {
		const canonicalDecision = {
			id: "decision-1",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "ship",
			rationale: "Evidence passed",
			category: "deployment",
			confidence: 0.9,
			outcomeStatus: "completed",
			evidence: {},
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: "2026-07-27T00:01:00.000Z",
		};
		const select = vi.fn((selection?: unknown) => {
			const rows = selection
				? [{ id: canonicalDecision.id }]
				: [canonicalDecision];
			const builder = {
				from: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit: async () => rows,
			};
			return builder;
		});
		const materializationError = new Error("Neo4j context write failed");
		const upsertDecisionContexts = vi.fn(async () => {
			throw materializationError;
		});
		const rebuildDecisionPredecessors = vi.fn(async () => undefined);
		const onCheckpoint = vi.fn(async () => undefined);

		await expect(
			repairGraphProjectionCore({
				db: { select } as never,
				writer: writer({
					upsertDecisionContexts,
					rebuildDecisionPredecessors,
				}),
				organizationId: "org-1",
				projectionEpoch: "generation-a",
				repairEpoch: "repair-7",
				checkpoint: { phase: "decisions", cursor: null },
				pageSize: 500,
				maxPages: 1,
				onCheckpoint,
				sweepRepair: vi.fn(async () => undefined),
			}),
		).rejects.toBe(materializationError);

		expect(rebuildDecisionPredecessors).not.toHaveBeenCalled();
		expect(onCheckpoint).not.toHaveBeenCalled();
	});

	it("persists the complete checkpoint only after a successful sweep", async () => {
		const sweepRepair = vi.fn(async () => undefined);
		const onCheckpoint = vi.fn(async () => undefined);

		const result = await repairGraphProjectionCore({
			db: {} as never,
			writer: writer(),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "sweep", cursor: null },
			maxPages: 1,
			sweepRepair,
			onCheckpoint,
		});

		expect(sweepRepair).toHaveBeenCalledWith("repair-7");
		expect(onCheckpoint).toHaveBeenCalledWith({
			phase: "complete",
			cursor: null,
		});
		expect(result.checkpoint).toEqual({ phase: "complete", cursor: null });
	});

	it("does not advance or checkpoint when the sweep fails", async () => {
		const onCheckpoint = vi.fn(async () => undefined);
		await expect(
			repairGraphProjectionCore({
				db: {} as never,
				writer: writer(),
				organizationId: "org-1",
				projectionEpoch: "generation-a",
				repairEpoch: "repair-7",
				checkpoint: { phase: "sweep", cursor: null },
				maxPages: 1,
				sweepRepair: async () => {
					throw new Error("sweep failed");
				},
				onCheckpoint,
			}),
		).rejects.toThrow("sweep failed");
		expect(onCheckpoint).not.toHaveBeenCalled();
	});

	it("returns the sweep checkpoint when cleanup reaches its D1 query budget", async () => {
		const onCheckpoint = vi.fn(async () => undefined);
		const result = await repairGraphProjectionCore({
			db: {} as never,
			writer: writer(),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "sweep", cursor: null },
			maxPages: 1,
			sweepRepair: async () => {
				throw new GraphProjectionRepairQueryBudgetError(
					"cleanup query budget reached",
				);
			},
			onCheckpoint,
		});

		expect(result).toMatchObject({
			checkpoint: { phase: "sweep", cursor: null },
			pagesProcessed: 0,
			stoppedReason: "query_budget",
		});
		expect(onCheckpoint).not.toHaveBeenCalled();
	});

	it("stamps the complete predecessor pass for the following repair sweep", async () => {
		const canonicalDecision = {
			id: "decision-1",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "ship",
			rationale: "Evidence passed",
			category: "deployment",
			confidence: 0.9,
			outcomeStatus: "completed",
			evidence: {},
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: "2026-07-27T00:01:00.000Z",
		};
		const limit = vi.fn(async () => [canonicalDecision]);
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit,
			};
			return builder;
		});
		const order: string[] = [];
		const rebuildDecisionPredecessors = vi.fn(async () => {
			order.push("neo4j");
		});
		const beforePage = vi.fn(async () => {
			order.push("lease");
		});

		const result = await repairGraphProjectionCore({
			db: { select } as never,
			writer: writer({ rebuildDecisionPredecessors }),
			organizationId: "org-1",
			projectionEpoch: "generation-a",
			repairEpoch: "repair-7",
			checkpoint: { phase: "decision_predecessors", cursor: null },
			pageSize: 500,
			maxPages: 1,
			beforePage,
			sweepRepair: vi.fn(async () => undefined),
		});

		expect(rebuildDecisionPredecessors).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "decision-1",
				projectionEpoch: "generation-a",
				projectionRepairEpoch: "repair-7",
			}),
		]);
		expect(result.checkpoint).toEqual({
			phase: "knowledge_entries",
			cursor: null,
		});
		expect(select).toHaveBeenCalledTimes(1);
		expect(limit).toHaveBeenCalledWith(
			GRAPH_PROJECTION_DECISION_PREDECESSOR_PAGE_SIZE + 1,
		);
		expect(order).toEqual(["lease", "neo4j"]);
	});

	it("does not mutate or checkpoint predecessors when the pre-page gate fails", async () => {
		const canonicalDecision = {
			id: "decision-1",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "ship",
			rationale: "Evidence passed",
			category: "deployment",
			confidence: 0.9,
			outcomeStatus: "completed",
			evidence: {},
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: "2026-07-27T00:01:00.000Z",
		};
		const select = vi.fn(() => {
			const builder = {
				from: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit: async () => [canonicalDecision],
			};
			return builder;
		});
		const rebuildDecisionPredecessors = vi.fn(async () => undefined);
		const onCheckpoint = vi.fn(async () => undefined);

		await expect(
			repairGraphProjectionCore({
				db: { select } as never,
				writer: writer({ rebuildDecisionPredecessors }),
				organizationId: "org-1",
				projectionEpoch: "generation-a",
				repairEpoch: "repair-7",
				checkpoint: { phase: "decision_predecessors", cursor: null },
				pageSize: 500,
				maxPages: 1,
				beforePage: async () => {
					throw new Error("Graph projection predecessor index is not online");
				},
				onCheckpoint,
				sweepRepair: vi.fn(async () => undefined),
			}),
		).rejects.toThrow("predecessor index is not online");

		expect(rebuildDecisionPredecessors).not.toHaveBeenCalled();
		expect(onCheckpoint).not.toHaveBeenCalled();
	});
});
