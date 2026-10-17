import { describe, it, expect } from "vite-plus/test";
import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
import {
	rankAttention,
	attentionStatus,
	activityDuration,
	duration,
	attentionTimestamp,
	type AttentionCard,
} from "./attention";
const now = new Date("2026-10-17T12:00:00Z").getTime();
const card: AttentionCard = {
	id: "example",
	who: "Codex",
	title: "Build search",
	projectId: "search",
	column: "moving",
	startedAt: "2026-10-17T11:00:00Z",
	heartbeatAt: "2026-10-17T11:54:00Z",
	note: "Reviewing results",
	href: "/work/agents",
	source: "session",
	activitySource: "local_codex",
};
describe("Attention", () => {
	it("reads D1 timestamps as UTC on every device", () => {
		expect(attentionTimestamp("2026-10-17 12:00:00")).toBe(now);
	});
	it("puts waiting first, then pinned projects and the day's focus, then age", () => {
		const cards = [
			card,
			{ ...card, id: "waiting", column: "waiting" as const },
			{ ...card, id: "pinned", projectId: "supply" },
		];
		expect(
			rankAttention(cards, {
				...DEFAULT_ATTENTION_LAYOUT,
				pinnedProjects: ["supply"],
			}).map((c) => c.id),
		).toEqual(["waiting", "pinned", "example"]);
	});
	it("combines focus, source and hidden-column filters", () => {
		const cards = [
			card,
			{ ...card, id: "other", projectId: "supply" },
			{ ...card, id: "done", column: "done" as const },
		];
		expect(
			rankAttention(cards, {
				...DEFAULT_ATTENTION_LAYOUT,
				focusProjectId: "search",
				hiddenColumns: ["done"],
				sourceFilters: ["local_codex"],
			}).map((c) => c.id),
		).toEqual(["example"]);
	});
	it("ages heartbeats without counting silence as work or inventing offline evidence", () => {
		expect(attentionStatus(card, now)).toBe("no heartbeat for 6m");
		expect(activityDuration(card, now + 60_000)).toBe(
			activityDuration(card, now),
		);
		expect(attentionStatus({ ...card, heartbeatAt: null }, now)).toBe(
			"heartbeat not reported",
		);
		expect(attentionStatus({ ...card, column: "done" }, now)).toBe("finished");
		expect(duration(14 * 60_000 + 1000)).toBe("14m 1s");
	});
	it("clips contributions to today and freezes completed durations", () => {
		const done = {
			...card,
			finishedAt: "2026-10-17T11:30:00Z",
			column: "done" as const,
		};
		expect(activityDuration(done, now + 1000)).toBe(30 * 60_000);
		expect(activityDuration({ ...card, source: "backlog" }, now)).toBe(0);
	});
});
