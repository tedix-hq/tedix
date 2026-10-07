import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/learning-feedback", async (importActual) => {
	const actual =
		await importActual<typeof import("@tedix/db/queries/learning-feedback")>();
	return {
		summarizeRecurringLearningIssues: actual.summarizeRecurringLearningIssues,
		listLearningInteractionsForReflection: vi.fn(),
		listLearningIssueKeysForReflection: vi.fn(async () => []),
		listLearningInteractionsForIssueKey: vi.fn(async () => []),
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
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listStaleLearningFeedLessons: vi.fn(async () => []),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTedisByOrganization: vi.fn(async () => []),
}));
vi.mock("@tedix/db/queries/work-items/activity", () => ({
	listWorkActivity: vi.fn(async () => ({ events: [], truncated: false })),
}));

import {
	listLearningImprovementProposals,
	listLearningInteractionsForIssueKey,
	listLearningInteractionsForReflection,
	listLearningIssueKeysForReflection,
	proposeLearningImprovement,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import { listStaleLearningFeedLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import { createEdge } from "@tedix/db/queries/memory-graph/edges";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import {
	createFact,
	findCurrentFactsByTopicKey,
	updateFact,
} from "@tedix/db/queries/memory-graph/facts";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import type { Tedi } from "@tedix/db/schema/tedis";
import {
	buildDecisionLessons,
	fixTopic,
	type LessonRouter,
	mineLearningFeed,
	ROUTE_THRESHOLD,
	STALE_DAYS,
	routeCandidates,
	routingFromChoice,
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
	vi.mocked(getTedisByOrganization).mockResolvedValue([]);
	vi.mocked(listStaleLearningFeedLessons).mockResolvedValue([]);
	vi.mocked(listLearningIssueKeysForReflection).mockResolvedValue([]);
	vi.mocked(listLearningInteractionsForIssueKey).mockResolvedValue([]);
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
			ownerUserId: "user-1",
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

	it("keeps each user's decisions in their own lesson", () => {
		const lessons = buildDecisionLessons([
			event("e1"),
			event("e2"),
			event("e3", { scopeId: "user-2", actorId: "user-2" }),
			event("e4", { scopeId: "user-2", actorId: "user-2" }),
		]);
		expect(
			lessons.map((l) => [
				l.metadata.ownerUserId,
				l.metadata.learnedFromUserIds,
				l.metadata.evidenceEventIds,
			]),
		).toEqual([
			["user-1", ["user-1"], ["e2", "e1"]],
			["user-2", ["user-2"], ["e4", "e3"]],
		]);
	});

	it("words a lesson outside any repository without one", () => {
		const [lesson] = buildDecisionLessons([
			event("e1", {
				meta: {
					scope: { repo: "general", harness: "codex", topic: "pricing" },
				},
			}),
			event("e2", {
				meta: {
					scope: { repo: "general", harness: "codex", topic: "pricing" },
				},
			}),
		]);
		expect(lesson?.content.split("\n")[0]).toBe(
			"Lessons from user decisions (codex, pricing):",
		);
	});
});

function tedi(id: string, over: Partial<Tedi> = {}): Tedi {
	return {
		id,
		organizationId: "org-1",
		scope: "organization",
		ownerUserId: null,
		retiredAt: null,
		name: id,
		slug: id,
		displayName: null,
		tags: null,
		personality: null,
		...over,
	} as Tedi;
}

describe("routing", () => {
	it("routes only at or above the threshold, to a known candidate", () => {
		const options = new Map([["t1", "tedi-eng"]]);
		expect(
			routingFromChoice(
				{ choice: "t1", probabilities: { t1: ROUTE_THRESHOLD } },
				options,
			),
		).toMatchObject({ status: "routed", tediId: "tedi-eng" });
		expect(
			routingFromChoice(
				{ choice: "t1", probabilities: { t1: ROUTE_THRESHOLD - 0.01 } },
				options,
			),
		).toMatchObject({ status: "personal", tediId: null });
		expect(
			routingFromChoice(
				{ choice: "none", probabilities: { none: 0.99 } },
				options,
			),
		).toMatchObject({ status: "personal", tediId: null });
		expect(routingFromChoice(null, options)).toMatchObject({
			status: "unavailable",
			tediId: null,
		});
	});

	it("offers only this organization's live shared tedis and the owner's own", () => {
		const candidates = routeCandidates(
			[
				tedi("shared"),
				tedi("other-org", { organizationId: "org-2" }),
				tedi("retired", { retiredAt: "2026-10-01" }),
				tedi("mine", { scope: "personal", ownerUserId: "user-1" }),
				tedi("theirs", { scope: "personal", ownerUserId: "user-2" }),
			],
			"org-1",
			"user-1",
		);
		expect(candidates.map((t) => t.id)).toEqual(["shared", "mine"]);
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

describe("historic session imports", () => {
	const imported = (id: string, occurredAt: string) =>
		event(id, {
			surface: "agent_session_import",
			clientEventId: `agent-session-import:${id}`,
			occurredAt,
		});

	it("walks imported scopes outside the 30-day window, one scope at a time", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockResolvedValue([]);
		vi.mocked(listLearningIssueKeysForReflection).mockResolvedValue([
			"decision:acme:claude-code:deploy",
		]);
		vi.mocked(listLearningInteractionsForIssueKey).mockResolvedValue([
			imported("h1", "2025-01-01T10:00:00.000Z"),
			imported("h2", "2025-02-01T10:00:00.000Z"),
		]);
		const result = await mineLearningFeed(db, {
			orgId: "org-1",
			now: new Date("2026-10-07T12:00:00.000Z"),
		});
		expect(result.factsWritten).toBe(1);
		expect(listLearningInteractionsForIssueKey).toHaveBeenCalledWith(db, {
			organizationId: "org-1",
			issueKey: "decision:acme:claude-code:deploy",
			surfaces: ["decision_capture", "agent_session_import"],
			limit: 40,
		});
		expect(vi.mocked(createFact).mock.calls[0]![1].metadata).toMatchObject({
			learningFeed: { evidenceEventIds: ["h2", "h1"] },
		});
	});

	it("writes distilled rules in place of quotes", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockResolvedValue([]);
		vi.mocked(listLearningIssueKeysForReflection).mockResolvedValue([
			"decision:acme:claude-code:deploy",
		]);
		vi.mocked(listLearningInteractionsForIssueKey).mockResolvedValue([
			imported("h1", "2025-01-01T10:00:00.000Z"),
			imported("h2", "2025-02-01T10:00:00.000Z"),
		]);
		const distill = vi.fn(async () => ["Never deploy on Fridays."]);
		await mineLearningFeed(db, { orgId: "org-1", distill });
		expect(vi.mocked(distill).mock.calls[0]![0]).toMatchObject({
			scope: { repo: "acme", harness: "claude-code", topic: "deploy" },
		});
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact.content).toBe(
			"Lessons from user decisions in acme (claude-code, deploy):\n- Never deploy on Fridays.",
		);
		expect(fact.metadata).toMatchObject({ learningFeed: { distilled: 2 } });
	});

	it("rewrites a lesson from an earlier distiller once, then leaves the distilled one alone", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockResolvedValue([]);
		vi.mocked(listLearningIssueKeysForReflection).mockResolvedValue([
			"decision:acme:claude-code:deploy",
		]);
		vi.mocked(listLearningInteractionsForIssueKey).mockResolvedValue([
			imported("h1", "2025-01-01T10:00:00.000Z"),
			imported("h2", "2025-02-01T10:00:00.000Z"),
		]);
		const lesson = (distilled: number | undefined) => ({
			id: "fact-1",
			reviewStatus: "confirmed",
			metadata: {
				learningFeed: {
					evidenceEventIds: ["h2", "h1"],
					autoConfirmed: true,
					...(distilled ? { distilled } : {}),
				},
			},
		});
		const distill = vi.fn(async () => ["Never deploy on Fridays."]);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			lesson(1),
		] as never);
		expect(
			(await mineLearningFeed(db, { orgId: "org-1", distill })).factsWritten,
		).toBe(1);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			lesson(2),
		] as never);
		distill.mockClear();
		expect(
			(await mineLearningFeed(db, { orgId: "org-1", distill })).factsWritten,
		).toBe(0);
		expect(distill).not.toHaveBeenCalled();
	});

	it("retires the miner's lesson when nothing lasting is left", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockResolvedValue([]);
		vi.mocked(listLearningIssueKeysForReflection).mockResolvedValue([
			"decision:acme:claude-code:deploy",
		]);
		vi.mocked(listLearningInteractionsForIssueKey).mockResolvedValue([
			imported("h1", "2025-01-01T10:00:00.000Z"),
			imported("h2", "2025-02-01T10:00:00.000Z"),
			imported("h3", "2025-03-01T10:00:00.000Z"),
		]);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-quotes",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { evidenceEventIds: ["h1", "h2"], autoConfirmed: true },
				},
			},
		] as never);
		const result = await mineLearningFeed(db, {
			orgId: "org-1",
			distill: async () => [],
		});
		expect(result.factsWritten).toBe(0);
		expect(createFact).not.toHaveBeenCalled();
		expect(invalidateFact).toHaveBeenCalledWith(
			db,
			"fact-quotes",
			expect.stringContaining("No lasting rule"),
		);
	});
});

