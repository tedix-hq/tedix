import { expect, test } from "bun:test";
import type { AgentSessionLesson } from "@tedix/api-contract/schemas/agent-session-lessons";
import { isHoldoutSession } from "@tedix/api-contract/utils/lesson-holdout";
import { selectPromptLessons } from "./lesson-selection";

const fixtureLessons: AgentSessionLesson[] = [
	{
		id: "deploy",
		shortId: "deploy00",
		text: "Verify deployment health and the live revision before reporting a release.",
		scope: { repo: "orchard", harness: "general", topic: "deploy" },
		updatedAt: null,
		learned: true,
	},
	{
		id: "database",
		shortId: "database",
		text: "Use database batches for D1 writes; keep every query under one hundred bound parameters.",
		scope: { repo: "orchard", harness: "general", topic: "coding" },
		updatedAt: null,
		learned: true,
	},
	{
		id: "mail",
		shortId: "mail0000",
		text: "Draft email replies for review before sending a message.",
		scope: { repo: "general", harness: "general", topic: "personal" },
		updatedAt: null,
		learned: true,
	},
	{
		id: "billing",
		shortId: "billing0",
		text: "Reconcile invoice totals and credits before changing billing balances.",
		scope: { repo: "orchard", harness: "general", topic: "coding" },
		updatedAt: null,
		learned: true,
	},
];

test("the current prompt outranks misleading branch words", async () => {
	const selected = await selectPromptLessons(fixtureLessons, {
		prompt: "Fix the database query hitting the D1 bound parameters limit",
		branch: "deploy-release",
		limit: 1,
	});
	expect(selected.lessons.map((l) => l.id)).toEqual(["database"]);
});
test("Work title and cwd contribute when the prompt is short", async () => {
	expect(
		(
			await selectPromptLessons(fixtureLessons, {
				prompt: "Fix this",
				workTitle: "Reconcile invoice totals and credits",
				cwd: "/work/orchard/billing",
				limit: 1,
			})
		).lessons[0]?.id,
	).toBe("billing");
});
test("uses UTF-8 bytes and at most six lessons", async () => {
	const selected = await selectPromptLessons(
		[...fixtureLessons, ...fixtureLessons],
		{ budgetBytes: 200, limit: 6 },
	);
	expect(selected.lessons.length).toBeLessThanOrEqual(6);
	expect(
		selected.lessons.reduce((n, l) => n + Buffer.byteLength(l.text) + 16, 0),
	).toBeLessThanOrEqual(200);
});
test("the local holdout uses the server's exact stable assignment", async () => {
	const id = "00000000-0000-4000-8000-000000000001";
	const selected = await selectPromptLessons(fixtureLessons, {
		prompt: "Fix D1 database queries",
		sessionId: id,
	});
	expect(selected.holdout).toBe(await isHoldoutSession(id));
	expect(selected.selectedLessonIds.length).toBeGreaterThan(0);
	if (selected.holdout) expect(selected.lessons).toEqual([]);
});
