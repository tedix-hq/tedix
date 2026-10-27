import { createRouterClient } from "@orpc/server";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { attentionContractRouter } from "./attention";
const mocks = vi.hoisted(() => ({
	loadDeckProjection: vi.fn(),
	loadForYouProjection: vi.fn(),
	prepareFaces: vi.fn(),
	explainAbsence: vi.fn(),
	call: vi.fn(),
	record: vi.fn(),
	getInteraction: vi.fn(),
	retireReviews: vi.fn(),
	actor: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	getWorkInteraction: mocks.getInteraction,
}));
vi.mock("@tedix/db/queries/work-items/decision-review-retirement", () => ({
	retireDecisionReviews: mocks.retireReviews,
}));
vi.mock("./work-items-principal", () => ({
	verifiedActiveWorkActor: mocks.actor,
}));
vi.mock("../../services/attention-projection", () => ({
	loadDeckProjection: mocks.loadDeckProjection,
	loadForYouProjection: mocks.loadForYouProjection,
}));
vi.mock("../../services/deck-card-absence", () => ({
	explainDeckCardAbsence: mocks.explainAbsence,
}));
vi.mock("../../services/deck-card-face", async (original) => ({
	...(await original<Record<string, unknown>>()),
	prepareDeckCardFaces: mocks.prepareFaces,
}));
vi.mock("@orpc/server", async (original) => ({
	...(await original<Record<string, unknown>>()),
	call: mocks.call,
}));
vi.mock("../../services/learning-interaction-recorder", async (original) => ({
	...(await original<Record<string, unknown>>()),
	recordObservedLearningInteraction: mocks.record,
}));
const requestId = "11111111-1111-4111-8111-111111111111";
function boundedCard(
	metadata: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	return {
		id: requestId,
		kind: "question",
		label: "Which topic should we choose?",
		source: `/work?view=deck#card=${requestId}`,
		interaction: {
			request: {
				id: requestId,
				version: 7,
				kind: "question",
				subject: "Which topic should we choose?",
				prompt: "Choose the next topic.",
				metadata: {
					decisionClass: "customer.preference",
					riskLevel: "medium",
					...metadata,
				},
				...overrides,
			},
		},
	};
}
function response() {
	return {
		kind: "interaction" as const,
		decision: {
			requestId,
			expectedRequestVersion: 7,
			responseKind: "answer" as const,
			body: "Use the proposed topic",
			resolvesRequest: true,
			metadata: {},
		},
	};
}
function envelope() {
	return {
		version: 1,
		kind: "decision",
		classId: "customer.preference",
		proposal: "Choose the next topic",
		whyNow: "Review ready",
		recommendation: "Use the proposed topic",
		reversibility: "two_way",
		protectedEffects: [],
		blastRadius: "Stored preference only",
		confidence: 0.9,
		costOfWaiting: "Can wait",
		reasoning: "Matches context",
		lessons: [],
		options: [
			{
				id: "approve",
				label: "Use topic",
				intent: "approve",
				consequence: "Preference recorded",
				cost: "One note",
			},
			{
				id: "later",
				label: "Later",
				intent: "later",
				consequence: "No change",
				cost: "Wait",
			},
		],
	};
}
function client(
	scopes: string[] = ["mcp:messaging.read", "mcp:messaging.write"],
	user = false,
) {
	return createRouterClient(attentionContractRouter, {
		context: {
			authType: user ? "user" : "apikey",
			user: user ? { sub: "fictional-owner" } : undefined,
			apiKey: { id: "key", scopes },
			organizationId: "fictional-orchard",
			headers: new Headers(),
			env: { ENVIRONMENT: "test", OS_URL: "https://os.example.test" },
			db: {},
			url: new URL("https://api.tedix.test/rpc/attention"),
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.prepareFaces.mockImplementation(async (_context, cards) => cards);
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: true,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
});
it("refuses machine reads without messaging read scope before querying", async () => {
	await expect(client([]).listDeckCards({})).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});
it("returns count and incompleteness independently from the bounded card list", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 12,
		complete: false,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
	expect(await client().listDeckCards({ limit: 1 })).toMatchObject({
		count: 12,
		complete: false,
	});
});
it("stored-only Deck reads preserve projection metadata without preparing card faces", async () => {
	const card = {
		id: requestId,
		kind: "question",
		label: "Choose the topic",
		project: "Unfiled",
		urgency: "later",
		decision: null,
		source: "/work",
		requestedAt: "2026-10-19T12:00:00.000Z",
		dueAt: null,
		score: 0,
	};
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [card, { ...card, id: "second" }],
		count: 2,
		complete: false,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
	expect(
		await client().listDeckCards({ limit: 1, presentation: "stored" }),
	).toMatchObject({ cards: [card], count: 2, complete: false });
	expect(mocks.prepareFaces).not.toHaveBeenCalled();
});
it("keeps presentation generation as the default Deck read behavior", async () => {
	await client().listDeckCards({});
	expect(mocks.prepareFaces).toHaveBeenCalledTimes(1);
});
it("does not call a missing card absent when its inventory is incomplete", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: false,
	});
	await expect(
		client().getDeckCard({ cardId: "missing" }),
	).rejects.toMatchObject({ code: "CONFLICT" });
});
it("tells the caller which filter kept a real card off its Deck", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: true,
	});
	mocks.explainAbsence.mockResolvedValue(
		"It routes to your Feed, not your Deck (routine)",
	);
	await expect(
		client().getDeckCard({ cardId: requestId }),
	).rejects.toMatchObject({
		code: "NOT_FOUND",
		message: "It routes to your Feed, not your Deck (routine)",
	});
	expect(mocks.explainAbsence).toHaveBeenCalledWith(
		expect.anything(),
		requestId,
		expect.objectContaining({ projectId: undefined }),
	);
	await expect(
		client().decideDeckCard({ decision: response() }),
	).rejects.toMatchObject({
		code: "NOT_FOUND",
		message: "It routes to your Feed, not your Deck (routine)",
	});
});
it("rejects a decision before its effect when inventory is incomplete", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: false,
	});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "interaction",
				decision: {
					requestId: "11111111-1111-4111-8111-111111111111",
					expectedRequestVersion: 2,
					responseKind: "answer",
					body: "Approved",
					resolvesRequest: true,
					metadata: {},
				},
			},
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
});
it("requires an expected revision for factory feedback", async () => {
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "factory",
				cardId: "factory:row",
				verdict: "useful",
				reason: "Good opportunity",
			},
		} as never),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("forwards the exact expected interaction version through its canonical effect owner", async () => {
	const requestId = "11111111-1111-4111-8111-111111111111";
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard()],
		complete: true,
	});
	mocks.call.mockResolvedValue({});
	expect(await client().decideDeckCard({ decision: response() })).toEqual({
		saved: true,
		cardId: requestId,
	});
	expect(mocks.call).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ requestId, expectedRequestVersion: 7 }),
		expect.anything(),
	);
});
it("rejects an invalid timezone before reading source data", async () => {
	await expect(
		client().listDeckCards({ timeZone: "Not/AZone" }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});

it.each([
	[
		"publish_support",
		{
			decisionDeck: {
				...envelope(),
				options: [
					{
						...envelope().options[0],
						effect: {
							kind: "publish_support",
							ticketId: requestId,
							expectedVersion: 1,
						},
					},
					envelope().options[1],
				],
			},
		},
	],
	[
		"publish_docs",
		{
			decisionDeck: {
				...envelope(),
				options: [
					{
						...envelope().options[0],
						effect: {
							kind: "publish_docs",
							siteId: requestId,
							buildId: requestId,
						},
					},
					envelope().options[1],
				],
			},
		},
	],
	[
		"protected message",
		{ decisionDeck: { ...envelope(), protectedEffects: ["message"] } },
	],
	[
		"irreversible",
		{ decisionDeck: { ...envelope(), reversibility: "one_way" } },
	],
	[
		"unknown reversibility",
		{ decisionDeck: { ...envelope(), reversibility: "unknown" } },
	],
	["critical risk", { riskLevel: "critical" }],
	["unknown risk", { riskLevel: "unknown" }],
	["consent import", { localImport: {}, decisionDeck: envelope() }],
	[
		"critical proposal",
		{
			decisionDeck: {
				...envelope(),
				proposal: "Send this message to the customer",
			},
		},
	],
	["unknown effect", { cardPresentation: { effectStatus: "unknown" } }],
	["governed operation", { approvalOperation: "approve_work" }],
	["malformed envelope", { decisionDeck: { version: 1 } }],
])("refuses %s before any response/effect write", async (label, metadata) => {
	if (label !== "malformed envelope" && "decisionDeck" in metadata)
		expect(
			DecisionEnvelopeSchema.safeParse(metadata.decisionDeck).success,
		).toBe(true);
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard(metadata)],
		complete: true,
	});
	await expect(
		client().decideDeckCard({ decision: response() }),
	).rejects.toMatchObject({
		code: "FORBIDDEN",
		message: expect.stringContaining(`/work?view=deck#card=${requestId}`),
	});
	expect(mocks.call).not.toHaveBeenCalled();
	expect(mocks.record).not.toHaveBeenCalled();
});
it.each([
	{ subject: "Grant these permissions?" },
	{ subject: "Send this message to the customer?" },
	{ kind: "handoff" },
])(
	"refuses critical questions or handoffs despite a low risk label: %j",
	async (overrides) => {
		mocks.loadDeckProjection.mockResolvedValue({
			cards: [boundedCard({ riskLevel: "low" }, overrides)],
			complete: true,
		});
		await expect(
			client().decideDeckCard({ decision: response() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.call).not.toHaveBeenCalled();
	},
);
it("refuses governed approval dispatch", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [{ id: `approval:${requestId}`, source: "/work?view=deck" }],
		complete: true,
	});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "runtime_approval",
				decision: { id: requestId, status: "approved" },
			},
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.call).not.toHaveBeenCalled();
});
it("detects changed interaction versions before writing", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard({}, { version: 8 })],
		complete: true,
	});
	await expect(
		client().decideDeckCard({ decision: response() }),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(mocks.call).not.toHaveBeenCalled();
});
it("records factory usefulness without executing its proposed action", async () => {
	const source = {
		label: "Inbox",
		columns: {
			source: "Source",
			why: "Why",
			draft: "Draft",
			useful: "Useful",
			reason: "Reason",
			done: "Done",
		},
	};
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [
			{
				id: "factory:row",
				label: "Review this lead?",
				factory: { outputId: requestId, sourceIndex: 0, rowIndex: 0 },
			},
		],
		complete: true,
		config: { factorySources: [source] },
	});
	mocks.call
		.mockResolvedValueOnce({
			output: { title: "Cards", createdAt: "2026-10-19T12:00:00.000Z" },
			currentRevision: {
				revision: 3,
				content: {
					kind: "sheet",
					columns: ["Source", "Why", "Draft", "Useful", "Reason", "Done"],
					rows: [["A lead", "Relevant", "Send this message", "", "", ""]],
				},
			},
		})
		.mockResolvedValueOnce({ revision: { id: "revision4" } });
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "factory",
				cardId: "factory:row",
				expectedRevision: 3,
				verdict: "useful",
				reason: "Relevant opportunity",
			},
		}),
	).resolves.toEqual({ saved: true, cardId: "factory:row" });
	expect(mocks.call).toHaveBeenCalledTimes(2);
	expect(mocks.call.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 3 });
	expect(mocks.record).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			eventKind: "accepted",
			metadata: expect.objectContaining({ decisionChoice: "useful" }),
		}),
	);
});

