import { describe, expect, it } from "vite-plus/test";
import { buildAttention } from "./work-attention";
import type { readAttentionSources } from "@tedix/db/queries/work-attention";
const now = new Date("2026-10-17T12:00:00Z");
function sources(): Awaited<ReturnType<typeof readAttentionSources>> {
	return {
		projects: [],
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
		};
		input.attempts = [
			base,
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
		expect(
			buildAttention(input, [], [], now).cards.map((c) => [c.id, c.column]),
		).toEqual([
			["attempt", "blocked"],
			["done", "done"],
		]);
	});
});

it("retains Backlog when completed runs fill the overview", () => {
	const input = sources();
	input.skills = Array.from({ length: 100 }, (_, i) => ({
		id: `skill-${i}`,
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
