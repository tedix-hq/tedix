import { beforeEach, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import { attentionContractRouter } from "../rpc/routers/attention";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { DEFAULT_DECK_ROUTING } from "@tedix/api-contract/schemas/os-decision-deck";
import { CARD_REVIEW_ENTRY } from "@tedix/api-contract/schemas/os-card-review";
import type { BaseContext } from "../rpc/orpc";
import {
	loadDeckProjection,
	loadForYouProjection,
} from "./attention-projection";
const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	graph: vi.fn(),
	states: vi.fn(),
	sourceApps: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	listCardSourceApps: mocks.sourceApps,
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: vi.fn(async () => ({
		id: "writing-skill",
		tediId: "writing-agent",
	})),
}));
vi.mock("./learning-interaction-recorder", async (original) => ({
	...(await original<Record<string, unknown>>()),
	recordObservedLearningInteraction: vi.fn(),
}));
vi.mock("../rpc/routers/kernel-runtime", () => ({
	kernelRuntimeContractRouter: { enqueueMessage: "rewrite" },
}));
vi.mock("@orpc/server", async (original) => ({
	...(await original<Record<string, unknown>>()),
	call: mocks.call,
}));
vi.mock("../rpc/routers/os-workspaces", () => ({
	osWorkspacesContractRouter: {
		gadgets: { workApps: "apps" },
		workspaces: { list: "spaces" },
		outputs: { list: "outputs", get: "output" },
		schedules: { list: "schedules" },
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
	resolveLearningActor: () => ({ actorType: "user", actorId: "river" }),
}));
vi.mock("../rpc/routers/user-settings", () => ({
	userSettingsContractRouter: { getPreferences: "preferences" },
}));
vi.mock("./internal-decision-feed", () => ({
	internalDecisionFeed: vi.fn(async () => []),
}));
vi.mock("./deck-pipeline-status", () => ({
	loadDeckPipelineStatus: vi.fn(async () => undefined),
}));
vi.mock("../rpc/routers/work-items", () => ({
	workItemsContractRouter: {
		listActivity: "activity",
		listAttemptProjection: "attempts",
	},
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: vi.fn(async () =>
		DecisionLearningConfigSchema.parse({}),
	),
}));
vi.mock("./deck-qualification-graph", () => ({
	deckQualificationGraph: mocks.graph,
}));
vi.mock("@tedix/db/queries/work-items/deck-sweep", () => ({
	listDeckSourceStates: mocks.states,
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
		score: "Score",
	},
};
const context = { organizationId: "fictional-orchard" } as BaseContext;
function installReviewSources(sources: unknown[], deckSources: unknown[] = []) {
	const base = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(
		async (procedure: string, ...rest: unknown[]) => {
			const result = await base(procedure, ...rest);
			if (procedure === "apps") {
				result.items[0].currentRevision.manifest.config.factorySources =
					deckSources;
				result.items.push({
					gadget: { id: "review" },
					currentRevision: {
						manifest: {
							entry: CARD_REVIEW_ENTRY,
							config: { version: 1, sources },
						},
					},
				});
			}
			return result;
		},
	);
}

it("discovers Card review sources and returns the source used to decide each card", async () => {
	installReviewSources([source], [{ ...source, cardSheetPrefix: "Other" }]);
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards.map((card) => card.id)).toEqual([`factory:${outputId}:0`]);
	expect(deck.cards[0]!.factory!.sourceIndex).toBe(1);
	expect(
		deck.config.factorySources[deck.cards[0]!.factory!.sourceIndex],
	).toMatchObject(source);
});

it("requests changes through the router for a discovered card using its merged source", async () => {
	installReviewSources(
		[
			{
				...source,
				columns: { ...source.columns, draft: "Draft" },
				doIt: "run_skill",
				run: { skillId: "44444444-4444-4444-8444-444444444444" },
			},
		],
		[{ ...source, cardSheetPrefix: "Other" }],
	);
	const base = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(
		async (procedure: string, ...rest: unknown[]) => {
			if (procedure === "schedules")
				return { items: [{ skillId: "44444444-4444-4444-8444-444444444444" }] };
			if (procedure === "rewrite")
				return { status: "running", run: { id: "rewrite-run" } };
			const result = await base(procedure, ...rest);
			if (procedure === "output")
				result.output = {
					title: "Cards today",
					createdAt: new Date().toISOString(),
				};
			return result;
		},
	);
	const client = createRouterClient(attentionContractRouter, {
		context: {
			...context,
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			authType: "apikey",
			apiKey: { id: "key", scopes: ["mcp:messaging.write"] },
		} as BaseContext,
	});
	await expect(
		client.decideDeckCard({
			decision: {
				kind: "factory_changes",
				cardId: `factory:${outputId}:0`,
				expectedRevision: 1,
				instruction: "Make the draft clearer",
			},
		}),
	).resolves.toEqual({ saved: true, cardId: `factory:${outputId}:0` });
	expect(mocks.call).toHaveBeenCalledWith(
		"rewrite",
		expect.objectContaining({
			delegateToTediId: "writing-agent",
			workspaceContext: {
				workspaceId,
				workpiece: { kind: "output", id: outputId },
			},
		}),
		expect.anything(),
	);
});

it.each([true, false])(
	"respects app workspace visibility without board navigation: %s",
	async (visible) => {
		installReviewSources([]);
		mocks.sourceApps.mockResolvedValue([
			{
				gadget: {
					id: "standalone",
					workspaceId: visible ? workspaceId : projectId,
				},
				revision: {
					manifest: JSON.stringify({
						entry: CARD_REVIEW_ENTRY,
						config: { version: 1, sources: [source] },
					}),
				},
			},
		]);
		const deck = await loadDeckProjection(context, { limit: 100 });
		expect(deck.cards.map((card) => card.id)).toEqual(
			visible ? [`factory:${outputId}:0`] : [],
		);
	},
);

it("rejects an incomplete Card review app inventory", async () => {
	mocks.sourceApps.mockResolvedValue(Array.from({ length: 201 }, () => ({})));
	await expect(loadDeckProjection(context, { limit: 100 })).rejects.toThrow(
		"inventory is incomplete",
	);
});

it("deduplicates configured and discovered sources and overlapping sheets", async () => {
	installReviewSources(
		[source, { ...source, cardSheetPrefix: "Card" }],
		[source],
	);
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.config.factorySources).toHaveLength(2);
	expect(deck.cards.map((card) => card.id)).toEqual([`factory:${outputId}:0`]);
	expect(
		mocks.call.mock.calls.filter(([procedure]) => procedure === "output"),
	).toHaveLength(1);
});

