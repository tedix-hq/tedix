import type {
	SkillWorkflowRunTimeline,
	SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

vi.mock("@/lib/os-query-options", () => ({
	workflowRunTimelineQueryOptions: (runId: string) => ({
		queryKey: ["timeline", runId],
		queryFn: async () => ({}),
	}),
	workflowRunArtifactQueryOptions: (runId: string, path: string) => ({
		queryKey: ["artifact", runId, path],
		queryFn: async () => null,
	}),
}));
import { RunTimelineChart } from "./run-timeline";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const start = Date.parse("2026-11-01T09:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
function event(
	id: string,
	lane: string,
	from: number,
	to: number,
	outcome: SkillWorkflowTimelineEvent["outcome"] = "success",
) {
	return {
		schemaVersion: 1,
		id,
		path: id,
		executionEpoch: 1,
		kind: "mcp",
		name: id,
		count: 1,
		attempt: 1,
		phase: "run",
		lane,
		namespace: lane,
		method: "call",
		startedAt: at(from),
		endedAt: at(to),
		durationMs: (to - from) * 1000,
		status: outcome === "failure" ? "failed" : "succeeded",
		outcome,
	} as SkillWorkflowTimelineEvent;
}
const timeline = {
	run: {
		id: "run-1",
		status: "completed",
		startedAt: at(0),
		completedAt: at(100),
	},
	lanes: [
		{ id: "step", label: "step" },
		{ id: "search", label: "search" },
	],
	events: [
		event("setup", "step", 0, 10),
		event("search-0", "search", 20, 30),
		event("search-1", "search", 60, 70, "failure"),
	],
	coverage: "complete",
	warnings: [],
} as unknown as SkillWorkflowRunTimeline;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const bar = (id: string) =>
	host.querySelector<HTMLElement>(`[data-timeline-event="${id}"] [data-hue]`);
const button = (name: string) =>
	[...host.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === name,
	)!;

describe("RunTimelineChart", () => {
	it("gives each row its own color and keeps failures red", () => {
		act(() => root.render(<RunTimelineChart timeline={timeline} />));
		expect(bar("setup")!.dataset.hue).toBe("blue");
		expect(bar("search-0")!.dataset.hue).toBe("violet");
		expect(bar("search-1")!.dataset.hue).toBe("red");
	});

	it("replays from the start and shows every step again on Show all", () => {
		act(() => root.render(<RunTimelineChart timeline={timeline} />));
		act(() => button("Replay").click());
		expect(host.querySelector("[data-replay-playhead]")).not.toBeNull();
		expect(bar("setup")).not.toBeNull();
		expect(bar("search-0")).toBeNull();
		expect(bar("search-1")).toBeNull();
		act(() => button("Pause").click());
		act(() => button("Show all").click());
		expect(host.querySelector("[data-replay-playhead]")).toBeNull();
		expect(bar("search-1")).not.toBeNull();
	});
});
