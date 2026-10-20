import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import type { BaseContext } from "../rpc/orpc";

const mocks = vi.hoisted(() => ({
	actor: vi.fn(),
	interaction: vi.fn(),
	append: vi.fn(),
	record: vi.fn(),
	history: vi.fn(),
	config: vi.fn(),
	setLearned: vi.fn(),
}));
vi.mock("../rpc/routers/work-items-principal", () => ({
	verifiedActiveWorkActor: mocks.actor,
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	getWorkInteraction: mocks.interaction,
}));
vi.mock("./deck-curation", () => ({ appendCuration: mocks.append }));
vi.mock("./learning-interaction-recorder", () => ({
	observedLearningActor: () => ({ actorType: "user", actorId: "sub-1" }),
	recordObservedLearningInteraction: mocks.record,
}));
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	listLearningInteractions: mocks.history,
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("@tedix/db/queries/work-items/deck-sweep", () => ({
	setDeckPipelineLearned: mocks.setLearned,
}));
vi.mock("./card-revisions", () => ({
	cardOriginalBody: (request: { prompt: string }) => request.prompt,
}));

import { markDeckCardNotUseful, removeDeckRule } from "./deck-learning";

const orgId = "11111111-1111-4111-8111-111111111111";
const cardId = "22222222-2222-4222-8222-222222222222";
const context = { db: {}, organizationId: orgId } as unknown as BaseContext;
const card = {
	id: cardId,
	orgId,
	kind: "question",
	status: "open",
	version: 3,
	subject: "Keep the paused copy?",
	prompt: "I recommend deleting it.",
	creatorType: "external_agent",
	creatorId: "agent-1",
	targetType: "user",
	targetId: "user-1",
	metadata: { source: "deck-truth", cardRevision: 1 },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.actor.mockResolvedValue({ type: "user", id: "user-1" });
	mocks.interaction.mockResolvedValue(card);
	mocks.append.mockResolvedValue({ revision: 2 });
	mocks.record.mockResolvedValue(true);
	mocks.history.mockResolvedValue([]);
	mocks.config.mockResolvedValue(DecisionLearningConfigSchema.parse({}));
});

vi.mock("../rpc/org-scope", () => ({ requireOrgId: () => orgId }));

describe("markDeckCardNotUseful", () => {
	it("retires the card, records a NOISE label with its reason, and offers undo", async () => {
		const result = await markDeckCardNotUseful(context, {
			requestId: cardId,
			reason: "not_for_me",
		});
		expect(result).toMatchObject({
			retired: true,
			rule: null,
			undo: {
				expectedRevision: 2,
				restoreRevision: 1,
				expectedRequestVersion: 4,
			},
		});
		expect(mocks.record.mock.calls[0]?.[1]).toMatchObject({
			eventKind: "rejected",
			surface: "decision_deck",
			metadata: {
				decisionChoice: "not_useful",
				labelSource: "recipient",
				reasonChip: "not_for_me",
				sourceKey: "external_agent:agent-1:deck-truth",
				classKey: "answer|external_agent:agent-1:deck-truth",
			},
		});
		expect(mocks.append.mock.calls[0]?.[1].state).toMatchObject({
			status: "cancelled",
			retirement: { reason: "no_longer_relevant" },
			notUseful: { reason: "not_for_me" },
		});
	});

	it("turns the third identical reason from one source into a rule", async () => {
		mocks.history.mockResolvedValue(
			["a", "b"].map((id) => ({
				clientEventId: id,
				metadata: {
					reasonChip: "expired",
					sourceKey: "external_agent:agent-1:deck-truth",
				},
			})),
		);
		const result = await markDeckCardNotUseful(context, {
			requestId: cardId,
			reason: "expired",
		});
		expect(result.rule).toMatchObject({
			reason: "expired",
			recipientId: "user-1",
			sourceKey: "external_agent:agent-1:deck-truth",
		});
		expect(mocks.setLearned.mock.calls[0]?.[2].rules).toHaveLength(1);
	});

	it("keeps a message draft in its review flow but still learns", async () => {
		mocks.interaction.mockResolvedValue({
			...card,
			metadata: { schema: "tedix.outbound.v1" },
		});
		const result = await markDeckCardNotUseful(context, {
			requestId: cardId,
			reason: "duplicate",
		});
		expect(result).toMatchObject({ retired: false, undo: null });
		expect(mocks.append).not.toHaveBeenCalled();
		expect(mocks.record).toHaveBeenCalledTimes(1);
	});

	it("refuses anyone but the recipient", async () => {
		mocks.actor.mockResolvedValue({ type: "tedi", id: "tedi-1" });
		await expect(
			markDeckCardNotUseful(context, { requestId: cardId, reason: "expired" }),
		).rejects.toThrow(/recipient/);
	});
});

describe("removeDeckRule", () => {
	it("removes only the caller's own rule", async () => {
		const rule = {
			id: "rule-1",
			recipientId: "user-1",
			sourceKey: "external_agent:agent-1",
			reason: "not_for_me",
			sentence: "Cards from agent agent-1 stay off your Deck.",
			evidenceIds: ["a", "b", "c"],
			createdAt: "2026-10-20T00:00:00.000Z",
		};
		mocks.config.mockResolvedValue(
			DecisionLearningConfigSchema.parse({
				deckPipeline: {
					rules: [rule, { ...rule, id: "rule-2", recipientId: "user-2" }],
				},
			}),
		);
		expect(await removeDeckRule(context, { ruleId: "rule-2" })).toEqual({
			removed: false,
			rules: [rule],
		});
		expect(await removeDeckRule(context, { ruleId: "rule-1" })).toEqual({
			removed: true,
			rules: [],
		});
		expect(mocks.setLearned.mock.calls[0]?.[2].rules).toEqual([
			{ ...rule, id: "rule-2", recipientId: "user-2" },
		]);
	});
});