describe("mineLearningFeed", () => {
	it("writes one active lesson at once and supersedes the miner's earlier ones", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2"), event("e3")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-old",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { autoConfirmed: true, evidenceEventIds: ["e1", "e2"] },
				},
			},
			{
				id: "fact-pending",
				reviewStatus: "pending",
				metadata: { learningFeed: { evidenceEventIds: ["e1"] } },
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

		expect(result).toMatchObject({ factsWritten: 1, factsSuperseded: 2 });
		expect(findCurrentFactsByTopicKey).toHaveBeenCalledWith(
			db,
			"org-1",
			"learning-feed:decision:acme:claude-code:deploy:user:user-1",
		);
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact).toMatchObject({
			organizationId: "org-1",
			tediId: null,
			status: "active",
			reviewStatus: "confirmed",
			usePolicy: "requires_user_confirmation",
			memoryScope: "org",
			visibility: "private",
			factType: "decision",
			topicKey: "learning-feed:decision:acme:claude-code:deploy:user:user-1",
		});
		expect(fact.metadata).toMatchObject({
			producer: "learning-feed",
			learningFeed: {
				scope: { repo: "acme", harness: "claude-code", topic: "deploy" },
				evidenceEventIds: ["e3", "e2", "e1"],
				ownerUserId: "user-1",
				autoConfirmed: true,
			},
		});
		// A person's own review is never replaced.
		expect(vi.mocked(invalidateFact).mock.calls.map((call) => call[1])).toEqual(
			["fact-old", "fact-pending"],
		);
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

	it("does not churn when the active lesson already covers every event", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-old",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { autoConfirmed: true, evidenceEventIds: ["e1", "e2"] },
				},
			},
		] as never);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result.factsWritten).toBe(0);
		expect(createFact).not.toHaveBeenCalled();
	});

	it("activates a lesson left pending before auto-confirmation", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-pending",
				reviewStatus: "pending",
				metadata: { learningFeed: { evidenceEventIds: ["e1", "e2"] } },
			},
		] as never);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result).toMatchObject({ factsWritten: 1, factsSuperseded: 1 });
		expect(vi.mocked(createFact).mock.calls[0]![1]).toMatchObject({
			status: "active",
			reviewStatus: "confirmed",
		});
	});

	it("leaves a hand-reviewed lesson alone and does not relearn its events", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockResolvedValue([
			{
				id: "fact-reviewed",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { autoConfirmed: true, evidenceEventIds: ["e1", "e2"] },
					memoryLifecycle: { lastReview: { reviewStatus: "confirmed" } },
				},
			},
		] as never);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result.factsWritten).toBe(0);
		expect(invalidateFact).not.toHaveBeenCalled();
	});

	it("archives the miner's lessons with no supporting decision for STALE_DAYS", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockResolvedValue([]);
		vi.mocked(listStaleLearningFeedLessons).mockResolvedValue([
			{
				id: "fact-stale",
				reviewStatus: "confirmed",
				metadata: { learningFeed: { autoConfirmed: true } },
			},
			{
				id: "fact-kept",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { autoConfirmed: true },
					memoryLifecycle: { lastReview: { reviewStatus: "confirmed" } },
				},
			},
		]);
		const now = new Date("2026-10-07T12:00:00.000Z");
		const result = await mineLearningFeed(db, { orgId: "org-1", now });
		expect(listStaleLearningFeedLessons).toHaveBeenCalledWith(
			db,
			"org-1",
			"learning-feed:decision:",
			new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString(),
		);
		expect(result.factsArchived).toBe(1);
		expect(updateFact).toHaveBeenCalledTimes(1);
		expect(updateFact).toHaveBeenCalledWith(db, "fact-stale", {
			archivedAt: now.toISOString(),
		});
	});

	it("keeps an event without a personal scope org-wide", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [
							event("e1", { scopeKind: "organization", scopeId: "org-1" }),
							event("e2", { scopeKind: "organization", scopeId: "org-1" }),
						]
					: [],
		);
		await mineLearningFeed(db, { orgId: "org-1" });
		expect(vi.mocked(createFact).mock.calls[0]![1]).toMatchObject({
			tediId: null,
			memoryScope: "org",
			visibility: "org",
			topicKey: "learning-feed:decision:acme:claude-code:deploy",
		});
	});

	it("does not relearn events a reviewed pre-personal lesson covers", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(findCurrentFactsByTopicKey).mockImplementation(
			async (_db, _org, topicKey) =>
				topicKey === "learning-feed:decision:acme:claude-code:deploy"
					? ([
							{
								id: "fact-legacy",
								reviewStatus: "confirmed",
								metadata: { learningFeed: { evidenceEventIds: ["e1", "e2"] } },
							},
						] as never)
					: [],
		);
		const result = await mineLearningFeed(db, { orgId: "org-1" });
		expect(result.factsWritten).toBe(0);
	});

	it("routes a lesson into the owning tedi's brain", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(getTedisByOrganization).mockResolvedValue([
			tedi("tedi-eng", { tags: ["engineering"] }),
			tedi("tedi-fin", { tags: ["finance"] }),
		]);
		const route = vi.fn<LessonRouter>(async () => ({
			status: "routed",
			tediId: "tedi-eng",
			probability: 0.9,
			model: "@cf/cloudflare/clef-flash",
		}));
		const result = await mineLearningFeed(db, { orgId: "org-1", route });
		expect(route.mock.calls[0]![1].map((t) => t.id)).toEqual([
			"tedi-eng",
			"tedi-fin",
		]);
		expect(result.factsRoutedToTedi).toBe(1);
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact).toMatchObject({
			organizationId: "org-1",
			tediId: "tedi-eng",
			memoryScope: "tedi",
			visibility: "private",
			reviewStatus: "confirmed",
		});
		expect(fact.metadata).toMatchObject({
			learningFeed: {
				ownerUserId: "user-1",
				routing: { status: "routed", tediId: "tedi-eng" },
			},
		});
	});

	it("stays personal when the router is unsure, fails or names a stranger", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e2")]
					: [],
		);
		vi.mocked(getTedisByOrganization).mockResolvedValue([tedi("tedi-eng")]);
		const routers: LessonRouter[] = [
			async () => ({
				status: "personal",
				tediId: null,
				probability: 0.4,
				model: "@cf/cloudflare/clef-flash",
			}),
			async () => {
				throw new Error("AI binding down");
			},
			async () => ({
				status: "routed",
				tediId: "tedi-of-org-2",
				probability: 0.99,
				model: "@cf/cloudflare/clef-flash",
			}),
		];
		for (const route of routers) {
			vi.mocked(createFact).mockClear();
			const result = await mineLearningFeed(db, { orgId: "org-1", route });
			expect(result.factsRoutedToTedi).toBe(0);
			expect(vi.mocked(createFact).mock.calls[0]![1]).toMatchObject({
				tediId: null,
				visibility: "private",
				memoryScope: "org",
			});
		}
	});

	it("never mixes organizations", async () => {
		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [
							event("e1"),
							event("e2", { organizationId: "org-2" }),
							event("e3", { organizationId: "org-2" }),
						]
					: [],
		);
		vi.mocked(getTedisByOrganization).mockResolvedValue([
			tedi("tedi-other", { organizationId: "org-2" }),
		]);
		const route = vi.fn<LessonRouter>();
		const result = await mineLearningFeed(db, { orgId: "org-1", route });
		// Only org-1's single decision remains, which alone teaches nothing.
		expect(result.decisionEventsScanned).toBe(1);
		expect(createFact).not.toHaveBeenCalled();
		expect(listLearningInteractionsForReflection).toHaveBeenCalledWith(
			db,
			expect.objectContaining({ organizationId: "org-1" }),
		);

		vi.mocked(listLearningInteractionsForReflection).mockImplementation(
			async (_db, input) =>
				input.surfaces[0] === "decision_capture"
					? [event("e1"), event("e4"), event("e2", { organizationId: "org-2" })]
					: [],
		);
		await mineLearningFeed(db, { orgId: "org-1", route });
		// A foreign tedi is never offered, so nothing is routed.
		expect(route).not.toHaveBeenCalled();
		const fact = vi.mocked(createFact).mock.calls[0]![1];
		expect(fact).toMatchObject({ organizationId: "org-1", tediId: null });
		expect(fact.metadata).toMatchObject({
			learningFeed: { evidenceEventIds: ["e4", "e1"] },
		});
		for (const call of vi.mocked(findCurrentFactsByTopicKey).mock.calls)
			expect(call[1]).toBe("org-1");
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