it("records a scored factory card's features, score and mapped skip reason", async () => {
	const source = {
		label: "Forum",
		columns: {
			type: "Type",
			source: "Source",
			why: "Why",
			useful: "Useful",
			reason: "Reason",
			done: "Done",
			score: "Score",
			features: "Features",
		},
		scoring: {
			weights: { fresh_thread: 1 },
			skipReasonChips: [
				{ label: "Already covered", mapsTo: "duplicate" },
				{ label: "Too much effort", mapsTo: null },
			],
			agentDecidableClasses: [],
		},
	};
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [
			{
				id: "factory:row",
				label: "Reply to this thread?",
				factory: { outputId: requestId, sourceIndex: 0, rowIndex: 0 },
			},
		],
		complete: true,
		config: { factorySources: [source] },
	});
	const sheet = {
		kind: "sheet",
		columns: [
			"Type",
			"Source",
			"Why",
			"Useful",
			"Reason",
			"Done",
			"Score",
			"Features",
		],
		rows: [
			[
				"Reply",
				"A thread",
				"Fresh question",
				"",
				"",
				"",
				"0.7",
				'{"fresh_thread":0.9}',
			],
		],
	};
	mocks.call
		.mockResolvedValueOnce({
			output: { title: "Cards", createdAt: "2026-10-19T12:00:00.000Z" },
			currentRevision: { revision: 3, content: sheet },
		})
		.mockResolvedValueOnce({ revision: { id: "revision4" } });
	await client().decideDeckCard({
		decision: {
			kind: "factory",
			cardId: "factory:row",
			expectedRevision: 3,
			verdict: "not_useful",
			reason: "Already covered: answered last week",
		},
	});
	expect(mocks.record).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			eventKind: "rejected",
			metadata: expect.objectContaining({
				decisionClass: "factory:Forum:Reply",
				decisionChoice: "not_useful",
				score: 0.7,
				features: { fresh_thread: 0.9 },
				factoryReason: "Already covered",
				sharedReason: "duplicate",
				reason: "Already covered: answered last week",
			}),
		}),
	);
});

