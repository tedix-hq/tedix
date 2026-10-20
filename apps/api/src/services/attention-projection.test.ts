import { beforeEach, expect, it, vi } from "vite-plus/test";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { DEFAULT_DECK_ROUTING } from "@tedix/api-contract/schemas/os-decision-deck";
import type { BaseContext } from "../rpc/orpc";
import {
	loadDeckProjection,
	loadForYouProjection,
} from "./attention-projection";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@orpc/server", async (original) => ({
	...(await original<Record<string, unknown>>()),
	call: mocks.call,
}));
vi.mock("../rpc/routers/os-workspaces", () => ({
	osWorkspacesContractRouter: {
		gadgets: { workApps: "apps" },
		workspaces: { list: "spaces" },
		outputs: { list: "outputs", get: "output" },
	},
}));
vi.mock("../rpc/routers/work-interactions", () => ({
	workInteractionsContractRouter: { listInbox: "inbox" },
}));
vi.mock("../rpc/routers/work-approvals", () => ({
	workApprovalsContractRouter: { listInbox: "work" },
}));
vi.mock("../rpc/routers/tedi-approvals", () => ({
	tediApprovalsContractRouter: { list: "runtime" },
}));
vi.mock("../rpc/routers/learning-feedback", () => ({
	learningFeedbackContractRouter: {
		model: "model",
		listInteractions: "history",
	},
}));
vi.mock("../rpc/routers/user-settings", () => ({
	userSettingsContractRouter: { getPreferences: "preferences" },
}));
vi.mock("../rpc/routers/work-items", () => ({
	workItemsContractRouter: {
		listActivity: "activity",
		listAttemptProjection: "attempts",
	},
}));
const workspaceId = "11111111-1111-4111-8111-111111111111";
const outputId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const source = {
	label: "Inbox",
	workspaceId,
	cardSheetPrefix: "Cards",
	maxRuns: 1,
	doIt: "approve",
	columns: {
		type: "Type",
		source: "Source",
		why: "Why",
		useful: "Useful",
		reason: "Reason",
		done: "Done",
	},
};
const context = {} as BaseContext;
let model: ReturnType<typeof learnDecisions>;
let routing = DEFAULT_DECK_ROUTING;
beforeEach(() => {
	vi.clearAllMocks();
	routing = DEFAULT_DECK_ROUTING;
	model = learnDecisions({
		organizationId: "fictional-orchard",
		personId: "river",
		events: [],
		config: DecisionLearningConfigSchema.parse({ enabled: true }),
		now: new Date(),
	});
	model.weights.personal.push({
		key: "source:decision_capture",
		value: 2,
		examples: 3,
		evidenceIds: ["choice"],
	});
	mocks.call.mockImplementation(async (procedure: string) => {
		switch (procedure) {
			case "apps":
				return {
					truncated: false,
					items: [
						{
							gadget: { id: "deck" },
							currentRevision: {
								manifest: {
									navigation: { work: "deck" },
									config: { version: 1, factorySources: [source], routing },
								},
							},
						},
						{
							gadget: { id: "feed" },
							currentRevision: {
								manifest: {
									navigation: { work: "feed" },
									config: {
										version: 1,
										scope: "organization",
										projects: [],
										factorySources: [{ projectId, source }],
									},
								},
							},
						},
					],
				};
			case "spaces":
				return { items: [{ id: workspaceId }], truncated: false };
			case "outputs":
				return {
					items: [
						{
							id: outputId,
							title: "Cards today",
							kind: "sheet",
							status: "active",
							createdAt: new Date().toISOString(),
						},
					],
					truncated: false,
				};
			case "output":
				return {
					currentRevision: {
						revision: 1,
						content: {
							kind: "sheet",
							columns: ["Type", "Source", "Why", "Useful", "Reason", "Done"],
							rows: [
								[
									"opportunity",
									"An introduction",
									"Worth a conversation",
									"",
									"",
									"",
								],
								["routine", "Routine filing", "Routine cleanup", "", "", ""],
								["lead", "Finished lead", "Already handled", "yes", "", "yes"],
							],
						},
					},
				};
			case "preferences":
				return { preferences: { timezone: "UTC" } };
			case "model":
				return model;
			case "inbox":
			case "work":
				return { data: [], nextCursor: null, hasMore: false };
			case "runtime":
				return { data: [], pagination: { hasMore: false } };
			case "history":
				return { events: [] };
			case "activity":
				return { events: [], truncated: false };
			case "attempts":
				return { data: [], hasMore: false };
			default:
				throw new Error(`Unexpected ${procedure}`);
		}
	});
});
it("gates factory Deck cards with the shared policy while Feed retains withheld and handled rows", async () => {
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards.map((card) => card.id)).toEqual([`factory:${outputId}:0`]);
	expect(deck.cards[0]?.score).toBeGreaterThan(0);
	expect(deck.complete).toBe(true);
	const feed = await loadForYouProjection(context, { limit: 100 });
	expect(feed.items.map((item) => item.id)).toEqual(
		expect.arrayContaining([
			`factory:${outputId}:0`,
			`factory:${outputId}:1`,
			`factory:${outputId}:2`,
		]),
	);
});
it("retains the routing policy's critical classification on factory snapshots", async () => {
	routing = {
		...DEFAULT_DECK_ROUTING,
		criticalClasses: ["opportunity"],
	};
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards[0]?.factory?.policyCritical).toBe(true);
});

