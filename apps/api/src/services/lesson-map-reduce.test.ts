import type { DbClient } from "@tedix/db/client";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/learning-feedback", () => ({
	listLearningOwnersForReflection: vi.fn(),
	listOwnerLearningInteractionsPage: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listCurrentLearningFeedLessons: vi.fn(async () => []),
	listArchivedLearningFeedLessonsForOwner: vi.fn(async () => []),
}));
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
	updateFact: vi.fn(async () => undefined),
}));
vi.mock("./lesson-distiller", async (importActual) => ({
	...(await importActual<typeof import("./lesson-distiller")>()),
	runDistillModel: vi.fn(),
}));

import {
	listLearningOwnersForReflection,
	listOwnerLearningInteractionsPage,
} from "@tedix/db/queries/learning-feedback";
import {
	listArchivedLearningFeedLessonsForOwner,
	listCurrentLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { invalidateFact } from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { createFact, updateFact } from "@tedix/db/queries/memory-graph/facts";
import { responseText, runDistillModel } from "./lesson-distiller";
import {
	CHUNK_REPLIES,
	chunkCandidates,
	distillPersonalLessons,
	lastingRules,
	MAP_REDUCE_VERSION,
	mergedFromResponse,
	planLessons,
	settle,
	type RuleCandidate,
	type StepRunner,
	usableReply,
} from "./lesson-map-reduce";

const db = {} as DbClient;
const env = {} as never;
const direct: StepRunner = (_name, _config, body) => body();

function event(
	n: number,
	answer: string,
	over: Partial<LearningInteractionEventRow> & { repo?: string } = {},
): LearningInteractionEventRow {
	const { repo = "tedix", ...rest } = over;
	return {
		id: `ev-${String(n).padStart(5, "0")}`,
		organizationId: "org-1",
		actorType: "user",
		actorId: "user-1",
		tediId: null,
		clientEventId: `agent-session-import:${n}`,
		signalClass: "quality",
		eventKind: "answered",
		scopeKind: "personal",
		scopeId: "user-1",
		issueKey: `decision:${repo}:claude-code:instruction`,
		surface: "agent_session_import",
		targetType: "agent_session_turn",
		targetId: `turn-${n}`,
		threadId: `session-${n % 40}`,
		runId: null,
		metadata: {
			scope: { repo, harness: "claude-code", topic: "instruction" },
			answer,
			replyClass: null,
		} as LearningInteractionEventRow["metadata"],
		occurredAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
		createdAt: "2026-10-07T10:00:00.000Z",
		...rest,
	};
}

function candidate(over: Partial<RuleCandidate>): RuleCandidate {
	return {
		rule: "Commit straight to main and never open pull requests",
		subject: "git",
		eventIds: ["a"],
		sessions: ["s1"],
		repos: ["tedix"],
		newestAt: "2026-10-01T00:00:00.000Z",
		standing: false,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([]);
	vi.mocked(listArchivedLearningFeedLessonsForOwner).mockResolvedValue([]);
});

describe("usableReply", () => {
	it("keeps the person's own words and drops noise", () => {
		expect(
			usableReply(event(1, "Always commit straight to main, no PRs please.")),
		).toMatchObject({ session: "session-1", repo: "tedix", standing: true });
		expect(usableReply(event(2, "ok go"))).toBeNull();
		expect(
			usableReply(event(3, "Reply only with the word OK, this is a test")),
		).toBeNull();
		expect(
			usableReply(event(4, "<command-name>/clear</command-name> stuff here")),
		).toBeNull();
		expect(
			usableReply({
				...event(5, "Ship it now and tell me when it is done."),
				surface: "decision_capture",
				metadata: {
					answer: "Ship it now and tell me when done.",
					replyClass: "continue",
				},
			}),
		).toBeNull();
	});
});

describe("chunkCandidates", () => {
	const replies = [
		usableReply(event(1, "commit straight to main, never open a PR"))!,
		usableReply(event(2, "again: commit to main directly, no pull request"))!,
		usableReply(event(3, "send the invoice of 300 EUR to the client"))!,
	];

	it("reads subject, rule and cited replies", () => {
		const [rule] = chunkCandidates(
			"- git: Commit straight to main, never open a PR [1, 2]",
			replies,
		)!;
		expect(rule).toMatchObject({
			subject: "git",
			rule: "Commit straight to main, never open a PR",
			sessions: ["session-1", "session-2"],
			repos: ["tedix"],
			standing: true,
		});
	});

	it("drops invented, uncited and money rules", () => {
		expect(
			chunkCandidates(
				[
					"- coding: Prefer Rust for every new service [1]",
					"- git: Commit to main [9]",
					"- personal: Send invoices of 300 EUR to clients [3]",
				].join("\n"),
				replies,
			),
		).toEqual([]);
		expect(chunkCandidates("NONE", replies)).toEqual([]);
	});
});

describe("reduce", () => {
	it("merges by meaning, counts sessions and keeps lasting rules", () => {
		const candidates = [
			candidate({ sessions: ["s1"], eventIds: ["a"] }),
			candidate({
				rule: "Push to main; do not open PRs",
				sessions: ["s2"],
				eventIds: ["b"],
			}),
			candidate({
				rule: "Use the blue button once",
				subject: "coding",
				sessions: ["s3"],
				eventIds: ["c"],
			}),
		];
		const merged = mergedFromResponse(
			[
				"- git: Commit straight to main, never open pull requests [1, 2]",
				"- coding: Use the blue button once [3]",
			].join("\n"),
			candidates,
		)!;
		const kept = lastingRules(merged);
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			subject: "git",
			sessions: ["s1", "s2"],
			eventIds: ["a", "b"],
		});
	});

	it("never learns a rule to bypass deploys or checks, or to wait for approval", () => {
		expect(
			lastingRules(
				[
					"Deploy manually; keep CI disabled",
					"Ship to production without waiting for verification",
					"Ask for next priorities or clarification before proceeding",
				].map((rule) => candidate({ rule, sessions: ["s1", "s2"] })),
			),
		).toEqual([]);
	});

	it("never relearns a rule a person archived", () => {
		expect(
			lastingRules(
				[candidate({ sessions: ["s1", "s2"] })],
				["Commit straight to main, never open pull requests"],
			),
		).toEqual([]);
	});
});

