import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/learning-feedback", async (importActual) => {
	const actual =
		await importActual<typeof import("@tedix/db/queries/learning-feedback")>();
	return {
		summarizeRecurringLearningIssues: actual.summarizeRecurringLearningIssues,
		listLearningInteractionsForReflection: vi.fn(),
		recordLearningInteraction: vi.fn(),
		proposeLearningImprovement: vi.fn(),
		listLearningImprovementProposals: vi.fn(),
	};
});
vi.mock("@tedix/db/queries/memory-graph/domains", () => ({
	getOrCreateDomain: vi.fn(async () => ({ id: "domain-ops" })),
}));
vi.mock("@tedix/db/queries/memory-graph/edges", () => ({
	createEdge: vi.fn(async () => ({})),
}));
vi.mock("@tedix/db/queries/memory-graph/fact-lifecycle", () => ({
	invalidateFact: vi.fn(async () => undefined),
}));
vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	createFact: vi.fn(async () => ({})),
	findCurrentFactsByTopicKey: vi.fn(async () => []),
	findFactBySourceHash: vi.fn(async () => undefined),
	updateFact: vi.fn(async () => undefined),
}));
vi.mock("@tedix/db/queries/work-items/activity", () => ({
	listWorkActivity: vi.fn(async () => ({ events: [], truncated: false })),
}));

