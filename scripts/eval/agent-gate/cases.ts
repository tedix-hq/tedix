import type { AgentSessionLesson } from "@tedix/api-contract/schemas/agent-session-lessons";

const lesson = (id: string, text: string): AgentSessionLesson => ({
	id,
	shortId: id,
	text,
	scope: { repo: "fictional", harness: "general", topic: "coding" },
	updatedAt: null,
});

const operations = [
	lesson(
		"deploy",
		"Verify deployment health and the live revision before reporting a release.",
	),
	lesson(
		"database",
		"Use database batches for D1 writes and bound parameters.",
	),
	lesson(
		"billing",
		"Reconcile invoice totals and credits before changing billing balances.",
	),
];
const releases = [0, 1, 10, 19, 29].map((n) =>
	lesson(
		`lantern-${n}`,
		`Lantern-${n} releases require violet-channel-${n} and a signed receipt.`,
	),
);

// Task shapes come from the public lesson-selection tests, never live memory rows.
export const cases = [
	...[0, 1, 10, 19, 29].map((n) => ({
		id: `numbered-release-${n}`,
		lessons: releases,
		context: {
			prompt: `Prepare Lantern-${n} release with violet-channel-${n}.`,
			limit: 1,
		},
		expected: [`lantern-${n}`],
	})),
	{
		id: "short-database-name",
		lessons: [
			lesson("d1", "D1 database writes"),
			lesson("d2", "D2 database writes"),
		],
		context: { prompt: "D2 database", limit: 1 },
		expected: ["d2"],
	},
	{
		id: "database-over-branch",
		lessons: operations,
		context: {
			prompt: "Fix the database query hitting the D1 bound parameters limit",
			branch: "deploy-release",
			limit: 1,
		},
		expected: ["database"],
	},
	{
		id: "short-prompt-work-title",
		lessons: operations,
		context: {
			prompt: "Fix this",
			workTitle: "Reconcile invoice totals and credits",
			limit: 1,
		},
		expected: ["billing"],
	},
	{
		id: "utf8-budget",
		lessons: [
			lesson("oversize", "é".repeat(100)),
			lesson("small", "database batches"),
		],
		context: { prompt: "database", budgetBytes: 50, limit: 1 },
		expected: ["small"],
	},
];