it("writes row-review verdicts back to the sheet and resolves the ask", async () => {
	const sheetOutput = "22222222-2222-4222-8222-222222222222";
	const rowReview = {
		sheet: { outputId: sheetOutput, title: "Vouchers", revision: 3 },
		columns: { status: "Status", correction: "Note" },
		rows: [
			{ row: 0, label: "Rewe 12.03", proposal: "Kategorie: Verpflegung" },
			{ row: 2, label: "Vapiano", proposal: "Teilnehmer: Aaron" },
		],
	};
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [
			boundedCard({
				schema: "tedix.row-review.v1",
				rowReview,
			}),
		],
		complete: true,
	});
	mocks.call
		.mockResolvedValueOnce({
			output: { title: "Vouchers" },
			currentRevision: {
				revision: 3,
				content: {
					kind: "sheet",
					columns: ["Beleg", "Status", "Anlass", "Note"],
					rows: [
						["Rewe", "", "", ""],
						["Baker", "", "", ""],
						["Vapiano", "", "", ""],
					],
				},
			},
		})
		.mockResolvedValueOnce({})
		.mockResolvedValueOnce({ revision: { id: "rev4", revision: 4 } })
		.mockResolvedValueOnce({});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "row_review",
				requestId,
				expectedRequestVersion: 7,
				verdicts: [
					{ row: 0, verdict: "confirmed" },
					{ row: 2, verdict: "corrected", correction: "Aaron, Christian" },
				],
			},
		}),
	).resolves.toEqual({ saved: true, cardId: requestId });
	expect(mocks.call.mock.calls[1]?.[1]).toMatchObject({
		requestId,
		expectedRequestVersion: 7,
		responseKind: "answer",
		resolvesRequest: false,
		metadata: expect.objectContaining({ status: "started" }),
	});
	expect(mocks.call.mock.calls[2]?.[1]).toMatchObject({
		outputId: sheetOutput,
		startRow: 0,
		startColumn: 1,
		cells: [
			["confirmed", "", ""],
			["", "", ""],
			["corrected", "", "Aaron, Christian"],
		],
		expectedRevision: 3,
	});
	expect(mocks.call.mock.calls[3]?.[1]).toMatchObject({
		requestId,
		expectedRequestVersion: 8,
		responseKind: "answer",
		resolvesRequest: true,
		metadata: expect.objectContaining({
			schema: "tedix.row-review-result.v1",
			sheet: expect.objectContaining({ outputId: sheetOutput, revision: 4 }),
		}),
	});
});
it("refuses a row-review answer when the sheet moved", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [
			boundedCard({
				schema: "tedix.row-review.v1",
				rowReview: {
					sheet: {
						outputId: "22222222-2222-4222-8222-222222222222",
						title: "Vouchers",
						revision: 3,
					},
					columns: { status: "Status", correction: "Correction" },
					rows: [{ row: 0, label: "Rewe", proposal: "x" }],
				},
			}),
		],
		complete: true,
	});
	mocks.call.mockResolvedValueOnce({
		currentRevision: { revision: 4, content: { kind: "sheet" } },
	});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "row_review",
				requestId,
				expectedRequestVersion: 7,
				verdicts: [{ row: 0, verdict: "confirmed" }],
			},
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(mocks.call).toHaveBeenCalledTimes(1);
});
it("keeps a claimed row-review ask open when the sheet write fails", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [
			boundedCard({
				schema: "tedix.row-review.v1",
				rowReview: {
					sheet: {
						outputId: "22222222-2222-4222-8222-222222222222",
						title: "Vouchers",
						revision: 3,
					},
					columns: { status: "Status", correction: "Correction" },
					rows: [{ row: 0, label: "Rewe", proposal: "x" }],
				},
			}),
		],
		complete: true,
	});
	mocks.call
		.mockResolvedValueOnce({
			output: { title: "Vouchers" },
			currentRevision: {
				revision: 3,
				content: {
					kind: "sheet",
					columns: ["Status", "Correction"],
					rows: [["", ""]],
				},
			},
		})
		.mockResolvedValueOnce({})
		.mockRejectedValueOnce(new Error("sheet write failed"));
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "row_review",
				requestId,
				expectedRequestVersion: 7,
				verdicts: [{ row: 0, verdict: "confirmed" }],
			},
		}),
	).rejects.toThrow("sheet write failed");
	expect(mocks.call).toHaveBeenCalledTimes(3);
	expect(mocks.call.mock.calls[1]?.[1]).toMatchObject({
		requestId,
		resolvesRequest: false,
	});
});
it("allows an explicit reversible envelope without protected or executable effects", async () => {
	const decisionDeck = DecisionEnvelopeSchema.parse(envelope());
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard({ decisionDeck })],
		complete: true,
	});
	mocks.call.mockResolvedValue({});
	await expect(
		client().decideDeckCard({ decision: response() }),
	).resolves.toEqual({ saved: true, cardId: requestId });
	expect(mocks.call).toHaveBeenCalledTimes(1);
});
it("does not let an owner login bypass protected effects and returns the configured OS URL", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard({ riskLevel: "critical" })],
		complete: true,
	});
	await expect(
		client(undefined, true).decideDeckCard({ decision: response() }),
	).rejects.toMatchObject({
		code: "FORBIDDEN",
		message: expect.stringContaining(
			`https://os.example.test/work?view=deck#card=${requestId}`,
		),
	});
	expect(mocks.call).not.toHaveBeenCalled();
});

