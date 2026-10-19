import { createRouterClient } from "@orpc/server";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { attentionContractRouter } from "./attention";
const mocks = vi.hoisted(() => ({
	loadDeckProjection: vi.fn(),
	loadForYouProjection: vi.fn(),
	call: vi.fn(),
	record: vi.fn(),
}));
vi.mock("../../services/attention-projection", () => ({
	loadDeckProjection: mocks.loadDeckProjection,
	loadForYouProjection: mocks.loadForYouProjection,
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
