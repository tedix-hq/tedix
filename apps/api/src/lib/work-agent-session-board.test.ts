import { describe, expect, it } from "vite-plus/test";
import {
	buildWorkAgentSessionBoard,
	buildWorkProjectContributors,
	deriveWorkAgentSessionEffectiveState,
	sanitizeWorkAgentSessionText,
} from "./work-agent-session-board";

const NOW = "2026-10-06T12:00:00.000Z";
const ago = (minutes: number) =>
	new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

describe("deriveWorkAgentSessionEffectiveState", () => {
	it.each([
		["working", 4, "working"],
		["working", 5, "idle"],
		["working", 12, "idle"],
		["done", 4, "done"],
		["done", 121, "idle"],
		["working", 13 * 60, "idle"],
		["needs_you", 4, "needs_you"],
		["needs_you", 13 * 60, "idle"],
		["error", 4, "error"],
		["error", 13 * 60, "idle"],
		["ended", 48 * 60, "ended"],
	] as const)("%s after %i minutes reads as %s", (state, minutes, expected) => {
		expect(
			deriveWorkAgentSessionEffectiveState(
				{ state, lastEventAt: ago(minutes) },
				NOW,
			),
		).toBe(expected);
	});
});

describe("buildWorkAgentSessionBoard", () => {
	it("orders by urgency, oldest needs_you first, newest first elsewhere", () => {
		const session = (
			key: string,
			state: "needs_you" | "error" | "done" | "working" | "ended",
			stateSinceMinutes: number,
			lastEventMinutes: number,
		) => ({
			key,
			state,
			stateSince: ago(stateSinceMinutes),
			lastEventAt: ago(lastEventMinutes),
		});
		const board = buildWorkAgentSessionBoard(
			[
				session("ended", "ended", 5, 5),
				session("working-new", "working", 2, 1),
				session("stale-working", "working", 90, 90),
				session("needs-new", "needs_you", 1, 1),
				session("done", "done", 10, 2),
				session("error", "error", 3, 3),
				session("needs-old", "needs_you", 20, 0),
				session("working-old", "working", 9, 4),
			],
			NOW,
		);
		expect(board.sessions.map((entry) => entry.key)).toEqual([
			"needs-old",
			"needs-new",
			"error",
			"done",
			"working-new",
			"working-old",
			"stale-working",
			"ended",
		]);
		expect(board.counts).toEqual({
			needs_you: 2,
			error: 1,
			done: 1,
			working: 2,
			idle: 1,
			ended: 1,
		});
	});

	it("counts every state as zero for an empty board", () => {
		expect(buildWorkAgentSessionBoard([], NOW)).toEqual({
			sessions: [],
			counts: {
				needs_you: 0,
				error: 0,
				done: 0,
				working: 0,
				idle: 0,
				ended: 0,
			},
		});
	});
});

describe("sanitizeWorkAgentSessionText", () => {
	it("strips control characters, collapses whitespace, and bounds length", () => {
		expect(
			sanitizeWorkAgentSessionText("a\u0000b\r\n\tc d\u009b  e", 200),
		).toBe("a b c d e");
		expect(sanitizeWorkAgentSessionText("abc def", 4)).toBe("abc");
	});
});

describe("buildWorkProjectContributors", () => {
	const NOW = "2026-10-06T12:00:00.000Z";
	const report = {
		harness: "claude-code",
		sessionKey: "abc",
		label: "ALPHA",
		state: "working" as const,
		summary: "Editing",
		workItemId: null,
		workItemTitle: null,
		lastEventAt: "2026-10-06T11:56:00.000Z",
	};
	const attempt = {
		externalSessionKey: "claude-code:abc",
		workItemId: "item-1",
		workItemTitle: "Ship alpha",
		heartbeatAt: "2026-10-06T11:50:00.000Z",
	};

	it("reads a contributor silent for over 24 hours as inactive", () => {
		const old = "2026-10-05T11:00:00.000Z";
		const rows = buildWorkProjectContributors(
			[{ ...report, state: "idle" as const, lastEventAt: old }],
			[
				{
					...attempt,
					externalSessionKey: "claude-code:attempt-only",
					heartbeatAt: old,
				},
			],
			NOW,
		);
		expect(rows.map((row) => row.state)).toEqual(["idle", "idle"]);
	});

	it("merges a session's report and Attempts into one row", () => {
		const [row, ...rest] = buildWorkProjectContributors(
			[report],
			[attempt, { ...attempt, workItemId: "item-0" }],
			NOW,
		);
		expect(rest).toEqual([]);
		expect(row).toEqual({
			sessionKey: "claude-code:abc",
			harness: "claude-code",
			name: "ALPHA",
			state: "working",
			summary: "Editing",
			lastActivityAt: "2026-10-06T11:56:00.000Z",
			workItemId: "item-1",
			workItemTitle: "Ship alpha",
			attempts: 2,
		});
	});

	it("uses a newer registered heartbeat instead of an old session report", () => {
		const [row] = buildWorkProjectContributors(
			[{ ...report, lastEventAt: ago(12) }],
			[{ ...attempt, heartbeatAt: ago(1) }],
			NOW,
		);
		expect(row).toMatchObject({ state: "working", lastActivityAt: ago(1) });
	});

	it("lists Attempt-only and ended sessions after active ones", () => {
		const rows = buildWorkProjectContributors(
			[
				{ ...report, sessionKey: "old", state: "ended", lastEventAt: NOW },
				{
					...report,
					harness: "codex",
					sessionKey: "t1",
					workItemId: "item-2",
					workItemTitle: "Review",
				},
			],
			[{ ...attempt, externalSessionKey: "codex:t2", heartbeatAt: NOW }],
			NOW,
		);
		expect(rows.map((row) => [row.sessionKey, row.state])).toEqual([
			["codex:t1", "working"],
			["claude-code:old", "ended"],
			["codex:t2", "unknown"],
		]);
		expect(rows[0]).toMatchObject({ workItemTitle: "Review", attempts: 0 });
		expect(rows[2]).toMatchObject({
			harness: "codex",
			name: "codex:t2",
			attempts: 1,
		});
	});
});
