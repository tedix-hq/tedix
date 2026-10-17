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
});
