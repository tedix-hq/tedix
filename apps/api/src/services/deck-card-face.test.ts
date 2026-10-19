import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import type { BaseContext } from "../rpc/orpc";
const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	put: vi.fn(),
	save: vi.fn(),
	generate: vi.fn(),
	preferences: vi.fn(),
}));
vi.mock("@tedix/db/queries/user-configs", () => ({
	getUserConfig: mocks.get,
	putUserConfig: mocks.put,
}));
vi.mock("@tedix/db/queries/work-items/card-presentation", () => ({
	saveDecisionCardPresentation: mocks.save,
}));
vi.mock("./decision-card-generator", () => ({
	generateDecisionCard: mocks.generate,
}));
vi.mock("./decision-learning", () => ({
	readDraftPreferences: mocks.preferences,
}));
import {
	prepareDeckCardFace,
	deckCardWritingSource,
	displayDeckCard,
} from "./deck-card-face";
const context = {
	organizationId: "fictional-org",
	userId: "fictional-person",
	descopeUserId: "fictional-person",
	db: {},
} as BaseContext;
const card: DeckCard = {
	id: "factory:fictional:0",
	kind: "decision",
	label: "Is this news summary useful?",
	project: "fictional-project",
	urgency: "later",
	source: "/work",
	requestedAt: "2026-10-19T00:00:00Z",
	dueAt: null,
	score: 0,
	decision: null,
	factory: {
		outputId: "10000000-0000-4000-8000-000000000001",
		sourceIndex: 0,
		rowIndex: 0,
		revision: 1,
		draft: "",
		why: "Your workshop news summary is ready for review.",
		sourceText: "Workshop notes",
	},
};
const copy = {
	version: 2,
	title: "Is this news summary useful?",
	context: "Your workshop news is ready for review.",
	body: "Records whether the suggestion helped; changes nothing outside Tedix.",
	recommendation: "Review first: usefulness depends on your workshop plans.",
	actionLabels: { approve: "Useful", reject: "Not useful" },
};
const store = new Map<
	string,
	{ revision: number; value: Record<string, unknown> }
>();
const key = (input: { userId: string; namespace: string; key: string }) =>
	JSON.stringify([input.userId, input.namespace, input.key]);
beforeEach(() => {
	vi.clearAllMocks();
	store.clear();
	mocks.preferences.mockResolvedValue("");
	mocks.generate.mockResolvedValue(copy);
	mocks.get.mockImplementation(
		async (_db, input) => store.get(key(input)) ?? null,
	);
	mocks.put.mockImplementation(async (_db, input) => {
		const old = store.get(key(input));
		if ((old?.revision ?? 0) !== input.expectedRevision) return { ok: false };
		const row = { revision: (old?.revision ?? 0) + 1, value: input.value };
		store.set(key(input), row);
		return { ok: true, row };
	});
	mocks.save.mockImplementation(async (_db, input) => ({
		presentation: input.presentation,
	}));
});
it("reuses checked display copy, isolates people and organizations, and invalidates changed writing preferences", async () => {
	expect(await prepareDeckCardFace(context, card)).toEqual(copy);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	expect(
		await prepareDeckCardFace(
			{ ...context, userId: "fictional-other" },
			card,
			false,
		),
	).toBeNull();
	expect(
		await prepareDeckCardFace(
			{ ...context, organizationId: "fictional-other-org" },
			card,
			false,
		),
	).toBeNull();
	mocks.preferences.mockResolvedValue("Say where we met.");
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
	await prepareDeckCardFace(context, card);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
});
it("claims generation once when two tabs ask for the same card", async () => {
	const results = await Promise.all([
		prepareDeckCardFace(context, card),
		prepareDeckCardFace(context, card),
	]);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	expect(results.filter(Boolean)).toContainEqual(copy);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
});
it("withholds failed readability output from every display and fallback", async () => {
	mocks.generate.mockResolvedValue({
		...copy,
		context: "The MCP gateway needs a credential.",
	});
	expect(await prepareDeckCardFace(context, card)).toBeNull();
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
	expect(displayDeckCard(card, null)).toMatchObject({
		label: "Review this request?",
		faceText: "Preparing a shorter summary. Open Details to review the source.",
	});
});
it("tells the writer the actual factory consequence rather than promising to do the suggested work", () => {
	const source = deckCardWritingSource(card);
	expect(source.metadata.producerContext).toContain(
		"do not execute the suggestion",
	);
	expect(source.prompt).toContain(card.factory!.why);
});

it("withholds source secrets before generation and secret-bearing cached output", async () => {
	const secret = "sk-" + "fictional".repeat(5);
	expect(
		await prepareDeckCardFace(context, {
			...card,
			factory: { ...card.factory!, draft: secret },
		}),
	).toBeNull();
	expect(mocks.generate).not.toHaveBeenCalled();
	mocks.generate.mockResolvedValue({ ...copy, context: secret });
	expect(await prepareDeckCardFace(context, card)).toBeNull();
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
});