it("uses learned factory usefulness and an explicit routing policy without mutating source rows", async () => {
	model.weights.usefulness.push({
		key: "class:factory:Inbox:opportunity",
		value: -3,
		examples: 4,
		evidenceIds: ["less-like-this"],
	});
	expect((await loadDeckProjection(context, { limit: 100 })).count).toBe(0);
	routing = {
		...DEFAULT_DECK_ROUTING,
		feedClasses: [],
		valuableClasses: ["routine"],
	};
	expect(
		(await loadDeckProjection(context, { limit: 100 })).cards.map(
			(card) => card.id,
		),
	).toEqual([`factory:${outputId}:1`]);
	const feed = await loadForYouProjection(context, { limit: 100 });
	expect(feed.items.some((item) => item.id === `factory:${outputId}:0`)).toBe(
		true,
	);
});

it("keeps Feed decisions independent of saved Deck projects, routing and app ambiguity", async () => {
	const implementation = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(async (procedure: string, input: unknown) => {
		const result = await implementation(procedure, input);
		if (procedure !== "apps") return result;
		const deck = result.items[0];
		deck.currentRevision.manifest.config = {
			version: 1,
			projectId,
			routing: { ...DEFAULT_DECK_ROUTING, valuableClasses: ["routine"] },
		};
		return {
			...result,
			items: [
				deck,
				{ ...deck, gadget: { id: "another-deck" } },
				result.items[1],
			],
		};
	});
	const feed = await loadForYouProjection(context, {
		gadgetId: "feed",
		limit: 100,
	});
	expect(feed.complete).toBe(true);
	expect(mocks.call).toHaveBeenCalledWith(
		"inbox",
		expect.objectContaining({ projectId: undefined, states: ["open"] }),
		{ context },
	);
	expect(mocks.call).toHaveBeenCalledWith("runtime", expect.anything(), {
		context,
	});
	expect(
		mocks.call.mock.calls.filter(([procedure]) => procedure === "apps"),
	).toHaveLength(1);
});
it("counts every visible configured factory source in a project Deck just as the OS does", async () => {
	const deck = await loadDeckProjection(context, { projectId, limit: 100 });
	expect(deck.complete).toBe(true);
	expect(deck.count).toBe(1);
	expect(deck.cards[0]).toMatchObject({
		id: `factory:${outputId}:0`,
		project: "Unfiled",
	});
});
