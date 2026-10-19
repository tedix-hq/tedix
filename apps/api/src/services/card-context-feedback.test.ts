import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	put: vi.fn(),
	record: vi.fn(),
	list: vi.fn(),
	current: vi.fn(),
	archived: vi.fn(),
	evidence: vi.fn(),
	create: vi.fn(),
}));
vi.mock("@tedix/db/queries/user-configs", () => ({
	getUserConfig: mocks.get,
	putUserConfig: mocks.put,
}));
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteraction: mocks.record,
	listLearningInteractions: mocks.list,
}));
vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	createFact: mocks.create,
	findCurrentFactsByTopicKey: mocks.current,
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	decisionLessonEvidence: mocks.evidence,
	listArchivedLearningFeedLessons: mocks.archived,
}));
vi.mock("@tedix/db/queries/memory-graph/domains", () => ({
	getOrCreateDomain: async () => ({ id: "fictional-domain" }),
}));
import { recordCardContext, sampleCardContext } from "./card-context-feedback";
import type { BaseContext } from "../rpc/orpc";

const context = {
	organizationId: "fictional-org",
	userId: "fictional-internal-user",
	db: {},
} as BaseContext;
const configs = new Map<
	string,
	{ revision: number; value: Record<string, unknown> }
>();
const events: Record<string, unknown>[] = [];
const key = (input: { userId: string; namespace: string; key: string }) =>
	JSON.stringify([input.userId, input.namespace, input.key]);
beforeEach(() => {
	vi.clearAllMocks();
	configs.clear();
	events.length = 0;
	mocks.get.mockImplementation(
		async (_db, input) => configs.get(key(input)) ?? null,
	);
	mocks.put.mockImplementation(async (_db, input) => {
		const prior = configs.get(key(input));
		if ((prior?.revision ?? 0) !== input.expectedRevision) return { ok: false };
		const row = { revision: (prior?.revision ?? 0) + 1, value: input.value };
		configs.set(key(input), row);
		return { ok: true, row };
	});
	mocks.record.mockImplementation(async (_db, input) => {
		events.push({ id: `event-${events.length}`, ...input });
		return {};
	});
	mocks.list.mockImplementation(async (_db, input) =>
		events.filter(
			(event) =>
				event.organizationId === input.organizationId &&
				event.scopeId === input.personalScopeId,
		),
	);
	mocks.current.mockResolvedValue([]);
	mocks.archived.mockResolvedValue([]);
	mocks.evidence.mockResolvedValue({
		version: 1,
		state: "live",
		sources: [],
		supportCount: 3,
	});
	configs.set(
		key({
			userId: context.userId!,
			namespace: "card-context.v1",
			key: context.organizationId!,
		}),
		{
			revision: 1,
			value: {
				count: 15,
				seen: ["a", "b", "c"],
				presentations: {
					a: { sourceFingerprint: "a".repeat(64), sourceVersion: 2 },
				},
				sampled: {
					a: "relationship.followup",
					b: "relationship.followup",
					c: "relationship.followup",
				},
			},
		},
	);
});
const report = (cardId: string) =>
	recordCardContext(context, "fictional-person", {
		cardId,
		clientEventId: crypto.randomUUID(),
		enough: false,
		chip: "who",
	});
it("retains the presented-copy reference for both positive and negative feedback", async () => {
	await recordCardContext(context, "fictional-person", {
		cardId: "a",
		clientEventId: crypto.randomUUID(),
		enough: true,
	});
	await report("a");
	for (const event of events)
		expect(event.metadata).toMatchObject({
			presentation: { sourceFingerprint: "a".repeat(64), sourceVersion: 2 },
		});
});
it("rejects feedback without a personal sampled question and refuses another organization", async () => {
	await expect(report("unseen")).rejects.toThrow("no context question");
	await expect(report("toString")).rejects.toThrow("no context question");
	await expect(
		recordCardContext(
			{ ...context, organizationId: "fictional-other-org" },
			"fictional-person",
			{ cardId: "a", clientEventId: crypto.randomUUID(), enough: true },
		),
	).rejects.toThrow("no context question");
	expect(mocks.record).not.toHaveBeenCalled();
});
it("learns once from three distinct cards, never from repeated clicks on one card", async () => {
	await report("a");
	await report("a");
	await report("b");
	expect(mocks.create).not.toHaveBeenCalled();
	await report("c");
	await report("c");
	expect(mocks.create).toHaveBeenCalledTimes(1);
	const fact = mocks.create.mock.calls[0]![1];
	expect(fact).toMatchObject({
		organizationId: "fictional-org",
		visibility: "private",
		reviewStatus: "confirmed",
		metadata: {
			decisionClass: "relationship.followup",
			learningFeed: { ownerUserId: "fictional-person" },
		},
	});
	expect(fact.content).toContain("where you met");
	expect(fact.content).toContain("source gives them");
});
it("respects a rule removed in Brain rather than recreating it", async () => {
	mocks.archived.mockResolvedValue([{ id: "removed-rule" }]);
	await report("a");
	await report("b");
	await report("c");
	expect(mocks.create).not.toHaveBeenCalled();
});
it("withholds prompts when learning is disabled or another tab wins the sampling write", async () => {
	expect(await sampleCardContext(context, { id: "new" } as never, false)).toBe(
		false,
	);
	mocks.put.mockResolvedValue({ ok: false });
	expect(
		await sampleCardContext(
			context,
			{ id: "new", decision: null } as never,
			true,
		),
	).toBe(false);
});
