import { describe, expect, it } from "vite-plus/test";
import {
	buildWorkAgentSessionBoard,
	deriveWorkAgentSessionEffectiveState,
	sanitizeWorkAgentSessionText,
} from "./work-agent-session-board";

const NOW = "2026-10-06T12:00:00.000Z";
const ago = (minutes: number) =>
	new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

describe("deriveWorkAgentSessionEffectiveState", () => {
	it.each([
		["working", 29, "working"],
		["working", 31, "idle"],
		["done", 119, "done"],
		["done", 121, "idle"],
		["needs_you", 23 * 60, "needs_you"],
		["needs_you", 25 * 60, "idle"],
		["error", 25 * 60, "idle"],
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
				session("done", "done", 10, 10),
				session("error", "error", 3, 3),
				session("needs-old", "needs_you", 20, 0),
				session("working-old", "working", 9, 9),
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
