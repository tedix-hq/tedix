import { describe, it, expect, vi } from "vite-plus/test";
import { applyPlan, compensateBlocker, type ApplyStore } from "./apply";
import { buildPlan } from "./plan";
import type {
	CalendarAdapter,
	CalendarEvent,
	CalendarRoute,
	Configuration,
	Mutation,
	Snapshot,
} from "./types";
function fixture() {
	const route = (key: string): CalendarRoute => ({
		key,
		adapter: "google",
		providerId: "p",
		connectionScope: "tenant",
		connectionInstanceId: "slot",
		calendarId: key,
		workspaceResourceId: key,
	});
	const config: Configuration = {
		id: "c",
		organizationId: "o",
		workspaceId: "w",
		ownerUserId: "u",
		revision: 1,
		mode: "active",
		timeZone: "UTC",
		window: { start: "2026-10-01T00:00:00Z", end: "2026-10-10T00:00:00Z" },
		tediId: "t",
		skillId: "s",
		skillRevision: 1,
		calendars: [route("a"), route("b")],
		actions: ["create", "update", "delete"],
	};
	const event: CalendarEvent = {
		id: "source",
		sourceIdentity: "source",
		revision: "s1",
		interval: { start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" },
		privateBlocker: false,
		ownership: null,
		busy: true,
		cancelled: false,
	};
	const events = new Map<string, CalendarEvent[]>([
		["a", [event]],
		["b", []],
	]);
	const snapshot = (r: CalendarRoute): Snapshot => ({
		route: r,
		complete: true,
		events: events.get(r.key)!,
		calendar: {
			id: r.key,
			name: r.key,
			timeZone: "UTC",
			canRead: true,
			canWrite: true,
			conditionalWrites: true,
			ownerEmail: null,
		},
		errors: [],
	});
	const adapter: CalendarAdapter = {
		kind: "google",
		conditionalWrites: true,
		listCalendars: vi.fn(),
		snapshot: vi.fn(async (r) => snapshot(r)),
		get: vi.fn(
			async (r, id) => events.get(r.key)!.find((e) => e.id === id) ?? null,
		),
		findOwned: vi.fn(async (r, marker) =>
			events.get(r.key)!.filter((e) => e.ownership === marker),
		),
		create: vi.fn(async (r, a) => {
			const result = {
				...event,
				id: a.destinationEventId,
				sourceIdentity: a.destinationEventId,
				revision: "d1",
				privateBlocker: true,
				ownership: a.ownership,
				interval: a.after!,
			};
			events.get(r.key)!.push(result);
		}),
		update: vi.fn(),
		remove: vi.fn(),
	};
	const journal = new Map<string, Mutation>();
	const store: ApplyStore = {
		guard: vi.fn(async () => {}),
		previous: async () => [...journal.values()],
		record: vi.fn(async (m) => {
			journal.set(m.actionId, { ...m });
		}),
		mirror: vi.fn(async () => {}),
	};
	return {
		config,
		event,
		events,
		adapter,
		store,
		journal,
		snapshots: config.calendars.map(snapshot),
		adapters: new Map([
			["a", adapter],
			["b", adapter],
		]),
	};
}
describe("calendar apply journal and provider fences", () => {
	it("writes durable intent, independently reads back, and retains confirmed work on retry", async () => {
		const f = fixture();
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		expect((await applyPlan(f.config, p, f.adapters, f.store)).outcome).toBe(
			"confirmed",
		);
		expect(f.adapter.create).toHaveBeenCalledTimes(1);
		expect(f.store.mirror).toHaveBeenCalledTimes(1);
		await applyPlan(f.config, p, f.adapters, f.store);
		expect(f.adapter.create).toHaveBeenCalledTimes(1);
	});
	it("recovers a persisted timeout by unique private ownership without duplicate creation", async () => {
		const f = fixture();
		const create = f.adapter.create;
		f.adapter.create = vi.fn(async (r, a) => {
			await create(r, a);
			throw new Error("timeout after persistence");
		});
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		expect((await applyPlan(f.config, p, f.adapters, f.store)).outcome).toBe(
			"confirmed",
		);
		expect(f.adapter.create).toHaveBeenCalledTimes(1);
	});
	it("holds ambiguous writes and never blindly retries an absent marker", async () => {
		const f = fixture();
		f.adapter.create = vi.fn(async () => {
			throw new Error("ambiguous timeout");
		});
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		expect(
			(await applyPlan(f.config, p, f.adapters, f.store)).mutations[0]!.state,
		).toBe("uncertain");
		await applyPlan(f.config, p, f.adapters, f.store);
		expect(f.adapter.create).toHaveBeenCalledTimes(1);
	});
	it("detects a new conflicting source or destination event after preview before any write", async () => {
		const f = fixture();
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		f.events.get("b")!.push({ ...f.event, id: "other" });
		await expect(applyPlan(f.config, p, f.adapters, f.store)).rejects.toThrow(
			"changed since preview",
		);
		expect(f.adapter.create).not.toHaveBeenCalled();
	});
	it("refuses inactive or stale config and revoked authority", async () => {
		const f = fixture();
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		await expect(
			applyPlan({ ...f.config, mode: "preview" }, p, f.adapters, f.store),
		).rejects.toThrow("activation");
		f.store.guard = vi.fn(async () => {
			throw new Error("revoked");
		});
		await expect(applyPlan(f.config, p, f.adapters, f.store)).rejects.toThrow(
			"revoked",
		);
		expect(f.adapter.create).not.toHaveBeenCalled();
	});
	it("compensates only a confirmed unchanged owned blocker and rejects unrelated edits", async () => {
		const f = fixture();
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		const receipt = await applyPlan(f.config, p, f.adapters, f.store);
		const m = receipt.mutations[0]!;
		f.events.get("b")![0]!.revision = "user-edit";
		await expect(
			compensateBlocker(
				f.config.calendars[1]!,
				p.actions[0]!,
				m,
				f.adapter,
				async () => {},
			),
		).rejects.toThrow("changed");
		expect(f.adapter.remove).not.toHaveBeenCalled();
	});
	it("preserves successful destinations when a different calendar write is uncertain", async () => {
		const f = fixture();
		const third = { ...f.config.calendars[1]!, key: "c", calendarId: "c" };
		f.config.calendars.push(third);
		f.events.set("c", []);
		f.snapshots.push({ ...f.snapshots[1]!, route: third, events: [] });
		const failed = {
			...f.adapter,
			create: vi.fn(async () => {
				throw new Error("timeout");
			}),
		};
		f.adapters.set("c", failed);
		const p = await buildPlan(f.config, f.snapshots, [], "seed");
		const receipt = await applyPlan(f.config, p, f.adapters, f.store);
		expect(receipt.outcome).toBe("partial");
		expect(
			receipt.mutations.filter((m) => m.state === "confirmed"),
		).toHaveLength(1);
		expect(f.events.get("b")).toHaveLength(1);
	});
});

describe("observable compensation and recovery", () => {
	it("previews immutable undo, then conditionally deletes only the exact owned blocker", async () => {
		const { previewCompensation, applyCompensation } = await import("./apply");
		const f = fixture();
		f.adapter.remove = vi.fn(async (r, a) => {
			f.events.set(
				r.key,
				f.events.get(r.key)!.filter((e) => e.id !== a.destinationEventId),
			);
		});
		const plan = await buildPlan(f.config, f.snapshots, [], "seed");
		const receipt = await applyPlan(f.config, plan, f.adapters, f.store);
		const undo = await previewCompensation(
			f.config,
			plan,
			receipt.mutations,
			[plan.actions[0]!.id],
			f.adapters,
		);
		expect(undo.purpose).toBe("compensate");
		expect(undo.originalPlanId).toBe(plan.id);
		expect(undo.actions[0]!.expectedDestinationRevision).toBe(
			receipt.mutations[0]!.revision,
		);
		expect(
			(await applyCompensation(f.config, undo, f.adapters, f.store)).outcome,
		).toBe("confirmed");
		expect(f.events.get("b")).toEqual([]);
		expect(f.adapter.remove).toHaveBeenCalledTimes(1);
		await applyCompensation(f.config, undo, f.adapters, f.store);
		expect(f.adapter.remove).toHaveBeenCalledTimes(1);
	});
	it("recovers an uncertain create after the original source changed without another provider write", async () => {
		const { recoverPlan } = await import("./apply");
		const f = fixture();
		const create = f.adapter.create;
		f.adapter.create = vi.fn(async (r, a) => {
			await create(r, a);
			f.adapter.findOwned = vi.fn(async () => []);
			throw new Error("timeout");
		});
		const plan = await buildPlan(f.config, f.snapshots, [], "seed");
		expect(
			(await applyPlan(f.config, plan, f.adapters, f.store)).mutations[0]!
				.state,
		).toBe("uncertain");
		f.events.get("a")![0]!.revision = "source-moved";
		f.adapter.findOwned = vi.fn(async (r, marker) =>
			f.events.get(r.key)!.filter((e) => e.ownership === marker),
		);
		expect(
			(await recoverPlan(f.config, plan, f.adapters, f.store)).outcome,
		).toBe("confirmed");
		expect(f.adapter.create).toHaveBeenCalledTimes(1);
	});
});

describe("snapshot ledger coverage", () => {
	it("preserves historical blockers without exact-reading every old event", async () => {
		const { collectSnapshots } = await import("./apply");
		const f = fixture();
		const mirrors = [
			{
				id: "old",
				sourceKey: "old",
				sourceRouteKey: "a",
				sourceEventId: "old-source",
				destinationKey: "b",
				eventId: "old-blocker",
				revision: "old",
				ownership: "owned",
				interval: {
					start: "2026-09-01T10:00:00Z",
					end: "2026-09-01T11:00:00Z",
				},
			},
		];
		await collectSnapshots(f.config, f.adapters, mirrors);
		expect(f.adapter.get).not.toHaveBeenCalled();
		const plan = await buildPlan(f.config, f.snapshots, mirrors, "seed");
		expect(plan.actions.every((a) => a.kind !== "delete")).toBe(true);
	});
	it("reads a ledger blocker outside the window when its stable source occurrence moved into current coverage", async () => {
		const { collectSnapshots } = await import("./apply");
		const f = fixture();
		const mirrors = [
			{
				id: "moved",
				sourceKey: "s",
				sourceRouteKey: "a",
				sourceEventId: f.event.id,
				destinationKey: "b",
				eventId: "old-blocker",
				revision: "old",
				ownership: "owned",
				interval: {
					start: "2026-09-01T10:00:00Z",
					end: "2026-09-01T11:00:00Z",
				},
			},
		];
		await collectSnapshots(f.config, f.adapters, mirrors);
		expect(f.adapter.get).toHaveBeenCalledWith(
			f.config.calendars[1],
			"old-blocker",
		);
	});
});
