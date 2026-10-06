import { describe, it, expect } from "vite-plus/test";
import { buildPlan } from "./plan";
import {
	localMidnight,
	type CalendarRoute,
	type Configuration,
	type CalendarEvent,
	type Snapshot,
	type Mirror,
} from "./types";
const route = (key: string): CalendarRoute => ({
	key,
	adapter: "google",
	providerId: "provider",
	connectionScope: "tenant",
	connectionInstanceId: "account",
	calendarId: key,
	workspaceResourceId: key,
});
const window = { start: "2026-10-01T00:00:00Z", end: "2026-10-10T00:00:00Z" };
const interval = { start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" };
const config: Configuration = {
	id: "config",
	workspaceId: "workspace",
	organizationId: "org",
	ownerUserId: "owner",
	revision: 1,
	mode: "preview",
	timeZone: "UTC",
	window,
	tediId: "worker",
	skillId: "skill",
	skillRevision: 1,
	calendars: [route("a"), route("b")],
	actions: [],
};
const event: CalendarEvent = {
	id: "original",
	revision: "r1",
	sourceIdentity: "series:2026-10-03T10:00:00Z",
	interval,
	busy: true,
	cancelled: false,
	privateBlocker: false,
	ownership: null,
};
const snapshot = (key: string, events: CalendarEvent[] = []): Snapshot => ({
	route: route(key),
	complete: true,
	events,
	calendar: {
		id: key,
		name: key,
		timeZone: "UTC",
		canRead: true,
		canWrite: true,
		ownerEmail: null,
		conditionalWrites: true,
	},
	errors: [],
});
describe("complete calendar preview", () => {
	it("mirrors one busy occurrence privately into only the other calendar with stable identity across moves", async () => {
		const first = await buildPlan(
			config,
			[snapshot("a", [event]), snapshot("b")],
			[],
			"seed",
		);
		expect(first.actions).toHaveLength(1);
		const moved = await buildPlan(
			config,
			[
				snapshot("a", [
					{
						...event,
						interval: {
							start: "2026-10-04T10:00:00Z",
							end: "2026-10-04T11:00:00Z",
						},
					},
				]),
				snapshot("b"),
			],
			[],
			"seed",
		);
		expect(first.actions[0]!.sourceKey).toBe(moved.actions[0]!.sourceKey);
		expect(first.actions[0]!.ownership).toBe(moved.actions[0]!.ownership);
	});
	it("does no writes or cleanup from incomplete pagination", async () => {
		const partial = { ...snapshot("a", [event]), complete: false };
		const p = await buildPlan(config, [partial, snapshot("b")], [], "seed");
		expect(p.complete).toBe(false);
		expect(p.actions).toEqual([]);
	});
	it("ignores cancelled, free and declined normalized events", async () => {
		const p = await buildPlan(
			config,
			[
				snapshot("a", [
					{ ...event, busy: false },
					{ ...event, id: "cancel", cancelled: true },
				]),
				snapshot("b"),
			],
			[],
			"seed",
		);
		expect(p.actions).toEqual([]);
	});
	it("never treats marker or Busy title as ownership proof and never mirrors a blocker", async () => {
		const p = await buildPlan(
			config,
			[snapshot("a", [{ ...event, ownership: "forged" }]), snapshot("b")],
			[],
			"seed",
		);
		expect(p.actions).toEqual([]);
		expect(p.conflicts[0]).toContain("unverified blocker");
	});
	it("updates only unchanged ledger-owned mirrors and deletes only explicit cancelled occurrences", async () => {
		const p = await buildPlan(
			config,
			[snapshot("a", [event]), snapshot("b")],
			[],
			"seed",
		);
		const a = p.actions[0]!;
		const mirror: Mirror = {
			id: "m",
			sourceKey: a.sourceKey,
			sourceRouteKey: "a",
			sourceEventId: event.id,
			destinationKey: "b",
			eventId: a.destinationEventId,
			revision: "d1",
			privateBlocker: true,
			ownership: a.ownership,
			interval,
		};
		const destination = {
			...event,
			id: mirror.eventId,
			revision: mirror.revision,
			privateBlocker: true,
			ownership: mirror.ownership,
		};
		const missing = await buildPlan(
			config,
			[snapshot("a"), snapshot("b", [destination])],
			[mirror],
			"seed",
		);
		expect(missing.actions).toEqual([]);
		const cancelled = await buildPlan(
			config,
			[
				snapshot("a", [{ ...event, cancelled: true }]),
				snapshot("b", [destination]),
			],
			[mirror],
			"seed",
		);
		expect(cancelled.actions[0]!.kind).toBe("delete");
		const moved = await buildPlan(
			config,
			[
				snapshot("a", [
					{
						...event,
						interval: {
							start: "2026-10-04T10:00:00Z",
							end: "2026-10-04T11:00:00Z",
						},
					},
				]),
				snapshot("b", [destination]),
			],
			[mirror],
			"seed",
		);
		expect(moved.actions[0]!.kind).toBe("update");
		const changed = await buildPlan(
			config,
			[
				snapshot("a", [{ ...event, cancelled: true }]),
				snapshot("b", [{ ...destination, revision: "user-edit" }]),
			],
			[mirror],
			"seed",
		);
		expect(changed.actions).toEqual([]);
		expect(changed.conflicts.length).toBeGreaterThan(0);
	});
	it("resolves all-day boundaries across DST with exclusive local-date end", () => {
		expect(
			Date.parse(localMidnight("2026-03-30", "Europe/Berlin")) -
				Date.parse(localMidnight("2026-03-29", "Europe/Berlin")),
		).toBe(23 * 3600_000);
		expect(
			Date.parse(localMidnight("2026-10-26", "Europe/Berlin")) -
				Date.parse(localMidnight("2026-10-25", "Europe/Berlin")),
		).toBe(25 * 3600_000);
	});
});

describe("rolling owner-approved horizon", () => {
	it("advances on calendar-local midnight and keeps one local day through DST", async () => {
		const { effectiveCalendarConfiguration, approvedRollingDays } =
			await import("./types");
		const rolling = {
			...config,
			windowMode: "rolling" as const,
			rollingDays: 1,
			timeZone: "Europe/Berlin",
		};
		const spring = effectiveCalendarConfiguration(
			rolling,
			new Date("2026-03-29T09:00:00Z"),
		);
		expect(spring.window.start).toBe("2026-03-28T23:00:00.000Z");
		expect(spring.window.end).toBe("2026-03-29T22:00:00.000Z");
		expect(
			Date.parse(spring.window.end) - Date.parse(spring.window.start),
		).toBe(23 * 3600_000);
		const autumn = effectiveCalendarConfiguration(
			rolling,
			new Date("2026-10-25T09:00:00Z"),
		);
		expect(
			Date.parse(autumn.window.end) - Date.parse(autumn.window.start),
		).toBe(25 * 3600_000);
		expect(approvedRollingDays(spring.window, "Europe/Berlin")).toBe(1);
		expect(approvedRollingDays(autumn.window, "Europe/Berlin")).toBe(1);
	});
	it("preserves an explicitly fixed window and rejects unapproved oversized horizons", async () => {
		const { effectiveCalendarConfiguration } = await import("./types");
		expect(
			effectiveCalendarConfiguration(
				{ ...config, windowMode: "fixed" },
				new Date("2027-01-01T00:00:00Z"),
			).window,
		).toEqual(config.window);
		expect(() =>
			effectiveCalendarConfiguration({ ...config, rollingDays: 91 }),
		).toThrow("approved rolling horizon");
	});
});
