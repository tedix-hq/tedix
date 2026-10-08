import { describe, expect, it } from "vite-plus/test";
import {
	knocksPerHour,
	learnedFromLine,
	lessonSubject,
	officeAsk,
} from "./work-office-page";

describe("office helpers", () => {
	it("prefers the needed-from-you line and strips the waiting prefix", () => {
		expect(
			officeAsk({ subject: "x", metadata: { neededFromYou: " Approve it " } }),
		).toBe("Approve it");
		expect(officeAsk({ subject: "tedix · codex waiting: Ship it?" })).toBe(
			"Ship it?",
		);
	});

	it("groups lessons by subject with Answers as the default", () => {
		expect(lessonSubject("Commit and push to main")).toBe("Git");
		expect(lessonSubject("Deploy through Ship")).toBe("Deploys");
		expect(lessonSubject("Answer in plain English")).toBe("Answers");
	});

	it("counts replies in plain words", () => {
		expect(learnedFromLine({ replies: 1 })).toBe("Learned from 1 reply");
		expect(learnedFromLine(null)).toBeNull();
	});

	it("buckets knocks into the last 24 hours, oldest first", () => {
		const now = Date.parse("2026-10-08T12:30:00Z");
		const hours = knocksPerHour(
			["2026-10-08T12:10:00Z", "2026-10-08T10:45:00Z", "2026-10-06T12:00:00Z"],
			now,
		);
		expect(hours).toHaveLength(24);
		expect(hours[23]).toBe(1);
		expect(hours[22]).toBe(1);
		expect(hours.reduce((a, b) => a + b, 0)).toBe(2);
	});
});