it("does not read discovered sources from workspaces hidden from this viewer", async () => {
	installReviewSources([{ ...source, workspaceId: projectId }]);
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards).toEqual([]);
	expect(
		mocks.call.mock.calls.some(([procedure]) => procedure === "outputs"),
	).toBe(false);
});

it("fails explicitly instead of dropping discovered sources above the ten-source bound", async () => {
	installReviewSources(
		Array.from({ length: 10 }, (_, i) => ({
			...source,
			cardSheetPrefix: `Cards ${i}`,
		})),
		[source],
	);
	await expect(loadDeckProjection(context, { limit: 100 })).rejects.toThrow(
		"10",
	);
});

let model: ReturnType<typeof learnDecisions>;
let routing = DEFAULT_DECK_ROUTING;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.sourceApps.mockResolvedValue([]);
	mocks.graph.mockResolvedValue(new Map());
	mocks.states.mockResolvedValue(new Map());
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
it("orders factory Deck cards by the factory's own score and carries it on the card", async () => {
	const base = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(
		async (procedure: string, ...rest: unknown[]) =>
			procedure === "output"
				? {
						currentRevision: {
							revision: 1,
							content: {
								kind: "sheet",
								columns: [
									"Type",
									"Source",
									"Why",
									"Score",
									"Useful",
									"Reason",
									"Done",
								],
								rows: [
									["opportunity", "First intro", "Fits", "0.3", "", "", ""],
									[
										"opportunity",
										"Second intro",
										"Fits well",
										"0.9",
										"",
										"",
										"",
									],
								],
							},
						},
					}
				: base(procedure, ...rest),
	);
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards.map((card) => [card.id, card.factory?.score])).toEqual([
		[`factory:${outputId}:1`, 0.9],
		[`factory:${outputId}:0`, 0.3],
	]);
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

it("shows feed-routed questions and approvals as updates, not Needs-you", async () => {
	const implementation = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(async (procedure: string, input: unknown) => {
		if (procedure === "spaces") return { items: [], truncated: false };
		if (procedure === "inbox")
			return {
				data: [
					{
						request: {
							id: "fictional-question",
							kind: "question",
							metadata: {},
							subject: "Which supplier?",
							prompt: "Choose Cedar or Pine.",
							projectId: null,
							workItemId: null,
							requestedAt: new Date().toISOString(),
							dueAt: null,
						},
						effectiveState: "open",
						canRespond: true,
						askedBy: "Orchard helper",
					},
				],
				nextCursor: null,
				hasMore: false,
			};
		if (procedure === "work")
			return {
				data: [
					{
						proposal: {
							id: "fictional-approval",
							action: "run_workflow",
							authorityKey: "run_workflow",
							requestRationale: "Prepare inventory?",
							requestedAt: new Date().toISOString(),
							expiresAt: null,
							metadata: {},
						},
						workItem: {
							id: "fictional-work",
							title: "Prepare inventory",
							projectId: null,
							riskLevel: "low",
						},
						effectiveStatus: "pending",
						canDecide: true,
					},
				],
				nextCursor: null,
				hasMore: false,
			};
		return implementation(procedure, input);
	});
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards.some((card) => card.id === "fictional-question")).toBe(
		false,
	);
	const feed = await loadForYouProjection(context, { limit: 100 });
	expect(
		feed.items.filter((item) => item.needsAction).map((item) => item.id),
	).not.toEqual(
		expect.arrayContaining([
			"decision:fictional-question",
			"work-approval:fictional-approval",
		]),
	);
});

