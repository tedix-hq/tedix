import type { DecisionContext } from "@tedix/api-contract/schemas/decision-graph";
import { compareDecisionFreshness } from "@tedix/api-contract/utils/deck-projection";
import { explainChain } from "@tedix/db/queries/decision-graph";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDecisionGraphReaderFrom,
	enrichDecisionContexts,
} from "./decision-graph-reads";

const now = new Date("2026-10-21T20:00:00.000Z");

function context(cardId: string, blocksCount: number): DecisionContext {
	return { cardId, chain: [], duplicates: [], blocksCount };
}

/**
 * Fixture: card A's Work blocks one item, which blocks three more; card B's
 * Work blocks two items directly. D1 counts direct edges only (A=1, B=2);
 * the graph walks the chain (A reaches 4, B reaches 2).
 */
function fixtureGraph() {
	const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
		expect(params.orgId).toBe("org-1");
		if (query.includes("DG_BLOCKS")) {
			return [
				{ cardId: "card-a", reach: 4 },
				{ cardId: "card-b", reach: 2 },
			];
		}
		return [
			{ cardId: "card-a", duplicates: ["card-c"] },
			{ cardId: "card-b", duplicates: [] },
		];
	});
	return { run, reader: createDecisionGraphReaderFrom(run) };
}

function rank(contexts: Map<string, DecisionContext>) {
	const cards = [...contexts.values()].map((facts) => ({
		id: facts.cardId,
		actionable: true,
		requestedAt: "2026-10-21T08:00:00.000Z",
		blocksCount: facts.blocksCount,
		...(facts.blocksReach === undefined
			? {}
			: { blocksScore: facts.blocksReach }),
	}));
	return cards
		.sort((a, b) => compareDecisionFreshness(a, b, now))
		.map((card) => card.id);
}

describe("graph-backed Deck ranking", () => {
	it("moves the card that blocks the most work to the top", async () => {
		const d1Only = new Map([
			["card-a", context("card-a", 1)],
			["card-b", context("card-b", 2)],
		]);
		expect(rank(d1Only)).toEqual(["card-b", "card-a"]);

		const { run, reader } = fixtureGraph();
		const withGraph = new Map([
			["card-a", context("card-a", 1)],
			["card-b", context("card-b", 2)],
		]);
		await enrichDecisionContexts(
			reader,
			"org-1",
			[{ id: "card-a", workItemId: "work-a" }, { id: "card-b" }],
			withGraph,
		);

		expect(rank(withGraph)).toEqual(["card-a", "card-b"]);
		expect(withGraph.get("card-a")).toMatchObject({
			blocksReach: 4,
			duplicates: ["card-c"],
		});
		expect(explainChain(withGraph.get("card-a")!)).toBe(
			"Same as 1 other card → 4 items wait on this (1 directly)",
		);
		const blocksCall = run.mock.calls.find(([query]) =>
			query.includes("DG_BLOCKS"),
		);
		expect(blocksCall?.[1].cards).toEqual([
			{ id: "card-a", keys: ["deck_card:card-a", "work_item:work-a"] },
			{ id: "card-b", keys: ["deck_card:card-b"] },
		]);
	});

	it("keeps the D1 answer when the graph is not configured or fails", async () => {
		const contexts = new Map([
			["card-a", context("card-a", 1)],
			["card-b", context("card-b", 2)],
		]);
		await enrichDecisionContexts(null, "org-1", [{ id: "card-a" }], contexts);
		expect(contexts.get("card-a")?.blocksReach).toBeUndefined();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = createDecisionGraphReaderFrom(async () => {
			throw new Error("graph unreachable");
		});
		await enrichDecisionContexts(
			failing,
			"org-1",
			[{ id: "card-a" }, { id: "card-b" }],
			contexts,
		);
		expect(rank(contexts)).toEqual(["card-b", "card-a"]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("skips walks through Work that D1 records as cancelled", async () => {
		// The graph still counts both items (its WorkItem nodes lack the
		// cancellation); D1 says the first link of the chain was cancelled.
		const run = vi.fn(async () => [
			{
				cardId: "card-a",
				reach: 2,
				paths: [
					["deck_card:card-a", "work_item:cancelled-1"],
					["deck_card:card-a", "work_item:cancelled-1", "work_item:open-2"],
				],
			},
			{
				cardId: "card-b",
				reach: 1,
				paths: [["work_item:work-b", "work_item:open-3"]],
			},
		]);
		const terminal = vi.fn(async (_org: string, ids: readonly string[]) => {
			expect([...ids].sort()).toEqual(
				["cancelled-1", "cancelled-1", "open-2", "open-3", "work-b"].sort(),
			);
			return new Set(["cancelled-1"]);
		});
		const reader = createDecisionGraphReaderFrom(run, 1_000, terminal);
		const reach = await reader.blocksReach("org-1", [
			{ id: "card-a" },
			{ id: "card-b", workItemId: "work-b" },
		]);
		expect(reach.get("card-a")).toBe(0);
		expect(reach.get("card-b")).toBe(1);
		expect(terminal).toHaveBeenCalledTimes(1);

		const contexts = new Map([["card-a", context("card-a", 0)]]);
		await enrichDecisionContexts(reader, "org-1", [{ id: "card-a" }], contexts);
		expect(explainChain(contexts.get("card-a")!)).not.toContain("wait on this");
	});

	it("gives up on a slow graph read", async () => {
		const slow = createDecisionGraphReaderFrom(() => new Promise(() => {}), 10);
		await expect(slow.blocksReach("org-1", [{ id: "card-a" }])).rejects.toThrow(
			"timed out",
		);
	});
});