describe("settle", () => {
	it("orders by importance, slots unordered rules by support and fades stale thin ones", () => {
		const rules = settle([
			candidate({ rule: "Second", rank: 1, sessions: ["a", "b"] }),
			candidate({ rule: "First", rank: 0, sessions: ["a", "b", "c", "d"] }),
			candidate({ rule: "Unordered", sessions: ["a", "b", "c"] }),
			candidate({
				rule: "Stale and thin",
				rank: 2,
				sessions: ["a", "b"],
				newestAt: "2026-07-01T00:00:00.000Z",
			}),
			candidate({
				rule: "Stale but widely stated",
				rank: 3,
				sessions: ["a", "b", "c", "d", "e"],
				newestAt: "2026-07-01T00:00:00.000Z",
			}),
		]);
		expect(rules.map((r) => r.rule)).toEqual([
			"First",
			"Second",
			"Unordered",
			"Stale but widely stated",
		]);
	});

	it("reads both Workers AI answer shapes", () => {
		expect(responseText({ response: "a" })).toBe("a");
		expect(responseText({ choices: [{ message: { content: "b" } }] })).toBe(
			"b",
		);
		expect(responseText({})).toBeNull();
	});
});

describe("planLessons", () => {
	it("puts cross-subject rules in the standing lesson and repo rules in the repo", () => {
		const lessons = planLessons("user-1", [
			candidate({ sessions: ["s1", "s2", "s3"] }),
			// Less supported than the agents rule, still first: it shapes every reply.
			candidate({
				rule: "Answer short in plain English with one recommendation",
				subject: "communication",
				sessions: ["s1", "s2"],
			}),
			candidate({
				rule: "Call the workers tedis",
				subject: "agents",
				sessions: ["s1", "s2", "s3", "s4", "s5"],
			}),
			// More git rules than the repository's standing lesson holds.
			...Array.from({ length: 10 }, (_, n) =>
				candidate({
					rule: `Git habit ${n} here`,
					sessions: ["s1", "s2"],
					eventIds: [`g${n}`],
				}),
			),
		]);
		expect(lessons.map((l) => [l.topicKey, l.rules.length])).toEqual([
			["learning-feed:decision:general:general:standing:user:user-1", 2],
			["learning-feed:decision:tedix:general:standing:user:user-1", 8],
			["learning-feed:decision:tedix:general:git:user:user-1", 3],
		]);
		expect(lessons[0]!.content.split("\n")[1]).toBe(
			"- Answer short in plain English with one recommendation",
		);
		expect(lessons[1]!.content.split("\n").slice(0, 2)).toEqual([
			"How the user works in tedix:",
			"- Commit straight to main and never open pull requests",
		]);
		expect(lessons[2]!.scope).toEqual({
			repo: "tedix",
			harness: "general",
			topic: "git",
		});
		for (const lesson of lessons)
			expect(lesson.content.length).toBeLessThanOrEqual(
				lesson.standing ? 450 : 600,
			);
	});
});

