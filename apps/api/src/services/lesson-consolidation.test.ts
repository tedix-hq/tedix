import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listCurrentLearningFeedLessons: vi.fn(async () => []),
}));
vi.mock("@tedix/db/queries/memory-graph/domains", () => ({
	getOrCreateDomain: vi.fn(async () => ({ id: "domain-ops" })),
}));
vi.mock("@tedix/db/queries/memory-graph/fact-lifecycle", () => ({
	invalidateFact: vi.fn(async () => undefined),
}));
vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	createFact: vi.fn(async () => ({})),
	updateFact: vi.fn(async () => undefined),
}));

import { listCurrentLearningFeedLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { createFact, updateFact } from "@tedix/db/queries/memory-graph/facts";
import {
	consolidatePersonalLessons,
	planConsolidation,
	standingTopicKey,
} from "./lesson-consolidation";
import { DISTILL_VERSION } from "./lesson-distiller";

const db = {} as DbClient;

function lesson(id: string, topic: string, rules: string[], over = {}) {
	return {
		id,
		topicKey: `learning-feed:decision:acme:codex:${topic}:user:user-1`,
		content: [
			`Lessons from user decisions in acme (codex, ${topic}):`,
			...rules.map((r) => `- ${r}`),
		].join("\n"),
		reviewStatus: "confirmed",
		metadata: {
			learningFeed: {
				ownerUserId: "user-1",
				autoConfirmed: true,
				distilled: DISTILL_VERSION,
				evidenceEventIds: [`${id}-e`],
				lastEventAt: "2026-10-01T00:00:00.000Z",
			},
		},
		...over,
	};
}

beforeEach(() => vi.clearAllMocks());

describe("planConsolidation", () => {
	it("hoists rules several lessons share and keeps what is specific", () => {
		const plan = planConsolidation([
			{
				id: "a",
				content:
					"h\n- Answer in short plain English.\n- Fan out to subagents in parallel.",
			},
			{
				id: "b",
				content: "h\n- Answer in short, plain English\n- Commit to main.",
			},
			{ id: "c", content: "h\n- Commit to main." },
			{ id: "d", content: "h\n- Use the staging tenant for widget tests." },
		]);
		expect(plan.standing).toEqual([
			"Answer in short plain English",
			"Commit to main",
		]);
		expect(plan.topics).toEqual(
			new Map([
				["a", ["Fan out to subagents in parallel."]],
				["b", []],
				["c", []],
			]),
		);
	});
});

describe("consolidatePersonalLessons", () => {
	it("writes one standing lesson, trims and retires topic lessons", async () => {
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
			lesson("a", "ship", ["Commit to main.", "Deploy after tests pass."]),
			lesson("b", "verify", ["Commit to main."]),
			// A reviewed lesson is never edited.
			lesson("c", "status", ["Commit to main."], {
				metadata: {
					learningFeed: { ownerUserId: "user-1", distilled: DISTILL_VERSION },
					memoryLifecycle: { lastReview: { at: "x" } },
				},
			}),
		] as never);
		const result = await consolidatePersonalLessons(db, "org-1");
		expect(result).toEqual({
			standingWritten: 1,
			topicLessonsTrimmed: 1,
			topicLessonsRetired: 1,
		});
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact).toMatchObject({
			topicKey: standingTopicKey("user-1"),
			visibility: "private",
			status: "active",
			content:
				"Standing preferences from your decisions across sessions:\n- Commit to main",
			metadata: {
				learningFeed: {
					hoisted: true,
					ownerUserId: "user-1",
					scope: { repo: "general", harness: "general", topic: "standing" },
				},
			},
		});
		expect(vi.mocked(updateFact).mock.calls[0]).toEqual([
			db,
			"a",
			expect.objectContaining({
				content:
					"Lessons from user decisions in acme (codex, ship):\n- Deploy after tests pass.",
			}),
		]);
		expect(invalidateFact).toHaveBeenCalledWith(
			db,
			"b",
			expect.stringContaining("standing lesson"),
		);
		expect(invalidateFact).not.toHaveBeenCalledWith(db, "c", expect.anything());
	});

	it("retires an old per-reply-type lesson its subject lesson now covers", async () => {
		const subject = lesson("subj", "general", ["Deploy after tests pass."]);
		subject.topicKey =
			"learning-feed:decision:acme:general:general:user:user-1";
		(subject.metadata.learningFeed as Record<string, unknown>).scope = {
			repo: "acme",
			harness: "general",
			topic: "general",
		};
		(
			subject.metadata.learningFeed as Record<string, unknown>
		).evidenceEventIds = ["old-e", "subj-e"];
		const old = lesson("old", "ship", ["Commit to main."]);
		(old.metadata.learningFeed as Record<string, unknown>).distilled = 2;
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
			subject,
			old,
		] as never);
		const result = await consolidatePersonalLessons(db, "org-1");
		expect(invalidateFact).toHaveBeenCalledWith(
			db,
			"old",
			"Folded into its subject lesson",
		);
		expect(result).toMatchObject({
			topicLessonsRetired: 1,
			standingWritten: 0,
		});
	});

	it("leaves an unchanged standing lesson alone", async () => {
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
			{
				...lesson("s", "standing", []),
				topicKey: standingTopicKey("user-1"),
				content:
					"Standing preferences from your decisions across sessions:\n- Commit to main",
			},
			lesson("a", "ship", ["Deploy after tests pass."]),
		] as never);
		const result = await consolidatePersonalLessons(db, "org-1");
		expect(result.standingWritten).toBe(0);
		expect(createFact).not.toHaveBeenCalled();
	});
});