it("refuses governed Work approvals before dispatch", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [{ id: `work-approval:${requestId}`, source: "/work?view=deck" }],
		complete: true,
	});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "work_approval",
				decision: {
					proposalId: requestId,
					expectedProposalVersion: 2,
					decision: "approved",
					rationale: "Within budget",
				},
			},
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.call).not.toHaveBeenCalled();
});

it("routes change requests on protected cards without deciding or executing them", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [boundedCard({}, { kind: "approval" })],
		complete: true,
	});
	mocks.call.mockResolvedValue({});
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "request_changes",
				cardId: requestId,
				expectedRequestVersion: 1,
				instruction: "Shorten the draft introduction.",
			},
		}),
	).resolves.toEqual({ saved: true, cardId: requestId });
	expect(mocks.call).toHaveBeenCalledTimes(1);
	expect(mocks.call.mock.calls[0]?.[1]).toEqual({
		requestId,
		expectedRequestVersion: 1,
		instruction: "Shorten the draft introduction.",
	});
	expect(mocks.record).not.toHaveBeenCalled();
});

it("refuses secret-like change instructions before loading or writing a Deck", async () => {
	await expect(
		client().decideDeckCard({
			decision: {
				kind: "request_changes",
				cardId: requestId,
				expectedRequestVersion: 1,
				instruction: "fc-" + "fictional".repeat(5),
			},
		}),
	).rejects.toBeDefined();
	expect(mocks.call).not.toHaveBeenCalled();
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});

