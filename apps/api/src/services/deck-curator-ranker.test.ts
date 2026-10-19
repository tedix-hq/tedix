import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { rankCurrentDeck } from "./deck-curator-ranker";

const mocks = vi.hoisted(() => ({
	actor: vi.fn(),
	projection: vi.fn(),
	config: vi.fn(),
	history: vi.fn(),
	reserve: vi.fn(),
	model: vi.fn(),
}));
vi.mock("../rpc/routers/work-items-principal", () => ({
	verifiedActiveWorkActor: mocks.actor,
}));
vi.mock("../rpc/org-scope", () => ({ requireOrgId: () => "fictional-org" }));
vi.mock("../rpc/orpc", () => ({
	ErrorCodes: { FORBIDDEN: "FORBIDDEN", CONFLICT: "CONFLICT" },
	createError: (code: string, message: string) =>
		Object.assign(new Error(message), { code }),
}));
vi.mock("./attention-projection", () => ({
	loadDeckProjection: mocks.projection,
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	listLearningInteractions: mocks.history,
}));
vi.mock("@tedix/db/queries/deck-curator-budget", () => ({
	reserveDeckRankingBudget: mocks.reserve,
}));
vi.mock("./decision-card-copy-model", () => ({
	runDecisionCardCopyModel: mocks.model,
}));

const context = {
	db: {},
	env: {
		AI_GATEWAY_ACCOUNT_ID: "example-account",
		AI_GATEWAY_LLM_ID: "example-gateway",
		CF_AI_GATEWAY_TOKEN: "test-placeholder",
	},
} as unknown as BaseContext;
const input = { limit: 100 };
function card(id: string, kind = "decision") {
	return {
		id,
		kind,
		label: `Choose research topic ${id}?`,
		project: "fictional",
		urgency: "later",
		decision: null,
		source: `/work?view=deck#card=${id}`,
		requestedAt: "2026-10-19T10:00:00.000Z",
		dueAt: null,
		score: 0,
	};
}
function events() {
	return Array.from({ length: 8 }, (_, index) => ({
		id: `event-${index}`,
		targetId: `past-${index}`,
		actorType: "user",
		actorId: "recipient",
		occurredAt: "2026-10-18T10:00:00.000Z",
		metadata: {
			decisionChoice: index % 2 ? "useful" : "not_useful",
			cardTitle: `Prior topic ${index}`,
			cardSummary: "The owner chose its usefulness.",
		},
	}));
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.actor.mockResolvedValue({ type: "user", id: "recipient" });
	mocks.projection.mockResolvedValue({
		cards: [card("one"), card("two"), card("protected", "approval")],
		config: {},
		complete: true,
		observedAt: "2026-10-19T10:00:00.000Z",
	});
	mocks.config.mockResolvedValue(
		DecisionLearningConfigSchema.parse({
			deckCuratorRanker: { enabled: true, perRunReservationMicros: 5000 },
		}),
	);
	mocks.history.mockResolvedValue(events());
	mocks.reserve.mockResolvedValue(true);
	mocks.model.mockResolvedValue('{"label":"NOISE"}');
});
it("requires a verified recipient before any inbox read or inference", async () => {
	mocks.actor.mockResolvedValue({ type: "tedi", id: "owner-tedi" });
	await expect(rankCurrentDeck(context, input)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.projection).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});
