import { describe, expect, it, vi } from "vite-plus/test";
import { type GraphWriter, processProjectionBatch } from "./sync";
import type { GraphDecisionEdge, SyncEvent } from "./types";

const edge = (id: string, kind: GraphDecisionEdge["kind"]) =>
	({
		id,
		orgId: "org-1",
		kind,
		fromKind: "work_item",
		fromId: `${id}-from`,
		toKind: "work_item",
		toId: `${id}-to`,
		confidence: 1,
		note: null,
		occurredAt: "2026-10-21T08:00:00.000Z",
	}) satisfies GraphDecisionEdge;

const event = (
	op: "upsert_decision_graph_edge" | "delete_decision_graph_edge",
	payload: GraphDecisionEdge,
): SyncEvent => ({
	op,
	id: payload.id,
	orgId: payload.orgId,
	timestamp: 0,
	payload,
});

describe("decision graph projection batches", () => {
	it("deletes before upserting, each in one batched writer call", async () => {
		const calls: string[] = [];
		const writer = {
			upsertDecisionGraphEdges: vi.fn(async (edges: GraphDecisionEdge[]) => {
				calls.push(`upsert:${edges.map((item) => item.id).join(",")}`);
			}),
			deleteDecisionGraphEdges: vi.fn(async (edges: GraphDecisionEdge[]) => {
				calls.push(`delete:${edges.map((item) => item.id).join(",")}`);
			}),
		} as unknown as GraphWriter;

		await processProjectionBatch(
			[
				event("upsert_decision_graph_edge", edge("e1", "blocks")),
				event("delete_decision_graph_edge", edge("e0", "same_as")),
				event("upsert_decision_graph_edge", edge("e2", "same_as")),
			],
			writer,
		);

		expect(calls).toEqual(["delete:e0", "upsert:e1,e2"]);
	});

	it("fails loudly for a writer without decision graph support", async () => {
		await expect(
			processProjectionBatch(
				[event("upsert_decision_graph_edge", edge("e1", "blocks"))],
				{} as GraphWriter,
			),
		).rejects.toThrow("does not support upsertDecisionGraphEdges");
	});

	it("rejects an edge payload from another organization", async () => {
		const writer = {
			upsertDecisionGraphEdges: vi.fn(),
		} as unknown as GraphWriter;
		await expect(
			processProjectionBatch(
				[
					{
						...event("upsert_decision_graph_edge", edge("e1", "blocks")),
						orgId: "org-2",
					},
				],
				writer,
			),
		).rejects.toThrow("organization does not match");
	});
});
