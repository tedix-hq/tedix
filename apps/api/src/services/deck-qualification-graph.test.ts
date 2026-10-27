import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { deckQualificationGraph } from "./deck-qualification-graph";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	prior: vi.fn(),
	blocked: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-graph", () => ({
	getDecisionContext: mocks.context,
	findPriorDecision: mocks.prior,
	countBlocked: mocks.blocked,
}));
const db = {} as DbClient;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.context.mockImplementation(async (_db, _org, cardId) => ({
		cardId,
		chain: [],
		duplicates: [],
		blocksCount: 0,
	}));
	mocks.blocked.mockResolvedValue(2);
	mocks.prior.mockResolvedValue({
		node: { kind: "decision", id: "answered" },
		edge: { evidenceRef: "owner-response:answered" },
	});
});
it("does not spread a Work answer to five separate recipient asks", async () => {
	const cards = Array.from({ length: 5 }, (_, i) => ({
		id: `recipient-${i}`,
		workItemId: "shared-outreach",
	}));
	const facts = await deckQualificationGraph(db, "orchard", cards);
	expect(mocks.prior).not.toHaveBeenCalled();
	expect([...facts.values()].map((c) => c.priorDecision)).toEqual(
		Array(5).fill(undefined),
	);
	expect([...facts.values()].map((c) => c.blocksCount)).toEqual(
		Array(5).fill(2),
	);
});
it("inherits an answer only through explicit duplicate identity", async () => {
	mocks.context.mockResolvedValue({
		cardId: "reminder",
		chain: [],
		duplicates: ["original"],
		blocksCount: 0,
	});
	const facts = await deckQualificationGraph(db, "orchard", [
		{ id: "reminder", workItemId: "shared-outreach" },
	]);
	expect(mocks.prior).toHaveBeenCalledExactlyOnceWith(db, "orchard", [
		"reminder",
		"original",
	]);
	expect(facts.get("reminder")?.priorDecision?.node.id).toBe("answered");
});