it("separates factory deadlines from show-from in Deck and Feed", async () => {
	const implementation = mocks.call.getMockImplementation()!;
	mocks.call.mockImplementation(async (procedure: string, input: unknown) => {
		const result = await implementation(procedure, input);
		if (procedure !== "output") return result;
		result.currentRevision.content.columns.push("Due at", "Show from");
		result.currentRevision.content.rows = [
			[
				"opportunity",
				"Visible deadline",
				"Review tomorrow's deadline",
				"",
				"",
				"",
				"2099-10-22",
				"",
			],
			[
				"opportunity",
				"Hidden schedule",
				"Wait until shown",
				"",
				"",
				"",
				"2099-10-22",
				"2099-10-21",
			],
		];
		return result;
	});
	const deck = await loadDeckProjection(context, { limit: 100 });
	expect(deck.cards.map((card) => card.id)).toEqual([`factory:${outputId}:0`]);
	expect(deck.cards[0]?.dueAt).toBe("2099-10-22");
	const feed = await loadForYouProjection(context, { limit: 100 });
	expect(
		feed.items
			.filter((item) => item.id.startsWith("factory:"))
			.map((item) => item.id),
	).toEqual([`factory:${outputId}:0`]);
});

it("withholds overdue priority for a blocked source reached through the graph", async () => {
	const initial = await loadDeckProjection(context, { limit: 100 });
	const id = initial.cards[0]!.id;
	mocks.graph.mockResolvedValue(
		new Map([
			[
				id,
				{
					chain: [
						{
							edge: { kind: "card_from_work" },
							node: { kind: "work_item", id: "maple-source" },
						},
					],
					blocksCount: 8,
				},
			],
		]),
	);
	mocks.states.mockResolvedValue(new Map([["maple-source", "blocked"]]));
	const result = await loadDeckProjection(context, { limit: 100 });
	expect(result.cards.find((c) => c.id === id)).toMatchObject({
		actionable: false,
		overdue: false,
		blocksCount: 8,
	});
	expect(mocks.states).toHaveBeenLastCalledWith(
		undefined,
		"fictional-orchard",
		["maple-source"],
		expect.any(Date),
	);
});

