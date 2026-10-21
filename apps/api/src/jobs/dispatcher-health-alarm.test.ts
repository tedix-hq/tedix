import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const db = vi.hoisted(() => ({
	orgs: vi.fn(),
	activity: vi.fn(),
	create: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/work-items/dispatcher-health", () => ({
	DISPATCHER_HEALTH_SCHEMA: "tedix.dispatcher-health.v1",
	listDispatcherHealthOrgs: db.orgs,
	readDispatcherActivity: db.activity,
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	createWorkInteraction: db.create,
	cancelWorkInteraction: db.cancel,
}));

import { runDispatcherHealthAlarm } from "./dispatcher-health-alarm";

const NOW = Date.UTC(2026, 9, 21, 23, 0);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const env = { DB: {} } as CloudflareEnv;

/** A stateful stand-in for the alert row the queries would read back. */
let alert: { id: string; version: number } | null;
let facts: Record<string, unknown>;

const row = () => ({
	orgId: "org",
	staleAfterMinutes: null,
	alarmEnabled: true,
	dispatchableCount: 2,
	workItemId: "work",
	lastAdmissionAt: ago(5),
	lastTrackerActionAt: ago(5),
	ownerUserId: "owner",
	openAlertId: alert?.id ?? null,
	openAlertVersion: alert?.version ?? null,
	openAlertCreatorId: alert ? "owner" : null,
	answeredAlertAt: null,
	...facts,
});

beforeEach(() => {
	alert = null;
	facts = {};
	db.orgs.mockReset().mockImplementation(async () => [row()]);
	db.activity.mockReset().mockResolvedValue({
		lastAdmissionAt: ago(5),
		lastTrackerActionAt: ago(7),
	});
	db.create.mockReset().mockImplementation(async (_db, p) => {
		alert = { id: p.id, version: 1 };
		return {};
	});
	db.cancel.mockReset().mockImplementation(async () => {
		alert = null;
		return {};
	});
});

describe("runDispatcherHealthAlarm", () => {
	it("raises nothing while both signals are fresh, and records both ages", async () => {
		const counts = await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).not.toHaveBeenCalled();
		expect(counts).toMatchObject({
			raised: 0,
			admissionAgeSeconds: 300,
			trackerAgeSeconds: 420,
		});
	});

	it("raises one owner item when a signal is stale and Work waits", async () => {
		facts = { lastAdmissionAt: ago(46) };
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).toHaveBeenCalledOnce();
		expect(db.create.mock.calls[0]![1]).toMatchObject({
			orgId: "org",
			workItemId: "work",
			targetType: "user",
			targetId: "owner",
			metadata: expect.objectContaining({
				schema: "tedix.dispatcher-health.v1",
			}),
		});
	});

	it("treats a stale request tracker the same way", async () => {
		facts = { lastTrackerActionAt: ago(90) };
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).toHaveBeenCalledOnce();
	});

	it("does not repeat while the condition persists", async () => {
		facts = { lastAdmissionAt: ago(46) };
		await runDispatcherHealthAlarm(env, NOW);
		await runDispatcherHealthAlarm(env, NOW + 120_000);
		expect(db.create).toHaveBeenCalledOnce();
		expect(db.cancel).not.toHaveBeenCalled();
	});

	it("does not raise again after the owner answered this stall's item", async () => {
		facts = { lastAdmissionAt: ago(46) };
		await runDispatcherHealthAlarm(env, NOW);
		// The owner answers the item; the stall itself has not recovered.
		alert = null;
		facts = { lastAdmissionAt: ago(46), answeredAlertAt: ago(0) };
		await runDispatcherHealthAlarm(env, NOW + 120_000);
		expect(db.create).toHaveBeenCalledOnce();
	});

	it("raises for a new stall after an answered item from an earlier one", async () => {
		facts = { lastAdmissionAt: ago(46), answeredAlertAt: ago(60) };
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).toHaveBeenCalledOnce();
	});

	it("clears the item when both signals recover", async () => {
		facts = { lastAdmissionAt: ago(46) };
		await runDispatcherHealthAlarm(env, NOW);
		facts = {};
		const counts = await runDispatcherHealthAlarm(env, NOW + 120_000);
		expect(db.cancel).toHaveBeenCalledOnce();
		expect(counts.cleared).toBe(1);
		expect(alert).toBeNull();
	});

	it("raises nothing when stale but no Work is dispatchable", async () => {
		facts = {
			lastAdmissionAt: ago(300),
			lastTrackerActionAt: null,
			dispatchableCount: 0,
		};
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).not.toHaveBeenCalled();
	});

	it("clears an open item once the waiting Work is gone", async () => {
		facts = { lastAdmissionAt: ago(46) };
		await runDispatcherHealthAlarm(env, NOW);
		facts = { lastAdmissionAt: ago(46), dispatchableCount: 0 };
		await runDispatcherHealthAlarm(env, NOW + 120_000);
		expect(db.cancel).toHaveBeenCalledOnce();
	});

	it("takes the threshold from organization config", async () => {
		facts = { lastAdmissionAt: ago(46), staleAfterMinutes: 90 };
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).not.toHaveBeenCalled();
		facts = { lastAdmissionAt: ago(46), alarmEnabled: false };
		await runDispatcherHealthAlarm(env, NOW);
		expect(db.create).not.toHaveBeenCalled();
	});
});
