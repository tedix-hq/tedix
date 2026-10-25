import { describe, expect, it } from "vite-plus/test";
import {
	DELEGATION_STALL_AFTER_MS,
	delegationLiveState,
	delegationSteps,
	plainToolName,
	shortAge,
} from "@/lib/delegation-activity";

const T0 = Date.parse("2026-10-25T20:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

const run = {
	status: "running" as const,
	createdAt: at(0),
	startedAt: at(0),
	updatedAt: at(400),
	progress: {
		current: 48,
		total: 100,
		label: "Working",
		detail: "Writing the weekly summary",
	},
};

describe("plainToolName", () => {
	it("reads an app-qualified tool id as plain words", () => {
		expect(plainToolName("reddit__search_posts")).toBe("Reddit: search posts");
		expect(plainToolName("list_threads")).toBe("List threads");
		expect(plainToolName("  ")).toBe("Tool action");
	});
});

describe("delegationSteps", () => {
	it("merges a tool's start and end into one timed step, oldest first", () => {
		const steps = delegationSteps([
			{
				id: "e3",
				kind: "tool.completed",
				toolCallId: "call-1",
				payload: { name: "reddit__search_posts" },
				createdAt: at(12),
			},
			{
				id: "e1",
				kind: "tool.started",
				toolCallId: "call-1",
				payload: { name: "reddit__search_posts" },
				createdAt: at(10),
			},
			{
				id: "e4",
				kind: "tool.started",
				toolCallId: "call-2",
				payload: { name: "draft_reply" },
				createdAt: at(20),
			},
			{ id: "e0", kind: "run.started", createdAt: at(1) },
			{ id: "e5", kind: "message.delta", createdAt: at(21) },
		]);
		expect(
			steps.map((step) => [step.label, step.status, step.durationMs]),
		).toEqual([
			["Started", "completed", null],
			["Reddit: search posts", "completed", 2_000],
			["Draft reply", "running", null],
		]);
	});

	it("ignores a re-delivered event and keeps a terminal status on late starts", () => {
		const steps = delegationSteps([
			{
				id: "a",
				kind: "tool.failed",
				toolCallId: "c",
				payload: { name: "x" },
				createdAt: at(5),
			},
			{
				id: "a",
				kind: "tool.failed",
				toolCallId: "c",
				payload: { name: "x" },
				createdAt: at(5),
			},
		]);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.status).toBe("failed");
	});
});

describe("delegationLiveState", () => {
	it("reports the current step, progress and last activity of a working run", () => {
		const live = delegationLiveState({ run, now: T0 + 412_000 });
		expect(live.phase).toBe("working");
		expect(live.currentStep).toBe("Writing the weekly summary");
		expect(live.progress).toEqual({ current: 48, total: 100, percent: 48 });
		expect(live.elapsedMs).toBe(412_000);
		expect(live.idleMs).toBe(12_000);
	});

	it("counts the delegated tedi's newest event as activity", () => {
		const live = delegationLiveState({
			run: { ...run, updatedAt: at(10) },
			latestEventAt: at(600),
			now: T0 + 605_000,
		});
		expect(live.lastActivityAt).toBe(at(600));
		expect(live.phase).toBe("working");
	});

	it("flags a run with no activity past the threshold as possibly stuck", () => {
		const live = delegationLiveState({
			run,
			now: T0 + 400_000 + DELEGATION_STALL_AFTER_MS,
		});
		expect(live.phase).toBe("stalled");
		expect(shortAge(live.idleMs!)).toBe("3 min");
	});

	it("never calls a run waiting on a person stuck", () => {
		const live = delegationLiveState({
			run: { ...run, status: "requires_approval" },
			now: T0 + 3_600_000,
		});
		expect(live.phase).toBe("waiting");
	});

	it("falls back to the running tool when no progress detail is reported", () => {
		const live = delegationLiveState({
			run: { ...run, progress: undefined },
			events: [
				{
					id: "s",
					kind: "tool.started",
					toolCallId: "c",
					payload: { name: "reddit__search_posts" },
					createdAt: at(300),
				},
			],
			now: T0 + 310_000,
		});
		expect(live.currentStep).toBe("Using Reddit: search posts");
		expect(live.progress).toBeNull();
	});

	it("summarises a finished run by its duration and cost", () => {
		const live = delegationLiveState({
			run: {
				...run,
				status: "completed",
				completedAt: at(483),
				usage: {
					pricing: null,
					inputTokens: 1,
					outputTokens: 1,
					reasoningTokens: null,
					totalTokens: 2,
					costUsd: 0.0123,
				},
			},
			now: T0 + 9_999_000,
		});
		expect(live.phase).toBe("completed");
		expect(live.elapsedMs).toBe(483_000);
		expect(live.idleMs).toBeNull();
		expect(live.progress).toBeNull();
		expect(live.currentStep).toBeNull();
		expect(live.costUsd).toBe(0.0123);
	});
});
