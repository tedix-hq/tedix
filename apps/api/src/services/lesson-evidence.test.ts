import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listCurrentLearningFeedLessons: vi.fn(),
	holdLessonForRedistillation: vi.fn(),
}));
import {
	listCurrentLearningFeedLessons,
	holdLessonForRedistillation,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { holdLessonsForCorrection } from "./lesson-evidence";
const db = {} as never;
const correction = {
	organizationId: "fictional-orchard",
	scopeKind: "personal",
	scopeId: "user-orchard",
	actorType: "user",
	actorId: "user-orchard",
	eventKind: "answered",
	occurredAt: "2026-10-02T00:00:00Z",
	metadata: {
		replyClass: "correction",
		answer: "Never use database transactions for writes; use database batches.",
		scope: { repo: "orchard" },
	},
} as LearningInteractionEventRow;
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listCurrentLearningFeedLessons).mockResolvedValue([
		{
			id: "related",
			topicKey: "learning-feed:database",
			content: "Use database transactions for writes.",
			reviewStatus: "confirmed",
			metadata: {
				learningFeed: {
					ownerUserId: "user-orchard",
					scope: { repo: "orchard" },
					lastEventAt: "2026-10-01T00:00:00Z",
				},
			},
		},
		{
			id: "other-repo",
			topicKey: "learning-feed:database",
			content: "Use database transactions for writes.",
			reviewStatus: "confirmed",
			metadata: {
				learningFeed: {
					ownerUserId: "user-orchard",
					scope: { repo: "another" },
				},
			},
		},
		{
			id: "unrelated",
			topicKey: "learning-feed:mail",
			content: "Draft email replies for review.",
			reviewStatus: "confirmed",
			metadata: { learningFeed: { ownerUserId: "user-orchard" } },
		},
	]);
});
it("holds an overlapping correction in the same owner and repo before re-distillation", async () => {
	await holdLessonsForCorrection(db, correction);
	expect(listCurrentLearningFeedLessons).toHaveBeenCalledWith(
		db,
		"fictional-orchard",
		"learning-feed:",
		500,
		"user-orchard",
	);
	expect(holdLessonForRedistillation).toHaveBeenCalledExactlyOnceWith(
		db,
		"fictional-orchard",
		"related",
		expect.any(Object),
	);
});
it("does not let another actor's signal change a person's lessons", async () => {
	await holdLessonsForCorrection(db, {
		...correction,
		actorId: "another-user",
	});
	expect(holdLessonForRedistillation).not.toHaveBeenCalled();
});
