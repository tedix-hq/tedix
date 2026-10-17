import { describe, expect, it } from "vite-plus/test";
import { buildAttention } from "./work-attention";
import type { readAttentionSources } from "@tedix/db/queries/work-attention";
const now = new Date("2026-10-17T12:00:00Z");
function sources(): Awaited<ReturnType<typeof readAttentionSources>> {
	return {
		projects: [],
		waiting: [],
		attempts: [],
		backlog: [],
		skills: [],
		runs: [],
		truncated: false,
	};
}
describe("Attention projection", () => {
	it("does not show expired leases as moving or yesterday's result as done today", () => {
		const input = sources();
		const base = {
			id: "attempt",
			workItemId: "item",
			title: "Feature",
			projectId: "project",
			session: "codex:session",
			who: "external_agent" as const,
			name: null,
			state: "running" as const,
			outcome: null,
			startedAt: "2026-10-17T09:00:00Z",
			heartbeatAt: "2026-10-17T09:00:00Z",
			expiresAt: "2026-10-17T09:05:00Z",
			finishedAt: null,
			note: null,
			runId: null,
			registeredLane: false,
		};
		input.attempts = [
			base,
			{
				...base,
				id: "stale-lane",
				registeredLane: true,
				heartbeatAt: "2026-10-17T11:56:00Z",
				expiresAt: "2026-10-17T12:01:00Z",
			},
			{
				...base,
				id: "failed-lane",
				workItemId: "retry",
				outcome: "expired",
				finishedAt: "2026-10-17T11:59:00Z",
			},
			{
				...base,
				id: "done",
				outcome: "succeeded",
				finishedAt: "2026-10-17T11:00:00Z",
			},
			{
				...base,
				id: "yesterday",
				outcome: "succeeded",
				finishedAt: "2026-10-16T11:00:00Z",
			},
		];
		input.backlog = [
			{
				id: "retry",
				title: "Retry lane",
				projectId: "project",
				createdAt: "2026-10-17T09:00:00Z",
			},
		];
		expect(
			buildAttention(input, [], [], now).cards.map((c) => [c.id, c.column]),
		).toEqual([
			["attempt", "blocked"],
			["stale-lane", "blocked"],
			["failed-lane", "blocked"],
			["done", "done"],
			["retry", "backlog"],
		]);
		input.skills = [
			{
				id: "skill-example",
				createdBy: null,
				title: "Inspect records",
				who: "Ada",
				workItemId: "item",
				projectId: "project",
				status: "completed",
				startedAt: "2026-10-17T10:00:00Z",
				finishedAt: "2026-10-17T11:00:00Z",
				heartbeatAt: null,
				note: null,
			},
		];
		expect(
			buildAttention(input, [], [], now).cards.find((c) => c.id === "attempt")
				?.activitySource,
		).toBe("local_codex");
		input.attempts[0]!.runId = "skill-example";
		expect(
			buildAttention(input, [], [], now).cards.find((c) => c.id === "attempt"),
		).toMatchObject({ activitySource: "factory", tediName: "Ada", who: "Ada" });
		input.skills[0]!.createdBy = "schedule";
		expect(
			buildAttention(input, [], [], now).cards.find((c) => c.id === "attempt")
				?.activitySource,
		).toBe("coordinator");
	});
});

it("retains Backlog when completed runs fill the overview", () => {
	const input = sources();
	input.skills = Array.from({ length: 100 }, (_, i) => ({
		id: `skill-${i}`,
		createdBy: null,
		title: "Inspect",
		who: "Ada",
		workItemId: null,
		projectId: null,
		status: "completed",
		startedAt: "2026-10-17T10:00:00Z",
		finishedAt: "2026-10-17T11:00:00Z",
		heartbeatAt: null,
		note: null,
	}));
	input.runs = Array.from({ length: 100 }, (_, i) => ({
		id: `run-${i}`,
		workspaceId: null,
		who: "Ada",
		status: "completed",
		startedAt: "2026-10-17T10:00:00Z",
		updatedAt: "2026-10-17T11:00:00Z",
		heartbeatAt: null,
		note: null,
		title: "Inspect",
	}));
	input.backlog = Array.from({ length: 100 }, (_, i) => ({
		id: `item-${i}`,
		title: "Next feature",
		projectId: null,
		createdAt: "2026-10-17T10:00:00Z",
	}));
	const result = buildAttention(input, [], [], now);
	expect(result.cards.filter((card) => card.column === "done")).toHaveLength(
		60,
	);
	expect(result.cards.filter((card) => card.column === "backlog")).toHaveLength(
		60,
	);
	expect(result.truncated).toBe(true);
});

it("keeps one persistent Waiting on you card for a human handoff", () => {
	const input = sources();
	input.waiting = [
		{
			id: "ask",
			subject: "Confirm the address",
			prompt: "Draft ready: /docs/example",
			workItemId: "item",
			projectId: "project",
			createdAt: "2026-10-15T12:00:00Z",
			creatorSession: null,
		},
	];
	const result = buildAttention(input, [], [], now);
	expect(result.cards).toMatchObject([
		{
			id: "ask",
			column: "waiting",
			href: "/work/interactions/ask",
			projectId: "project",
		},
	]);
	expect(result.cards.filter((c) => c.column === "waiting")).toHaveLength(1);
	input.waiting[0]!.creatorSession = "codex:example";
	expect(buildAttention(input, [], [], now).cards[0]?.activitySource).toBe(
		"local_codex",
	);
});

it.each([
	["codex:session", "external_agent", "Claude", "local_codex"],
	[null, "external_agent", "Codex", "unknown"],
	[null, "tedi", null, "cloud_tedi"],
] as const)(
	"uses registered source metadata for %s / %s",
	(session, who, name, expected) => {
		const input = sources();
		input.attempts = [
			{
				id: "attempt",
				workItemId: "item",
				title: "Review search",
				projectId: null,
				session,
				who,
				name,
				registeredLane: false,
				state: "running",
				outcome: null,
				startedAt: "2026-10-17T11:00:00Z",
				heartbeatAt: "2026-10-17T11:59:00Z",
				expiresAt: "2026-10-17T12:05:00Z",
				finishedAt: null,
				note: null,
				runId: null,
			},
		];
		expect(buildAttention(input, [], [], now).cards[0]?.activitySource).toBe(
			expected,
		);
	},
);

it("does not treat queued work as running or a paused skill as a request for the viewer", () => {
	const input = sources();
	input.skills = ["queued", "paused"].map((status) => ({
		id: status,
		title: "Review inbox",
		createdBy: null,
		who: null,
		workItemId: null,
		projectId: null,
		status,
		startedAt: "2026-10-17T11:00:00Z",
		finishedAt: null,
		heartbeatAt: null,
		note: null,
	}));
	const cards = buildAttention(input, [], [], now).cards;
	expect(cards.find((card) => card.id === "queued")?.column).toBe("backlog");
	expect(cards.find((card) => card.id === "paused")?.column).toBe("blocked");
});
