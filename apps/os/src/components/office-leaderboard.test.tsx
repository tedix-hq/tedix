import { describe, expect, it } from "vite-plus/test";
import {
	formatReplyTime,
	levelLabel,
	levelProgressText,
	startOfWeek,
} from "./office-leaderboard";

describe("office leaderboard", () => {
	it("starts the week at local Monday midnight", () => {
		const thursday = new Date(2026, 9, 8, 15, 30);
		expect(startOfWeek(thursday)).toBe(new Date(2026, 9, 5).toISOString());
		const sunday = new Date(2026, 9, 11, 9);
		expect(startOfWeek(sunday)).toBe(new Date(2026, 9, 5).toISOString());
	});

	it("formats mean reply time in plain units", () => {
		expect(formatReplyTime(null)).toBe("—");
		expect(formatReplyTime(42)).toBe("42 s");
		expect(formatReplyTime(185)).toBe("3 min");
		expect(formatReplyTime(5400)).toBe("1.5 h");
	});

	it("labels the career stage as a level with progress to the next", () => {
		expect(levelLabel("shadow")).toBe("Level 1 · Shadow");
		const level = {
			stage: "apprentice" as const,
			nextStage: "operator" as const,
			stood: 12,
			corrected: 1,
			target: 25,
			minStandingRate: 0.9,
			streakDays: 3,
		};
		expect(levelProgressText(level)).toBe("12 of 25 replies to Operator");
		expect(levelProgressText({ ...level, stood: 30 })).toBe(
			"25 of 25 replies to Operator",
		);
		expect(
			levelProgressText({ ...level, nextStage: null, target: null }),
		).toBeNull();
	});
});
