import { describe, expect, it } from "vite-plus/test";
import type { AgentSessionLesson } from "@tedix/api-contract/schemas/agent-session-lessons";
import { isHoldoutSession } from "@tedix/api-contract/utils/lesson-holdout";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import { selectPromptLessons } from "../../../../packages/cli/src/hooks/lesson-selection";
import { selectSessionLessons } from "../rpc/routers/agent-session-lessons";
import { lessonDeliveryMetadata } from "./lesson-delivery";
import { summarizeLessonEffectiveness } from "./lesson-effectiveness";

const fixtures = [
	{
		id: "deploy",
		topic: "deploy",
		text: "Verify deployment health and the live revision before reporting a release.",
		prompt: "Verify deployment health and live release revision",
	},
	{
		id: "database",
		topic: "coding",
		text: "Use database batches for D1 writes and keep queries under one hundred bound parameters.",
		prompt: "Fix the database query hitting the D1 bound parameters limit",
	},
	{
		id: "mail",
		topic: "personal",
		text: "Draft email replies for review before sending a message.",
		prompt: "Draft an email message reply for review",
	},
	{
		id: "billing",
		topic: "coding",
		text: "Reconcile invoice totals and credits before changing billing balances.",
		prompt: "Reconcile invoice totals and billing credits",
	},
];
const lessons: AgentSessionLesson[] = fixtures.map((f) => ({
	id: f.id,
	shortId: f.id,
	text: f.text,
	scope: { repo: "general", harness: "general", topic: f.topic },
	updatedAt: null,
	learned: true,
}));
const rows = lessons.map((l) => ({
	id: l.id,
	content: l.text,
	priority: "active" as const,
	confidence: 0.8,
	topicKey: `learning-feed:${l.id}`,
	metadata: { learningFeed: { autoConfirmed: true, scope: l.scope } },
	createdAt: null,
	updatedAt: null,
}));
function event(
	session: string,
	at: string,
	surface: string,
	metadata: Record<string, unknown>,
): LearningInteractionEventRow {
	return {
		id: `${session}:${surface}`,
		organizationId: "fictional-orchard",
		actorType: "user",
		actorId: "fictional-user",
		scopeKind: "personal",
		scopeId: "fictional-user",
		clientEventId: `${session}:${surface}`,
		eventKind: surface === "lesson_delivery" ? "delivered" : "answered",
		signalClass: "quality",
		surface,
		threadId: session,
		occurredAt: at,
		createdAt: at,
		tediId: null,
		issueKey: null,
		targetType: null,
		targetId: null,
		runId: null,
		metadata: metadata as LearningInteractionEventRow["metadata"],
	};
}

describe("offline ranking and holdout fixture comparison", () => {
	it("runs both selectors over the same prompts and stable holdout, through lesson-effectiveness", async () => {
		const rankings = await Promise.all(
			fixtures.map(async (fixture) => ({
				prompt: fixture.prompt,
				expected: fixture.id,
				before: selectSessionLessons(rows, {
					harness: "codex",
					repo: "orchard",
					topics: ["deploy", "release"],
					budgetBytes: 3200,
				}).lessons[0]!.id,
				after: (
					await selectPromptLessons(lessons, {
						prompt: fixture.prompt,
						repo: "orchard",
						branch: "deploy-release",
						limit: 1,
					})
				).lessons[0]!.id,
			})),
		);
		const reports = [];
		for (const variant of ["before", "after"] as const) {
			const deliveries: LearningInteractionEventRow[] = [];
			const decisions: LearningInteractionEventRow[] = [];
			for (let i = 0; i < 100; i++) {
				const session = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
				const holdout = await isHoldoutSession(session);
				const fixture = rankings[i % rankings.length]!;
				const chosen = lessons.find((l) => l.id === fixture[variant])!;
				deliveries.push(
					event(
						session,
						"2026-10-01T10:00:00Z",
						"lesson_delivery",
						lessonDeliveryMetadata({
							harness: "codex",
							repo: "orchard",
							holdout,
							delivered: holdout ? [] : [chosen],
							measured: [
								{
									id: chosen.id,
									topicKey: `learning-feed:${chosen.id}`,
									subjects: ["coding"],
								},
							],
						}),
					),
				);
				// Synthetic outcome: one correction when the relevant lesson is absent.
				if (holdout || chosen.id !== fixture.expected)
					decisions.push(
						event(session, "2026-10-01T10:01:00Z", "decision_capture", {
							replyClass: "correction",
							answer: fixture.prompt,
						}),
					);
			}
			reports.push(
				summarizeLessonEffectiveness({ deliveries, decisions }).overall,
			);
		}
		expect(rankings.filter((r) => r.before === r.expected)).toHaveLength(1);
		expect(rankings.filter((r) => r.after === r.expected)).toHaveLength(4);
		expect(reports[1]!.holdout).toEqual(reports[0]!.holdout);
		expect(reports[1]!.delivered.rate).toBe(0);
		expect(reports[0]!.delivered.rate).toBeGreaterThan(0.5);
		console.info(
			"LESSON_RANKING_FIXTURE",
			JSON.stringify({
				rankings,
				before: reports[0],
				after: reports[1],
				synthetic: true,
			}),
		);
	});
});
