import { beforeEach, expect, it, vi } from "vite-plus/test";
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteraction: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listCurrentLearningFeedLessons: vi.fn(),
	listApprovedAgentLessons: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/session-feedback", () => ({
	insertSessionFeedbackLesson: vi.fn(),
}));
import { recordLearningInteraction } from "@tedix/db/queries/learning-feedback";
import {
	listCurrentLearningFeedLessons,
	listApprovedAgentLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { insertSessionFeedbackLesson } from "@tedix/db/queries/memory-graph/session-feedback";
import { recordSessionFeedback } from "./session-feedback";
const scope = { organizationId: "fixture-org", ownerUserId: "fixture-user" };
const candidate = {
	text: "Never mention Meadow.",
	quote: "Never mention Meadow.",
	sessionKey: "fixture-claude-session",
	occurredAt: "2026-10-18T12:00:00Z",
	harness: "claude-code",
	repository: "github.com/fixture/meadow",
	kind: "correction" as const,
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([]);
	vi.mocked(listApprovedAgentLessons).mockResolvedValue([]);
	vi.mocked(recordLearningInteraction).mockResolvedValue({
		event: { id: "fixture-evidence" },
		duplicate: false,
	} as never);
	vi.mocked(insertSessionFeedbackLesson).mockImplementation(
		async (_db, fact) => fact as never,
	);
});
it("confirms owner feedback privately with cross-harness scope and canonical evidence", async () => {
	const result = await recordSessionFeedback(
		{} as never,
		scope,
		[candidate],
		async () => '{"novel":[0]}',
	);
	expect(result.lessons[0]?.status).toBe("confirmed");
	const fact = vi.mocked(insertSessionFeedbackLesson).mock.calls[0]![1];
	expect(fact.visibility).toBe("private");
	expect(fact.reviewStatus).toBe("confirmed");
	expect(fact.metadata?.learningFeed).toMatchObject({
		ownerUserId: "fixture-user",
		scope: { harness: "general" },
		evidence: {
			supportCount: 1,
			state: "live",
			sources: [
				{ id: "fixture-evidence", kind: "correction", quote: candidate.quote },
			],
		},
	});
});
it("deduplicates text and semantic paraphrases and does not admit on model failure", async () => {
	vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
		{
			id: "existing",
			content: "Never mention Meadow!",
			metadata: null,
			topicKey: "learning-feed:fixture",
			reviewStatus: "confirmed",
		},
	]);
	const model = vi.fn(async () => '{"novel":[]}');
	expect(
		(await recordSessionFeedback({} as never, scope, [candidate], model))
			.lessons[0]?.id,
	).toBe("existing");
	expect(model).not.toHaveBeenCalled();
	await recordSessionFeedback(
		{} as never,
		scope,
		[{ ...candidate, text: "Avoid mentioning Meadow." }],
		model,
	);
	expect(insertSessionFeedbackLesson).not.toHaveBeenCalled();
	await expect(
		recordSessionFeedback(
			{} as never,
			scope,
			[{ ...candidate, text: "Use short names." }],
			async () => null,
		),
	).rejects.toThrow();
});
it("project notes stay pending and a replay uses the same fact identity", async () => {
	await recordSessionFeedback(
		{} as never,
		scope,
		[{ ...candidate, kind: "project" }],
		async () => '{"novel":[0]}',
	);
	const first = vi.mocked(insertSessionFeedbackLesson).mock.calls[0]![1];
	expect(first.reviewStatus).toBe("pending");
	await recordSessionFeedback(
		{} as never,
		scope,
		[candidate],
		async () => '{"novel":[0]}',
	);
	expect(vi.mocked(insertSessionFeedbackLesson).mock.calls[1]![1].id).toBe(
		first.id,
	);
});

it("normalizes quote whitespace exactly as live evidence validation does", async () => {
	await recordSessionFeedback(
		{} as never,
		scope,
		[{ ...candidate, quote: "Never\nmention  Meadow." }],
		async () => '{"novel":[0]}',
	);
	const fact = vi.mocked(insertSessionFeedbackLesson).mock.calls[0]![1];
	expect(fact.metadata?.learningFeed).toMatchObject({
		evidence: { sources: [{ quote: "Never mention Meadow." }] },
	});
	expect(
		vi.mocked(recordLearningInteraction).mock.calls[0]![1].metadata?.answer,
	).toBe("Never mention Meadow.");
});