import {
	listLearningImprovementProposals,
	listLearningInteractionsForReflection,
	proposeLearningImprovement,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import { createEdge } from "@tedix/db/queries/memory-graph/edges";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import {
	createFact,
	findCurrentFactsByTopicKey,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import {
	buildDecisionLessons,
	fixTopic,
	mineLearningFeed,
} from "./learning-feed-miner";

const db = {} as DbClient;

function event(
	id: string,
	over: Partial<LearningInteractionEventRow> & {
		meta?: Record<string, unknown>;
	} = {},
): LearningInteractionEventRow {
	const { meta, ...rest } = over;
	return {
		id,
		organizationId: "org-1",
		actorType: "user",
		actorId: "user-1",
		tediId: null,
		clientEventId: `decision-capture:${id}`,
		signalClass: "quality",
		eventKind: "answered",
		scopeKind: "personal",
		scopeId: "user-1",
		issueKey: "decision:acme:claude-code:deploy",
		surface: "decision_capture",
		targetType: "work_interaction",
		targetId: `req-${id}`,
		threadId: null,
		runId: null,
		metadata: {
			scope: { repo: "acme", harness: "claude-code", topic: "deploy" },
			question: { subject: "s", tail: "Deploy now?" },
			answer: "Never deploy on Fridays; wait for Monday morning.",
			replyClass: "redirect",
			draft: null,
			...meta,
		} as LearningInteractionEventRow["metadata"],
		occurredAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
		createdAt: "2026-10-07T10:00:00.000Z",
		...rest,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([]);
	vi.mocked(listLearningImprovementProposals).mockResolvedValue([]);
	vi.mocked(listWorkActivity).mockResolvedValue({
		events: [],
		truncated: false,
	});
});

describe("buildDecisionLessons", () => {
	it("puts draft corrections first as prefer/avoid lines", () => {
		const [lesson] = buildDecisionLessons([
			event("e1"),
			event("e2", {
				eventKind: "manually_replaced",
				meta: {
					answer: "Run the dry-run migration first.",
					draft: { body: "Ship it." },
				},
			}),
		]);
		expect(lesson?.metadata).toMatchObject({
			kind: "prefer_avoid",
			scope: { repo: "acme", harness: "claude-code", topic: "deploy" },
			evidenceEventIds: ["e2", "e1"],
			learnedFromUserIds: ["user-1"],
			signalCounts: { answered: 1, manually_replaced: 1 },
		});
		expect(lesson?.content.split("\n")).toEqual([
			"Lessons from user decisions in acme (claude-code, deploy):",
			'- Prefer: "Run the dry-run migration first.". Avoid: "Ship it.".',
			'- Decided: "Never deploy on Fridays; wait for Monday morning." (agent asked: "Deploy now?").',
		]);
	});

	it("needs a correction or two substantive decisions", () => {
		expect(buildDecisionLessons([event("e1")])).toEqual([]);
		expect(
			buildDecisionLessons([
				event("e1", { meta: { answer: "ok go" } }),
				event("e2", { meta: { replyClass: "continue" } }),
				event("e3"),
			]),
		).toEqual([]);
		expect(buildDecisionLessons([event("e1"), event("e2")])).toHaveLength(1);
	});

	it("does not relearn events a reviewed fact covers", () => {
		expect(
			buildDecisionLessons([event("e1"), event("e2")], new Set(["e1"])),
		).toEqual([]);
	});

	it("separates scopes", () => {
		const lessons = buildDecisionLessons([
			event("e1"),
			event("e2"),
			event("e3", {
				meta: { scope: { repo: "other", harness: "codex", topic: "deploy" } },
			}),
			event("e4", {
				meta: { scope: { repo: "other", harness: "codex", topic: "deploy" } },
			}),
		]);
		expect(lessons.map((l) => l.scope.repo).sort()).toEqual(["acme", "other"]);
	});
});

describe("fixTopic", () => {
	it("reads conventional fix scopes", () => {
		expect(fixTopic("fix(landing): redirect numbered app URLs")).toBe(
			"landing",
		);
		expect(fixTopic("Fix: broken login")).toBe("general");
		expect(fixTopic("revert catalog slug change")).toBe("general");
		expect(fixTopic("feat(mcp): new tool")).toBeNull();
		expect(fixTopic("fixture cleanup")).toBeNull();
	});
});

describe("mineLearningFeed", () => {
	it("writes one pending, unapproved lesson and supersedes the pending one", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2"), event("e3")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-old",
				reviewStatus: "pending",
				metadata: { learningFeed: { evidenceEventIds: ["e1", "e2"] } },
			},
			{
				id: "fact-confirmed",
				reviewStatus: "confirmed",
				metadata: { learningFeed: { evidenceEventIds: ["e0"] } },
			},
		] as never);

		const result = await mineLearningFeed(db, {
			orgId: "org-1",
			now: new Date("2026-10-07T12:00:00.000Z"),
		});

		expect(result).toMatchObject({ factsWritten: 1, factsSuperseded: 1 });
		expect(findCurrentFactsByTopicKey).toHaveBeenCalledWith(
			db,
			"org-1",
			"learning-feed:decision:acme:claude-code:deploy",
		);
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact).toMatchObject({
			organizationId: "org-1",
			tediId: null,
			status: "probation",
			reviewStatus: "pending",
			usePolicy: "requires_user_confirmation",
			memoryScope: "org",
			visibility: "org",
			factType: "decision",
			topicKey: "learning-feed:decision:acme:claude-code:deploy",
		});
		expect(fact.metadata).toMatchObject({
			producer: "learning-feed",
			learningFeed: {
				scope: { repo: "acme", harness: "claude-code", topic: "deploy" },
				evidenceEventIds: ["e3", "e2", "e1"],
			},
		});
		expect(invalidateFact).toHaveBeenCalledWith(
			db,
			"fact-old",
			expect.stringContaining("Superseded by"),
		);
		expect(updateFact).toHaveBeenCalledWith(db, "fact-old", {
			reviewStatus: "superseded",
		});
		expect(vi.mocked(createEdge).mock.calls[0]![1]).toMatchObject({
			targetFactId: "fact-old",
			relationType: "supersedes",
		});
	});

	it("does not churn when the pending lesson already covers every event", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-old",
				reviewStatus: "pending",
				metadata: { learningFeed: { evidenceEventIds: ["e1", "e2"] } },
			},
		] as never);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result.factsWritten).toBe(0);
		expect(createFact).not.toHaveBeenCalled();
	});

	it("records fix Work Items and proposes a directive after three", async () => {
		vi.mocked(listWorkActivity).mockResolvedValue({
			truncated: false,
			events: [
				{
					id: "ev-1",
					workItemId: "wi-1",
					workItemTitle: "fix(landing): redirect loop",
					workItemStatus: "completed",
					eventType: "work.completed",
					authorType: "external_agent",
					authorId: "agent-1",
					agentSession: "claude-code:abc",
					agentHarness: "claude-code",
					settlement: null,
					body: "",
					createdAt: "2026-10-06T10:00:00.000Z",
				},
				{
					id: "ev-2",
					workItemId: "wi-2",
					workItemTitle: "feat(landing): new hero",
					workItemStatus: "completed",
					eventType: "work.completed",
					authorType: "external_agent",
					authorId: "agent-1",
					agentSession: null,
					agentHarness: null,
					settlement: null,
					body: "",
					createdAt: "2026-10-06T11:00:00.000Z",
				},
			],
		});
		vi.mocked(recordLearningInteraction).mockResolvedValue({
			event: {} as never,
			duplicate: false,
		});
		const fix = (id: string): LearningInteractionEventRow =>
			event(id, {
				actorType: "service",
				actorId: "learning-feed",
				eventKind: "undone",
				scopeKind: "organization",
				scopeId: "org-1",
				issueKey: "agent-mistake:landing",
				surface: "work_fix",
				meta: { title: `fix(landing): ${id}` },
			});
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "work_fix"
					? [fix("f1"), fix("f2"), fix("f3")]
					: [],
		);
		vi.mocked(proposeLearningImprovement).mockResolvedValue({
			proposal: {} as never,
			duplicate: false,
		});

		const result = await mineLearningFeed(db, { orgId: "org-1" });

		expect(recordLearningInteraction).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(recordLearningInteraction).mock.calls[0]![1],
		).toMatchObject({
			organizationId: "org-1",
			actorType: "service",
			clientEventId: "work-fix:wi-1",
			eventKind: "undone",
			scopeKind: "organization",
			scopeId: "org-1",
			issueKey: "agent-mistake:landing",
			surface: "work_fix",
			targetId: "wi-1",
		});
		expect(result).toMatchObject({
			mistakeEventsRecorded: 1,
			proposalsCreated: 1,
		});
		expect(
			vi.mocked(proposeLearningImprovement).mock.calls[0]![1],
		).toMatchObject({
			organizationId: "org-1",
			issueKey: "agent-mistake:landing",
			subjectKind: "directive",
			subjectId: "agent-mistake:landing",
			proposedByType: "service",
			evidenceEventIds: ["f1", "f2", "f3"],
		});
	});

	it("leaves an issue with an open proposal alone", async () => {
		const fix = (id: string): LearningInteractionEventRow =>
			event(id, {
				eventKind: "undone",
				scopeKind: "organization",
				scopeId: "org-1",
				issueKey: "agent-mistake:landing",
				surface: "work_fix",
			});
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "work_fix"
					? [fix("f1"), fix("f2"), fix("f3")]
					: [],
		);
		vi.mocked(listLearningImprovementProposals).mockResolvedValue([
			{ status: "proposed" },
		] as never);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result.proposalsCreated).toBe(0);
		expect(proposeLearningImprovement).not.toHaveBeenCalled();
	});
});
