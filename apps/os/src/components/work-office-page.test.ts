import { describe, expect, it } from "vite-plus/test";
import {
	knockOutcome,
	knocksPerHour,
	learnedFromLine,
	lessonSubject,
	officeAsk,
	sessionActivity,
	sessionsFromKnocks,
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

	it("files an update (attention fyi) under answered, not For you", () => {
		const base = { urgent: false, open: true, answeredByYou: false };
		expect(knockOutcome({ ...base, fyi: true, draft: null })).toEqual({
			lane: "answered",
			text: "Update, nothing needed",
		});
		// A held carry-on draft does not pull the update back to For you.
		expect(
			knockOutcome({
				...base,
				fyi: true,
				draft: { delivery: null, drafter: "Chief of staff" },
			}).lane,
		).toBe("answered");
		expect(knockOutcome({ ...base, draft: null }).lane).toBe("you");
	});

	it("counts distinct sessions from captured turns", () => {
		const now = Date.parse("2026-10-08T12:30:00Z");
		const turn = (sessionId: string, requestedAt: string, host = "codex") => ({
			request: { requestedAt, metadata: { host, sessionId } },
		});
		const seen = sessionsFromKnocks([
			turn("a", "2026-10-08T12:25:00Z"),
			turn("a", "2026-10-08T09:00:00Z"),
			turn("b", "2026-10-08T09:00:00Z"),
			turn("c", "2026-10-07T23:00:00Z"),
			turn("d", "2026-10-06T09:00:00Z"),
			{ request: { requestedAt: "2026-10-08T12:29:00Z", metadata: {} } },
		]);
		expect(sessionActivity(seen, now)).toEqual({ active: 1, idle: 1 });
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