describe("distillPersonalLessons", () => {
	const RULES: Array<[RegExp, string]> = [
		[/main/, "git: Commit straight to main, never open pull requests"],
		[/short/, "communication: Answer short with one recommendation"],
	];
	/** Fake distiller: cites every reply that mentions a rule's keyword. */
	function fakeModel(prompt: string): string {
		const lines = prompt.split("\n");
		if (prompt.startsWith("Below are candidate rules")) {
			const out = RULES.map(([pattern, rule]) => {
				const cites = lines
					.filter((line) => /^\[\d+\]/.test(line) && pattern.test(line))
					.map((line) => Number(/^\[(\d+)\]/.exec(line)![1]));
				return cites.length ? `- ${rule} [${cites.join(", ")}]` : "";
			});
			return out.filter(Boolean).join("\n") || "NONE";
		}
		const out = RULES.map(([pattern, rule]) => {
			const cites = lines
				.filter((line) => /^\[\d+\]/.test(line) && pattern.test(line))
				.map((line) => Number(/^\[(\d+)\]/.exec(line)![1]));
			return cites.length ? `- ${rule} [${cites.slice(0, 5).join(", ")}]` : "";
		});
		return out.filter(Boolean).join("\n") || "NONE";
	}

	const history = Array.from({ length: 400 }, (_, i) =>
		event(
			400 - i,
			i % 2
				? "commit to main please, never open pull requests here"
				: "keep it short, answer with one recommendation",
		),
	);

	beforeEach(() => {
		vi.mocked(listLearningOwnersForReflection).mockResolvedValue([
			{
				ownerUserId: "user-1",
				events: history.length,
				newestAt: history[0]!.occurredAt,
			},
		]);
		vi.mocked(listOwnerLearningInteractionsPage).mockImplementation(
			async (_db, input) => {
				const start = input.before
					? history.findIndex((e) => e.id === input.before!.id) + 1
					: 0;
				return history.slice(start, start + input.limit);
			},
		);
		vi.mocked(runDistillModel).mockImplementation(async (_env, prompt) =>
			fakeModel(prompt),
		);
	});

	it("reads the whole history in chunks and writes standing and subject lessons", async () => {
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
			{
				id: "old-repo-lesson",
				topicKey: "learning-feed:decision:tedix:general:general:user:user-1",
				content: "Lessons:\n- old",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { autoConfirmed: true, ownerUserId: "user-1" },
				},
			},
			{
				id: "reviewed",
				topicKey: "learning-feed:decision:acme:general:general:user:user-1",
				content: "Lessons:\n- Never deploy on Fridays",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { ownerUserId: "user-1", evidenceEventIds: [] },
					memoryLifecycle: { lastReview: { reviewStatus: "confirmed" } },
				},
			},
		]);
		const result = await distillPersonalLessons(direct, db, env, "org-1");
		expect(result).toMatchObject({
			owners: 1,
			chunks: Math.ceil(history.length / CHUNK_REPLIES),
			repliesRead: history.length,
			chunksFailed: 0,
			lessonsWritten: 2,
			lessonsSuperseded: 1,
		});
		const facts = vi.mocked(createFact).mock.calls.map((call) => call[1]);
		expect(facts.map((f) => f.topicKey)).toEqual([
			"learning-feed:decision:general:general:standing:user:user-1",
			"learning-feed:decision:tedix:general:standing:user:user-1",
		]);
		expect(facts[0]).toMatchObject({
			status: "active",
			reviewStatus: "confirmed",
			visibility: "private",
			priority: "core",
		});
		expect(facts[0]!.content).toContain(
			"- Answer short with one recommendation",
		);
		expect(facts[0]!.metadata).toMatchObject({
			learningFeed: {
				hoisted: true,
				ownerUserId: "user-1",
				autoConfirmed: true,
				mapReduce: { version: MAP_REDUCE_VERSION, events: 400, complete: true },
			},
		});
		expect(facts[1]!.content).toBe(
			"How the user works in tedix:\n- Commit straight to main, never open pull requests",
		);
		// The person's own review is never superseded.
		expect(vi.mocked(invalidateFact).mock.calls.map((c) => c[1])).toEqual([
			"old-repo-lesson",
		]);
	});

	it("does nothing when the history is unchanged since a complete run", async () => {
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
			{
				id: "standing",
				topicKey: "learning-feed:decision:general:general:standing:user:user-1",
				content: "How the user works:\n- x",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: {
						autoConfirmed: true,
						ownerUserId: "user-1",
						mapReduce: {
							version: MAP_REDUCE_VERSION,
							events: 400,
							newestAt: history[0]!.occurredAt,
							complete: true,
						},
					},
				},
			},
		]);
		const result = await distillPersonalLessons(direct, db, env, "org-1");
		expect(result.ownersSkipped).toBe(1);
		expect(runDistillModel).not.toHaveBeenCalled();
		expect(createFact).not.toHaveBeenCalled();
	});

	it("keeps an identical lesson instead of rewriting it", async () => {
		await distillPersonalLessons(direct, db, env, "org-1");
		const written = vi.mocked(createFact).mock.calls.map((call) => call[1]);
		vi.mocked(createFact).mockClear();
		vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue(
			written.map((fact) => ({
				id: fact.id,
				topicKey: fact.topicKey ?? null,
				content: fact.content,
				reviewStatus: "confirmed",
				metadata: {
					...(fact.metadata as object),
					learningFeed: {
						...(fact.metadata as { learningFeed: object }).learningFeed,
						mapReduce: { version: 0 },
					},
				} as never,
			})),
		);
		const result = await distillPersonalLessons(direct, db, env, "org-1");
		expect(result).toMatchObject({
			lessonsWritten: 0,
			lessonsKept: 2,
			lessonsSuperseded: 0,
		});
		expect(createFact).not.toHaveBeenCalled();
		expect(updateFact).toHaveBeenCalledTimes(2);
	});

	it("never relearns what a person archived, and keeps lessons when the model fails", async () => {
		vi.mocked(listArchivedLearningFeedLessonsForOwner).mockResolvedValue([
			{
				id: "archived",
				topicKey: "learning-feed:decision:tedix:general:git:user:user-1",
				content: "Git:\n- Commit straight to main, never open pull requests",
				reviewStatus: "confirmed",
				metadata: {
					learningFeed: { ownerUserId: "user-1", autoConfirmed: true },
					memoryLifecycle: { lastReview: { archived: true } },
				},
			},
		]);
		await distillPersonalLessons(direct, db, env, "org-1");
		const facts = vi.mocked(createFact).mock.calls.map((call) => call[1]);
		expect(facts.map((f) => f.content).join("\n")).not.toContain("main");

		vi.mocked(createFact).mockClear();
		vi.mocked(runDistillModel).mockResolvedValue(null);
		const failed = await distillPersonalLessons(direct, db, env, "org-1");
		expect(failed.chunksFailed).toBe(failed.chunks);
		expect(createFact).not.toHaveBeenCalled();
		expect(invalidateFact).not.toHaveBeenCalled();
	});
});