it("retains all cards, pins policy cards, retrieves eight personal examples and respects the per-run cap", async () => {
	const result = await rankCurrentDeck(context, input);
	expect(result.cards.map((row) => row.id)).toEqual([
		"protected",
		"two",
		"one",
	]);
	expect(result.signals.map((row) => row.reason)).toEqual([
		"ranked_lower",
		"budget_exhausted",
		"critical",
	]);
	expect(result.reservedMicros).toBe(5000);
	expect(mocks.reserve).toHaveBeenCalledTimes(1);
	expect(mocks.model).toHaveBeenCalledTimes(1);
	expect(mocks.model.mock.calls[0]![2]).toMatchObject({
		model: "@cf/qwen/qwen3-30b-a3b-fp8",
		source: "deck_curator_rank",
		maxTokens: 128,
	});
	expect(JSON.parse(mocks.model.mock.calls[0]![1]).examples).toHaveLength(8);
	expect(mocks.history.mock.calls[0]![1]).toMatchObject({
		personalScopeId: "recipient",
		scopeId: "recipient",
		scopeKind: "personal",
	});
});
it("does not reinterpret approvals or another actor's verdicts as personal usefulness labels", async () => {
	mocks.history.mockResolvedValue([
		...events().slice(0, 6),
		{
			...events()[6],
			metadata: { ...events()[6]!.metadata, decisionChoice: "approve" },
		},
		{ ...events()[7], actorId: "another-person" },
	]);
	const result = await rankCurrentDeck(context, input);
	expect(result.signals[0]).toMatchObject({
		reason: "insufficient_examples",
		exampleIds: expect.any(Array),
	});
	expect(mocks.reserve).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});
it("keeps daily reservations for failed inference and abstains when the daily cap is exhausted", async () => {
	mocks.model.mockResolvedValue(null);
	mocks.reserve.mockResolvedValueOnce(false).mockResolvedValue(true);
	const result = await rankCurrentDeck(context, input);
	expect(result.signals.map((row) => row.reason)).toEqual([
		"budget_exhausted",
		"model_failed",
		"critical",
	]);
	expect(result.reservedMicros).toBe(5000);
	expect(result.cards).toHaveLength(3);
});
it("rejects incomplete inventories and makes no inference when disabled", async () => {
	mocks.projection.mockResolvedValueOnce({ cards: [], complete: false });
	await expect(rankCurrentDeck(context, input)).rejects.toMatchObject({
		code: "CONFLICT",
	});
	mocks.config.mockResolvedValue(DecisionLearningConfigSchema.parse({}));
	const result = await rankCurrentDeck(context, input);
	expect(result.signals[0]!.reason).toBe("disabled");
	expect(mocks.history).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});

it.each([
	{ protectedEffects: ["consent"] },
	{ protectedEffects: "money" },
	{ approvalOperation: "" },
])(
	"pins protected or malformed approval metadata without an envelope: %j",
	async (metadata) => {
		mocks.projection.mockResolvedValue({
			cards: [
				card("routine"),
				{
					...card("sensitive"),
					interaction: {
						request: {
							prompt: "Review the request",
							metadata,
						},
					},
				},
			],
			config: {},
			complete: true,
			observedAt: "2026-10-19T10:00:00.000Z",
		});
		const result = await rankCurrentDeck(context, input);
		expect(result.cards[0]!.id).toBe("sensitive");
		expect(
			result.signals.find((row) => row.cardId === "sensitive")!.reason,
		).toBe("critical");
		expect(mocks.model).toHaveBeenCalledTimes(1);
	},
);

it("uses the configured Workers AI Gateway binding without requiring an HTTP token", async () => {
	const bound = {
		...context,
		env: {
			...context.env,
			AI: {},
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
			AI_GATEWAY_ACCOUNT_ID: undefined,
			CF_AI_GATEWAY_TOKEN: undefined,
		},
	} as unknown as BaseContext;
	const result = await rankCurrentDeck(bound, input);
	expect(result.signals[0]!.reason).toBe("ranked_lower");
	expect(mocks.model).toHaveBeenCalledTimes(1);
});

it("does not reserve or infer through an unconfigured Gateway", async () => {
	const unconfigured = {
		...context,
		env: { ...context.env, AI_GATEWAY_LLM_ID: undefined },
	} as unknown as BaseContext;
	const result = await rankCurrentDeck(unconfigured, input);
	expect(result.signals[0]!.reason).toBe("model_failed");
	expect(mocks.reserve).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});
