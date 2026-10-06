import { describe, expect, it } from "vite-plus/test";
import {
	AGING_CEILING,
	computeAgingScore,
	computeUrgencyScore,
	parseSchedulerInstant,
	resolveSchedulerDueAt,
	URGENCY_LAPSED_FLOOR,
	URGENCY_PEAK,
} from "./scheduler";

const NOW = "2026-08-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

const priorityScore = {
	critical: 100,
	high: 70,
	medium: 40,
	low: 10,
} as const;
const riskPenalty = { low: 0, medium: 5, high: 15, critical: 30 } as const;

/**
 * The exact ranking contribution the scheduler assigns from an item's dates,
 * priority, and risk. Mirrors the `factors` sum in `listReadyWork` for the
 * factors a date-only comparison exercises; graph, cost, and verification
 * factors are zero for unlinked work.
 */
function rankScore(item: {
	priority: keyof typeof priorityScore;
	riskLevel: keyof typeof riskPenalty;
	dueDate?: string | null;
	deadline?: string | null;
	createdAt: string;
}) {
	return (
		priorityScore[item.priority] +
		computeUrgencyScore(
			resolveSchedulerDueAt({
				deadline: item.deadline ?? null,
				dueDate: item.dueDate ?? null,
			}),
			NOW_MS,
		) +
		computeAgingScore(parseSchedulerInstant(item.createdAt), NOW_MS) -
		riskPenalty[item.riskLevel]
	);
}

describe("scheduler instant parsing", () => {
	it("parses ISO and loose-but-real timestamps", () => {
		expect(parseSchedulerInstant("2026-05-31T20:44:00Z")).toBe(
			Date.parse("2026-05-31T20:44:00Z"),
		);
		expect(parseSchedulerInstant("2026-05-31 15:42 UTC")).toBe(
			Date.parse("2026-05-31 15:42 UTC"),
		);
	});

	it("returns null for the free-text due dates production actually stores", () => {
		for (const value of [
			"immediately",
			"today",
			"now",
			"Friday",
			"next scheduled cycle",
			"~10 minutes of wall clock",
			"",
			null,
			undefined,
		])
			expect(parseSchedulerInstant(value)).toBeNull();
	});

	it("falls back from an unparseable deadline to a parseable due date", () => {
		expect(
			resolveSchedulerDueAt({
				deadline: "as soon as possible",
				dueDate: "2026-09-01T00:00:00Z",
			}),
		).toBe(Date.parse("2026-09-01T00:00:00Z"));
	});
});

describe("urgency scoring", () => {
	it("never scores an unparseable due date as urgent", () => {
		const urgency = computeUrgencyScore(
			resolveSchedulerDueAt({ deadline: null, dueDate: "immediately" }),
			NOW_MS,
		);
		expect(Number.isFinite(urgency)).toBe(true);
		expect(urgency).toBe(0);
		expect(urgency).toBeLessThan(URGENCY_PEAK);
	});

	it("peaks on the due instant and is continuous across it", () => {
		expect(computeUrgencyScore(NOW_MS, NOW_MS)).toBe(URGENCY_PEAK);
		expect(computeUrgencyScore(NOW_MS - 1, NOW_MS)).toBeCloseTo(
			URGENCY_PEAK,
			4,
		);
		expect(computeUrgencyScore(NOW_MS + 25 * DAY_MS, NOW_MS)).toBe(0);
	});

	it("decays a lapsed deadline toward a bounded floor instead of pinning the peak", () => {
		const oneDay = computeUrgencyScore(NOW_MS - DAY_MS, NOW_MS);
		const twoWeeks = computeUrgencyScore(NOW_MS - 14 * DAY_MS, NOW_MS);
		const threeMonths = computeUrgencyScore(NOW_MS - 86 * DAY_MS, NOW_MS);
		expect(oneDay).toBeGreaterThan(twoWeeks);
		expect(twoWeeks).toBeGreaterThan(threeMonths);
		expect(twoWeeks).toBeCloseTo(
			URGENCY_LAPSED_FLOOR + (URGENCY_PEAK - URGENCY_LAPSED_FLOOR) / 2,
			6,
		);
		// Still above work that asserted no deadline at all: ranked, not hidden.
		expect(threeMonths).toBeGreaterThan(computeUrgencyScore(null, NOW_MS));
		expect(threeMonths).toBeLessThan(URGENCY_LAPSED_FLOOR + 1);
	});

	it("stays finite when `now` itself is unparseable", () => {
		expect(computeUrgencyScore(NOW_MS, Number.NaN)).toBe(0);
		expect(computeAgingScore(NOW_MS, Number.NaN)).toBe(0);
	});
});

describe("aging fairness", () => {
	it("is bounded and ignores an unparseable creation timestamp", () => {
		expect(computeAgingScore(NOW_MS - 7 * DAY_MS, NOW_MS)).toBeCloseTo(1, 6);
		expect(computeAgingScore(NOW_MS - 5000 * DAY_MS, NOW_MS)).toBe(
			AGING_CEILING,
		);
		expect(computeAgingScore(parseSchedulerInstant("someday"), NOW_MS)).toBe(0);
	});
});

describe("rank composition", () => {
	it("does not let a three-month-dead deadline outrank live high-priority work", () => {
		// medium/medium, deadline 2026-05-31, created the same day, no project,
		// no dependencies: without decay this ranked first.
		const stale = rankScore({
			priority: "medium",
			riskLevel: "medium",
			deadline: "2026-05-31 15:42 UTC",
			dueDate: "2026-05-31 15:42 UTC",
			createdAt: "2026-05-31T15:42:00.000Z",
		});
		const live = rankScore({
			priority: "high",
			riskLevel: "medium",
			deadline: "2026-09-14T12:00:00.000Z",
			createdAt: "2026-08-18T12:00:00.000Z",
		});
		expect(stale).toBeLessThan(live);
		// It is still ranked and still scores above zero — eligible, not hidden.
		expect(stale).toBeGreaterThan(0);
	});

	it("keeps a genuinely just-missed deadline ahead of the same work on time", () => {
		const justOverdue = rankScore({
			priority: "medium",
			riskLevel: "medium",
			deadline: "2026-08-24T12:00:00.000Z",
			createdAt: "2026-08-18T12:00:00.000Z",
		});
		const dueLater = rankScore({
			priority: "medium",
			riskLevel: "medium",
			deadline: "2026-09-10T12:00:00.000Z",
			createdAt: "2026-08-18T12:00:00.000Z",
		});
		expect(justOverdue).toBeGreaterThan(dueLater);
	});

	it("does not let free-text urgency beat a real imminent deadline", () => {
		const freeText = rankScore({
			priority: "high",
			riskLevel: "medium",
			dueDate: "immediately",
			createdAt: "2026-08-18T12:00:00.000Z",
		});
		const imminent = rankScore({
			priority: "high",
			riskLevel: "medium",
			deadline: "2026-08-26T12:00:00.000Z",
			createdAt: "2026-08-18T12:00:00.000Z",
		});
		expect(freeText).toBeLessThan(imminent);
	});
});
