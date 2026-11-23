import { expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { deckQualificationGraph } from "./deck-qualification-graph";

const mocks = vi.hoisted(() => ({ contexts: vi.fn() }));
vi.mock("@tedix/db/queries/decision-graph", () => ({
	getDeckDecisionContexts: mocks.contexts,
}));

it("enriches the grouped D1 snapshot with graph reach and duplicates", async () => {
	const db = {} as DbClient;
	const cards = [{ id: "ask", workItemId: "source" }];
	mocks.contexts.mockResolvedValue(
		new Map([
			[
				"ask",
				{
					cardId: "ask",
					chain: [],
					duplicates: ["original"],
					blocksCount: 2,
				},
			],
		]),
	);
	const facts = await deckQualificationGraph(db, "orchard", cards, {
		blocksReach: async () => new Map([["ask", 5]]),
		duplicateCommunities: async () => new Map([["ask", ["reminder"]]]),
	});
	expect(mocks.contexts).toHaveBeenCalledExactlyOnceWith(db, "orchard", cards);
	expect(facts.get("ask")).toMatchObject({
		blocksCount: 2,
		blocksReach: 5,
		duplicates: ["original", "reminder"],
	});
});