it("quietly delivers an earned agent-decidable factory class to Feed and keeps audits and others in the Deck", async () => {
	const implementation = mocks.call.getMockImplementation()!;
	const approvals = Array.from({ length: 5 }, (_, i) => ({
		id: `approval-${i}`,
		clientEventId: `client-${i}`,
		eventKind: "accepted",
		surface: "decision_deck",
		actorType: "user",
		actorId: "river",
		targetId: `earlier-sheet-${i}`,
		occurredAt: `2026-10-20T10:0${i}:00Z`,
		metadata: {
			decisionClass: "factory:Inbox:opportunity",
			decisionChoice: "do_it",
			rowIndex: i,
		},
	}));
	let protectedEffects: string[] = [];
	let deckAvailable = true;
	let policy = { autoApprove: true, unchangedThreshold: 5, auditSampleRate: 0 };
	mocks.call.mockImplementation(async (procedure: string, input: unknown) => {
		if (procedure === "history") return { events: approvals };
		const result = await implementation(procedure, input);
		if (procedure !== "apps") return result;
		result.items[0].currentRevision.manifest.config.classPolicies = {
			"factory:Inbox:opportunity": policy,
		};
		result.items[0].currentRevision.manifest.config.factorySources = [
			{
				...source,
				protectedEffects,
				scoring: { agentDecidableClasses: ["opportunity"] },
			},
		];
		result.items[1].currentRevision.manifest.config.factorySources = [
			{
				projectId,
				source: {
					...source,
					protectedEffects,
					scoring: { agentDecidableClasses: ["opportunity"] },
				},
			},
		];
		if (!deckAvailable) result.items.shift();
		return result;
	});
	const quiet = (
		await loadForYouProjection(context, { limit: 100 })
	).items.find((item) => item.id === `factory:${outputId}:0`);
	expect(quiet).toMatchObject({ kind: "result", needsAction: false });
	expect(quiet?.explanation).toContain("An agent may decide Inbox opportunity");
	expect((await loadDeckProjection(context, { limit: 100 })).count).toBe(0);
	for (const override of [
		{ autoApprove: false, unchangedThreshold: 5, auditSampleRate: 0 },
		{ autoApprove: true, unchangedThreshold: 6, auditSampleRate: 0 },
		{ autoApprove: true, unchangedThreshold: 5, auditSampleRate: 1 },
	]) {
		policy = override;
		expect((await loadDeckProjection(context, { limit: 100 })).cards).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: `factory:${outputId}:0` }),
			]),
		);
		expect(
			(await loadForYouProjection(context, { limit: 100 })).items.find(
				(item) => item.id === `factory:${outputId}:0`,
			),
		).toMatchObject({ kind: "decision", needsAction: true });
	}
	policy = { autoApprove: true, unchangedThreshold: 5, auditSampleRate: 0 };
	deckAvailable = false;
	expect(
		(await loadForYouProjection(context, { limit: 100 })).items.find(
			(item) => item.id === `factory:${outputId}:0`,
		),
	).toMatchObject({ kind: "decision", needsAction: true });
	deckAvailable = true;
	protectedEffects = ["message"];
	expect((await loadDeckProjection(context, { limit: 100 })).count).toBe(1);
	expect(
		(await loadForYouProjection(context, { limit: 100 })).items.find(
			(item) => item.id === `factory:${outputId}:0`,
		),
	).toMatchObject({ kind: "decision", needsAction: true });
});