it("show tools enforce caller scopes and retain incomplete text fallback", async () => {
	await expect(client([]).showDeck({})).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(client([]).showFeed({})).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: false,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
	const view = await client().showDeck({ limit: 1 });
	expect(view).toMatchObject({ empty: true, complete: false });
	expect(view.markdown).toContain("inventory is incomplete");
	expect(view.notice).toContain("Reload");
});
it("show_feed separates Needs you from Updates without creating actions", async () => {
	const item = {
		id: "sample",
		actor: "Sample assistant",
		sentence: "Source update",
		source: "/work",
		projectId: null,
		tediId: null,
		workItemId: null,
		kind: "work",
		classId: "sample.update",
		importance: "normal",
		at: "2026-10-19T12:00:00.000Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: false,
		explanation: "Source detail",
		reactions: [],
		score: 1,
		unseen: true,
		deadline: false,
		factors: {},
	};
	mocks.loadForYouProjection.mockResolvedValue({
		items: [item, { ...item, id: "needs", needsAction: true }],
		heldCount: 0,
		used: 2,
		day: "2026-10-19",
		complete: true,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
	const view = await client().showFeed({});
	expect(view.needsYou.map((c) => c.id)).toEqual(["needs"]);
	expect(view.updates.map((c) => c.id)).toEqual(["sample"]);
	expect(view.cards.every((c) => !c.actions.length)).toBe(true);
});

it("lets an agent dismiss an effect-free facts review without a human inbox or answer", async () => {
	const review = {
		...boundedCard().interaction.request,
		creatorType: "system",
		creatorId: "tedix",
		metadata: {
			replacesDecisionId: "earlier",
			decisionDeck: {
				...envelope(),
				kind: "question",
				classId: "decision-facts-changed",
				proposal: "Review changed facts: Delete the database?",
				options: [
					{ ...envelope().options[0], id: "dismiss", intent: "reject" },
					envelope().options[1],
				],
			},
		},
	};
	mocks.getInteraction.mockResolvedValue(review);
	mocks.actor.mockResolvedValue({ type: "external_agent", id: "executor" });
	mocks.retireReviews.mockResolvedValue(1);
	const decision = response();
	decision.decision.metadata = { cardAction: "dismiss" };
	expect(await client().decideDeckCard({ decision })).toEqual({
		saved: true,
		cardId: requestId,
	});
	expect(mocks.retireReviews).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			orgId: "fictional-orchard",
			dismiss: expect.objectContaining({
				id: requestId,
				version: 7,
				actorType: "external_agent",
				actorId: "executor",
			}),
		}),
	);
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
	expect(mocks.call).not.toHaveBeenCalled();
});

it("keeps effectful facts reviews behind the normal decision boundary", async () => {
	const card = boundedCard(
		{
			replacesDecisionId: "earlier",
			decisionDeck: {
				...envelope(),
				kind: "question",
				classId: "decision-facts-changed",
				protectedEffects: ["money"],
			},
		},
		{ creatorType: "system", creatorId: "tedix" },
	);
	mocks.getInteraction.mockResolvedValue(card.interaction.request);
	mocks.loadDeckProjection.mockResolvedValue({ cards: [card], complete: true });
	const decision = response();
	decision.decision.metadata = { cardAction: "dismiss" };
	await expect(client().decideDeckCard({ decision })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.retireReviews).not.toHaveBeenCalled();
	expect(mocks.call).not.toHaveBeenCalled();
});
