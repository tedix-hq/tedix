import { describe, expect, it } from "vite-plus/test";
import {
	compareDeckPriority,
	deckBandCounts,
	deckPriority,
	deckTimeline,
} from "./deck-priority";
import { projectDeckCards } from "./deck-projection";
import type * as z from "zod";
import type { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";

// Friday 7 November 2026, 15:00 in Berlin.
const now = new Date("2026-11-07T14:00:00Z");
const zone = "Europe/Berlin";

describe("deckPriority", () => {
	it("explains the top factor in plain words", () => {
		expect(deckPriority({ blocks: 5 }, now, zone)).toMatchObject({
			factor: "blocks",
			reason: "Blocks 5 tasks",
			band: "week",
		});
		expect(deckPriority({ blocks: 1 }, now, zone).reason).toBe("Blocks 1 task");
		expect(
			deckPriority({ workDeadline: "2026-11-17" }, now, zone),
		).toMatchObject({
			factor: "deadline",
			reason: "Due Tue 17 Nov",
			deadline: "2026-11-17",
		});
		expect(deckPriority({ costs: true }, now, zone)).toMatchObject({
			factor: "cost",
			reason: "Costs money",
			band: "week",
		});
		expect(
			deckPriority({ deadline: "2026-11-03T09:00:00Z" }, now, zone),
		).toMatchObject({
			factor: "overdue",
			reason: "Overdue since Tue 3 Nov",
			band: "today",
		});
		expect(
			deckPriority({ requestedAt: "2026-11-01T14:00:00Z" }, now, zone),
		).toMatchObject({ factor: "waiting", reason: "Waiting 6 days" });
		expect(deckPriority({}, now, zone)).toMatchObject({
			factor: "none",
			reason: "Nothing waits on it",
			band: "whenever",
			score: 0,
		});
	});

	it("bands by deadline within 48 hours or blocking running work", () => {
		const band = (input: Parameters<typeof deckPriority>[0]) =>
			deckPriority(input, now, zone).band;
		// Due the end of Sunday: within 48 hours of Friday afternoon.
		expect(band({ deadline: "2026-11-08" })).toBe("today");
		expect(band({ deadline: "2026-11-09T12:00:00Z" })).toBe("today");
		expect(band({ deadline: "2026-11-10T12:00:00Z" })).toBe("week");
		expect(band({ blocksRunning: true })).toBe("today");
		expect(band({ deadline: "2026-11-13" })).toBe("week");
		expect(band({ deadline: "2026-11-20" })).toBe("whenever");
		expect(band({ riskLevel: "high" })).toBe("week");
		expect(band({ critical: true })).toBe("week");
		expect(band({ objective: { top: true } })).toBe("week");
		expect(band({ objective: { top: false } })).toBe("whenever");
	});

	it("uses the earlier of the ask's and its Work's deadline", () => {
		const priority = deckPriority(
			{ deadline: "2026-11-30", workDeadline: "2026-11-17" },
			now,
			zone,
		);
		expect(priority.deadline).toBe("2026-11-17");
	});

	it("ranks a Demo Day deadline above routine reminders and keeps learned score a tiebreak", () => {
		const demoDay = deckPriority(
			{ workDeadline: "2026-11-17", requestedAt: "2026-11-06T09:00:00Z" },
			now,
			zone,
		);
		const reminder = deckPriority(
			{ requestedAt: "2026-11-06T09:00:00Z", learnedScore: 50 },
			now,
			zone,
		);
		expect(compareDeckPriority(demoDay, reminder)).toBeLessThan(0);
		const a = deckPriority({ blocks: 2, learnedScore: 0.5 }, now, zone);
		const b = deckPriority({ blocks: 2, learnedScore: -0.5 }, now, zone);
		const c = deckPriority({ blocks: 3, learnedScore: -1 }, now, zone);
		expect(compareDeckPriority(a, b)).toBeLessThan(0);
		expect(compareDeckPriority(c, a)).toBeLessThan(0);
	});

	it("weighs more blocked tasks, running blocked work and a sooner deadline higher", () => {
		const score = (input: Parameters<typeof deckPriority>[0]) =>
			deckPriority(input, now, zone).score;
		expect(score({ blocks: 5 })).toBeGreaterThan(score({ blocks: 2 }));
		expect(score({ blocks: 2, blocksRunning: true })).toBeGreaterThan(
			score({ blocks: 2 }),
		);
		expect(score({ deadline: "2026-11-08T08:00:00Z" })).toBeGreaterThan(
			score({ deadline: "2026-11-08T20:00:00Z" }),
		);
		expect(score({ riskLevel: "critical" })).toBeGreaterThan(
			score({ riskLevel: "high" }),
		);
		// An out-of-range factory score is ignored.
		expect(score({ factoryScore: 7 })).toBe(0);
		expect(score({ factoryScore: 0.5 })).toBe(5);
	});
});

describe("bands and timeline", () => {
	const cards = [
		{ id: "late", label: "Late", deadline: "2026-11-02" },
		{ id: "sunday", label: "Sunday", deadline: "2026-11-08" },
		{ id: "demo", label: "Demo Day", deadline: "2026-11-17" },
		{ id: "far", label: "Far", deadline: "2026-12-20" },
		{ id: "none", label: "None", deadline: null },
	].map((card) => ({
		...card,
		priority: deckPriority({ deadline: card.deadline }, now, zone),
	}));

	it("counts each band", () => {
		expect(deckBandCounts(cards)).toEqual({ today: 2, week: 0, whenever: 3 });
	});

	it("shows deadlines in the next 14 days with overdue on the left", () => {
		expect(
			deckTimeline(cards, now, zone).map(({ id, day, overdue }) => [
				id,
				day,
				overdue,
			]),
		).toEqual([
			["late", -1, true],
			["sunday", 1, false],
			["demo", 10, false],
		]);
	});
});

describe("projectDeckCards priority", () => {
	type Row = z.infer<typeof WorkInteractionInboxRowSchema>;
	const row = (id: string, patch: Partial<Row> = {}): Row =>
		({
			request: {
				id,
				kind: "question",
				subject: `Fictional ask ${id}?`,
				prompt: "Pick one fictional option.",
				metadata: {},
				requestedFromType: "user",
				requestedAt: "2026-11-06T10:00:00.000Z",
				dueAt: null,
				projectId: null,
				workItemId: null,
			},
			effectiveState: "open",
			canRespond: true,
			...patch,
		}) as Row;

	it("orders asks by the shared score and sets a reason on each", () => {
		const cards = projectDeckCards({
			requests: [
				row("reminder"),
				row("blocker", {
					sourceWork: {
						dueDate: null,
						deadline: null,
						riskLevel: "medium",
						blocksCount: 5,
						blocksRunning: false,
					},
				}),
				row("demo", {
					sourceWork: {
						dueDate: "2026-11-08",
						deadline: null,
						riskLevel: "low",
						blocksCount: 0,
						blocksRunning: false,
					},
				}),
			],
			work: [],
			runtime: [],
			now,
			timeZone: zone,
		});
		expect(
			cards.map((card) => [
				card.id,
				card.priority?.band,
				card.priority?.reason,
			]),
		).toEqual([
			["demo", "today", "Due Sun 8 Nov"],
			["blocker", "week", "Blocks 5 tasks"],
			["reminder", "whenever", "Waiting 1 day"],
		]);
	});
});
