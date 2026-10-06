import { describe, expect, it, vi } from "vite-plus/test";
import {
	type GraphWriter,
	processProjectionBatch,
	processSyncBatch,
	processSyncEvent,
} from "./sync";
import type { GraphFact, SyncEvent } from "./types";

function writer(overrides: Partial<GraphWriter> = {}): GraphWriter {
	const noop = vi.fn(async () => undefined);
	return {
		upsertFact: noop,
		upsertEdge: noop,
		upsertDomain: noop,
		upsertTedi: noop,
		upsertDecision: noop,
		upsertKnowledgeEntry: noop,
		upsertProject: noop,
		upsertWorkItem: noop,
		upsertWorkItemSource: noop,
		deleteProject: noop,
		deleteWorkItem: noop,
		deleteWorkItemSource: noop,
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

function fact(id: string): GraphFact {
	return {
		id,
		orgId: "org-1",
		tediId: null,
		domainId: null,
		content: id,
		summary: null,
		factType: "technical",
		confidence: 0.9,
		validTo: null,
		archivedAt: null,
		priority: "active",
		visibility: "org",
		accessCount: 0,
		usageCount: 0,
		createdAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:00.000Z",
	};
}

describe("graph sync batch", () => {
	it("projects canonical Work Item disposition and work kind vocabulary", async () => {
		const upsertWorkItem = vi.fn<GraphWriter["upsertWorkItem"]>();
		const payload = {
			id: "work-1",
			orgId: "org-1",
			title: "Canonical work",
			workKind: "coding",
			disposition: "accepted",
			priority: "high",
			projectId: null,
			parentWorkItemId: null,
			assigneeTediId: null,
			objectiveId: null,
			createdAt: "2026-08-20T00:00:00.000Z",
			updatedAt: "2026-08-20T00:00:00.000Z",
		};

		await processSyncEvent(
			{
				op: "upsert_work_item",
				id: payload.id,
				orgId: payload.orgId,
				timestamp: 1,
				payload,
			},
			writer({ upsertWorkItem }),
		);

		expect(upsertWorkItem).toHaveBeenCalledWith(payload);
		const {
			disposition: _disposition,
			workKind: _workKind,
			...legacyPayload
		} = payload;
		await expect(
			processSyncEvent(
				{
					op: "upsert_work_item",
					id: "legacy-work",
					orgId: "org-1",
					timestamp: 2,
					payload: {
						...legacyPayload,
						id: "legacy-work",
						status: "done",
						itemType: "task",
					},
				} as unknown as SyncEvent,
				writer(),
			),
		).rejects.toThrow("missing id, title, or disposition");
	});

	it("returns per-event results and stops at the first failed event", async () => {
		const upsertFact = vi
			.fn<GraphWriter["upsertFact"]>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("neo4j unavailable"))
			.mockResolvedValueOnce(undefined);
		const events: SyncEvent[] = ["first", "failed", "later"].map((id) => ({
			op: "upsert_fact",
			id,
			orgId: "org-1",
			timestamp: 1,
			payload: fact(id),
		}));

		const result = await processSyncBatch(events, writer({ upsertFact }), {
			stopOnError: true,
		});

		expect(result).toMatchObject({ processed: 1, errors: 1 });
		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toMatchObject({
			event: { id: "first" },
			success: true,
		});
		expect(result.results[1]).toMatchObject({
			event: { id: "failed" },
			success: false,
		});
		expect(upsertFact).toHaveBeenCalledTimes(2);
	});

	it("normalizes legacy edge payload metadata from its tenant-scoped envelope", async () => {
		const upsertEdge = vi.fn<GraphWriter["upsertEdge"]>();
		await processSyncEvent(
			{
				op: "upsert_edge",
				id: "edge-1",
				orgId: "org-1",
				timestamp: 1,
				payload: {
					sourceFactId: "source",
					targetFactId: "target",
					relationType: "related_to",
					strength: 0.8,
					context: null,
				},
			},
			writer({ upsertEdge }),
		);

		expect(upsertEdge).toHaveBeenCalledWith({
			id: "edge-1",
			orgId: "org-1",
			sourceFactId: "source",
			targetFactId: "target",
			relationType: "related_to",
			strength: 0.8,
			context: null,
			updatedAt: null,
		});
	});

	it("forwards tenant scope on edge deletes", async () => {
		const deleteEdge = vi.fn<GraphWriter["deleteEdge"]>();
		await processSyncEvent(
			{
				op: "delete_edge",
				id: "edge-1",
				orgId: "org-1",
				timestamp: 1,
				payload: {
					id: "edge-1",
					orgId: "org-1",
					sourceFactId: "source",
					targetFactId: "target",
					relationType: "requires",
					strength: 0,
					context: null,
					updatedAt: null,
				},
			},
			writer({ deleteEdge }),
		);

		expect(deleteEdge).toHaveBeenCalledWith(
			"source",
			"target",
			"requires",
			"org-1",
		);
	});

	it("forwards stable and repair epochs on tedi expertise writes", async () => {
		const upsertTediExpertise = vi.fn<GraphWriter["upsertTediExpertise"]>();
		await processSyncEvent(
			{
				op: "upsert_tedi_expertise",
				id: "tedi-1:domain-1",
				orgId: "org-1",
				timestamp: 1,
				payload: {
					tediId: "tedi-1",
					domainId: "domain-1",
					level: "expert",
					avgConfidence: 0.9,
					projectionEpoch: "generation-1",
					projectionRepairEpoch: "repair-7",
				},
			},
			writer({ upsertTediExpertise }),
		);

		expect(upsertTediExpertise).toHaveBeenCalledWith(
			"tedi-1",
			"domain-1",
			"expert",
			0.9,
			"org-1",
			"repair-7",
			"generation-1",
		);
	});

	it("rejects a payload whose tenant disagrees with its canonical envelope", async () => {
		const upsertFact = vi.fn<GraphWriter["upsertFact"]>();
		await expect(
			processSyncEvent(
				{
					op: "upsert_fact",
					id: "fact-1",
					orgId: "org-1",
					timestamp: 1,
					payload: { ...fact("fact-1"), orgId: "org-2" },
				},
				writer({ upsertFact }),
			),
		).rejects.toThrow(
			"payload organization does not match its canonical event envelope",
		);
		expect(upsertFact).not.toHaveBeenCalled();
	});

	it("enforces canonical tenant scope before bulk projection writes", async () => {
		const upsertFacts = vi.fn<NonNullable<GraphWriter["upsertFacts"]>>();
		await expect(
			processProjectionBatch(
				[
					{
						op: "upsert_fact",
						id: "fact-1",
						orgId: "org-1",
						timestamp: 1,
						payload: { ...fact("fact-1"), orgId: "org-2" },
					},
				],
				writer({ upsertFacts }),
			),
		).rejects.toThrow(
			"payload organization does not match its canonical event envelope",
		);
		expect(upsertFacts).not.toHaveBeenCalled();
	});

	it("validates canonical decision scope before a deferred predecessor batch", async () => {
		const upsertDecisionContexts =
			vi.fn<NonNullable<GraphWriter["upsertDecisionContexts"]>>();
		const upsertDecisions =
			vi.fn<NonNullable<GraphWriter["upsertDecisions"]>>();
		const decision = {
			id: "decision-1",
			orgId: "org-1",
			tediId: "tedi-1",
			action: "ship",
			rationale: "evidence",
			category: "test",
			confidence: 1,
			outcomeStatus: "success",
			evidence: "[]",
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: null,
		} as const;
		const graphWriter = writer({
			upsertDecisionContexts,
			upsertDecisions,
		});

		await processProjectionBatch(
			[
				{
					op: "upsert_decision",
					id: decision.id,
					orgId: decision.orgId,
					timestamp: 1,
					payload: decision,
				},
			],
			graphWriter,
			{ deferDecisionPredecessors: true },
		);

		expect(upsertDecisionContexts).toHaveBeenCalledWith([decision], {
			requireProjectionEpoch: true,
			requireRepairEpoch: true,
		});
		expect(upsertDecisions).not.toHaveBeenCalled();

		await expect(
			processProjectionBatch(
				[
					{
						op: "upsert_decision",
						id: decision.id,
						orgId: "org-2",
						timestamp: 2,
						payload: decision,
					},
				],
				graphWriter,
				{ deferDecisionPredecessors: true },
			),
		).rejects.toThrow(
			"payload organization does not match its canonical event envelope",
		);

		await expect(
			processProjectionBatch(
				[
					{
						op: "upsert_decision",
						id: "decision-other",
						orgId: decision.orgId,
						timestamp: 3,
						payload: decision,
					},
				],
				graphWriter,
				{ deferDecisionPredecessors: true },
			),
		).rejects.toThrow(
			"payload identity does not match its canonical event envelope",
		);
		expect(upsertDecisionContexts).toHaveBeenCalledTimes(1);
	});

	it("rejects an edge identity that disagrees with its canonical envelope", async () => {
		const upsertEdge = vi.fn<GraphWriter["upsertEdge"]>();
		await expect(
			processSyncEvent(
				{
					op: "upsert_edge",
					id: "edge-1",
					orgId: "org-1",
					timestamp: 1,
					payload: {
						id: "edge-2",
						orgId: "org-1",
						sourceFactId: "source",
						targetFactId: "target",
						relationType: "related_to",
						strength: 0.8,
						context: null,
						updatedAt: null,
					},
				},
				writer({ upsertEdge }),
			),
		).rejects.toThrow(
			"payload identity does not match its canonical event envelope",
		);
		expect(upsertEdge).not.toHaveBeenCalled();
	});

	it("supplies canonical tenant scope to capability-link tombstones", async () => {
		const deleteCapabilityLink = vi.fn<GraphWriter["deleteCapabilityLink"]>();
		await processSyncEvent(
			{
				op: "delete_capability_link",
				id: "link-1",
				orgId: "org-1",
				timestamp: 1,
				payload: {
					capabilityId: "capability-1",
					entityKind: "skill",
					entityId: "skill-1",
				} as SyncEvent["payload"],
			},
			writer({ deleteCapabilityLink }),
		);

		expect(deleteCapabilityLink).toHaveBeenCalledWith({
			capabilityId: "capability-1",
			entityKind: "skill",
			entityId: "skill-1",
			orgId: "org-1",
		});
	});

	it("forwards the canonical validity cutoff on resolution revocation", async () => {
		const revokeEntityResolution =
			vi.fn<GraphWriter["revokeEntityResolution"]>();
		const validTo = "2026-07-27T04:05:06.000Z";
		await processSyncEvent(
			{
				op: "revoke_entity_resolution",
				id: "resolution-1",
				orgId: "org-1",
				timestamp: 1,
				payload: { validTo },
			},
			writer({ revokeEntityResolution }),
		);

		expect(revokeEntityResolution).toHaveBeenCalledWith(
			"resolution-1",
			"org-1",
			validTo,
		);
	});

	it("rejects resolution revocation without a canonical validity cutoff", async () => {
		const revokeEntityResolution =
			vi.fn<GraphWriter["revokeEntityResolution"]>();

		await expect(
			processSyncEvent(
				{
					op: "revoke_entity_resolution",
					id: "resolution-1",
					orgId: "org-1",
					timestamp: 1,
				},
				writer({ revokeEntityResolution }),
			),
		).rejects.toThrow("requires a canonical validity tombstone");
		expect(revokeEntityResolution).not.toHaveBeenCalled();
	});

	it("orders node upserts, relationship tombstones, relationship upserts, then node deletes", async () => {
		const calls: string[] = [];
		const upsertFacts = vi.fn(async () => {
			calls.push("upsertFacts");
		});
		const upsertDecisions = vi.fn(async () => {
			calls.push("upsertDecisions");
		});
		const deleteEdge = vi.fn(async () => {
			calls.push("deleteEdge");
		});
		const revokeEntityResolution = vi.fn(async () => {
			calls.push("revokeEntityResolution");
		});
		const upsertEdges = vi.fn(async () => {
			calls.push("upsertEdges");
		});
		const upsertEntityResolution = vi.fn(async () => {
			calls.push("upsertEntityResolution");
		});
		const deleteFact = vi.fn(async () => {
			calls.push("deleteFact");
		});
		const decision = {
			id: "decision-1",
			orgId: "org-1",
			tediId: "tedi-1",
			action: "ship",
			rationale: "evidence",
			category: "test",
			confidence: 1,
			outcomeStatus: "success",
			evidence: "[]",
			objectiveId: null,
			approvalRequestId: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			completedAt: null,
		} as const;
		const projectedEdge = {
			id: "edge-1",
			orgId: "org-1",
			sourceFactId: "source",
			targetFactId: "target-new",
			relationType: "related_to",
			strength: 1,
			context: null,
			updatedAt: null,
		} as const;

		await processProjectionBatch(
			[
				{
					op: "delete_fact",
					id: "old-fact",
					orgId: "org-1",
					timestamp: 1,
				},
				{
					op: "upsert_edge",
					id: "edge-1",
					orgId: "org-1",
					timestamp: 2,
					payload: projectedEdge,
				},
				{
					op: "revoke_entity_resolution",
					id: "resolution-1",
					orgId: "org-1",
					timestamp: 3,
					payload: { validTo: "2026-07-27T01:00:00.000Z" },
				},
				{
					op: "upsert_fact",
					id: "fact-1",
					orgId: "org-1",
					timestamp: 4,
					payload: fact("fact-1"),
				},
				{
					op: "upsert_decision",
					id: "decision-1",
					orgId: "org-1",
					timestamp: 5,
					payload: decision,
				},
				{
					op: "delete_edge",
					id: "edge-1:old",
					orgId: "org-1",
					timestamp: 6,
					payload: {
						...projectedEdge,
						id: "edge-1:old",
						targetFactId: "target-old",
					},
				},
				{
					op: "upsert_entity_resolution",
					id: "resolution-1",
					orgId: "org-1",
					timestamp: 7,
					payload: {
						id: "resolution-1",
						orgId: "org-1",
						mentionId: "mention-1",
						factId: null,
						entityId: "entity-1",
						decisionId: null,
						confidence: 0.9,
						validFrom: "2026-07-27T00:00:00.000Z",
						validTo: null,
						status: "active",
					},
				},
			],
			writer({
				upsertFacts,
				upsertDecisions,
				deleteEdge,
				revokeEntityResolution,
				upsertEdges,
				upsertEntityResolution,
				deleteFact,
			}),
		);

		expect(calls).toEqual([
			"upsertFacts",
			"upsertDecisions",
			"revokeEntityResolution",
			"deleteEdge",
			"upsertEdges",
			"upsertEntityResolution",
			"deleteFact",
		]);
	});

	it("cannot let an old-tuple tombstone delete the final relationship upsert", async () => {
		const relationships = new Set<string>();
		const key = (target: string) => `source:${target}:related_to`;
		const oldEdge = {
			id: "edge-1:old",
			orgId: "org-1",
			sourceFactId: "source",
			targetFactId: "old-target",
			relationType: "related_to" as const,
			strength: 1,
			context: null,
			updatedAt: null,
		};
		const replacement = {
			...oldEdge,
			id: "edge-1",
			targetFactId: "new-target",
		};
		relationships.add(key("old-target"));

		await processProjectionBatch(
			[
				{
					op: "upsert_edge",
					id: replacement.id,
					orgId: "org-1",
					timestamp: 2,
					payload: replacement,
				},
				{
					op: "delete_edge",
					id: oldEdge.id,
					orgId: "org-1",
					timestamp: 1,
					payload: oldEdge,
				},
			],
			writer({
				deleteEdge: async (_source, target) => {
					relationships.delete(key(target));
				},
				upsertEdges: async (edges) => {
					for (const item of edges) {
						relationships.add(key(item.targetFactId));
					}
				},
			}),
		);

		expect([...relationships]).toEqual([key("new-target")]);
	});
});
