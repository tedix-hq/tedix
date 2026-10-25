import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	createProviderEventSubscription,
	getProviderEventSubscription,
	updateProviderEventSubscription,
	addProviderEventDelivery,
	claimProviderEventDelivery,
	listPendingProviderEventDeliveries,
	settleProviderEventDelivery,
	reclaimProviderEventAdmission,
	settleProviderEventAdmission,
	claimProviderEventSubscription,
	dueProviderEventSubscriptions,
	pruneProviderEvents,
	addProviderEventChannel,
	claimProviderEventWake,
	listProviderEventSubscriptions,
	listProviderEventChannels,
} from "./provider-events";
function fixture() {
	const sql = new DatabaseSync(":memory:");
	sql.exec(
		`CREATE TABLE provider_event_subscriptions(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,adapter TEXT NOT NULL,provider_id TEXT NOT NULL,connection_instance_id TEXT,calendar_id TEXT NOT NULL,mcp_app_id TEXT,event_arguments TEXT,event_cursor TEXT,max_wakes_per_hour INTEGER,wake_window_started_at TEXT,wake_window_count INTEGER NOT NULL DEFAULT 0,connection_scope TEXT NOT NULL DEFAULT 'tenant',personal_owner_user_id TEXT,workspace_id TEXT,workspace_resource_id TEXT,delegation_id TEXT,execution_tool_id TEXT,resource_delegation_ids TEXT NOT NULL DEFAULT '[]',tedi_id TEXT NOT NULL,skill_id TEXT NOT NULL,skill_revision INTEGER NOT NULL,delivery_mode TEXT NOT NULL,status TEXT NOT NULL,expires_at TEXT,next_reconcile_at TEXT NOT NULL,last_notification_at TEXT,last_dispatch_at TEXT,last_error TEXT,lease_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE provider_event_channels(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,organization_id TEXT NOT NULL,token_hash TEXT NOT NULL,signing_secret_ciphertext TEXT,provider_channel_id TEXT,resource_id TEXT,status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE provider_event_deliveries(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,subscription_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,payload TEXT,lease_until TEXT,created_at TEXT NOT NULL,sent_at TEXT);`,
	);
	return createDbQueryClient(createD1Facade(sql));
}
const row = {
	id: "sub",
	organizationId: "org-a",
	adapter: "google_calendar" as const,
	providerId: "google",
	calendarId: "cal-a",
	tediId: "tedi",
	skillId: "skill",
	skillRevision: 1,
	deliveryMode: "push" as const,
	status: "active" as const,
	nextReconcileAt: "2026-01-01",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
};
describe("provider event D1 authority and outbox", () => {
	it("backs off expired error subscriptions and permits recovery after the retry time", async () => {
		const db = fixture();
		await createProviderEventSubscription(db, {
			...row,
			expiresAt: "2026-01-02T00:00:00.000Z",
		});
		await updateProviderEventSubscription(db, "org-a", "sub", {
			status: "error",
			lastError: "Provider request failed (503)",
			nextReconcileAt: "2026-01-02T00:05:00.000Z",
			leaseUntil: null,
		});
		for (const now of [
			"2026-01-02T00:00:01.000Z",
			"2026-01-02T00:01:00.000Z",
			"2026-01-02T00:04:59.999Z",
			"2026-01-02T00:05:00.000Z",
		]) {
			expect(await dueProviderEventSubscriptions(db, now)).toEqual([]);
		}
		const now = "2026-01-02T00:05:00.001Z";
		expect(await dueProviderEventSubscriptions(db, now)).toMatchObject([
			{ id: "sub", status: "error" },
		]);
		const leaseUntil = "2026-01-02T00:06:00.000Z";
		expect(
			await claimProviderEventSubscription(db, "org-a", "sub", now, leaseUntil),
		).toBe(true);
		expect(await dueProviderEventSubscriptions(db, now)).toEqual([]);
		expect(
			await updateProviderEventSubscription(
				db,
				"org-a",
				"sub",
				{
					status: "active",
					lastError: null,
					expiresAt: "2026-01-03T00:00:00.000Z",
					nextReconcileAt: "2026-01-02T00:10:00.000Z",
					leaseUntil: null,
				},
				leaseUntil,
			),
		).toMatchObject([{ id: "sub", status: "active", lastError: null }]);
		expect(await dueProviderEventSubscriptions(db, now)).toEqual([]);
		expect(
			await dueProviderEventSubscriptions(db, "2026-01-02T00:10:00.001Z"),
		).toMatchObject([{ id: "sub", status: "active" }]);
	});

	it.each([
		{
			status: "active",
			expiresAt: "2026-01-01",
			nextReconcileAt: "2026-01-03",
			leaseUntil: null,
			due: true,
		},
		{
			status: "active",
			expiresAt: null,
			nextReconcileAt: "2026-01-01",
			leaseUntil: null,
			due: true,
		},
		{
			status: "error",
			expiresAt: null,
			nextReconcileAt: "2026-01-01",
			leaseUntil: null,
			due: true,
		},
		{
			status: "error",
			expiresAt: "2026-01-01",
			nextReconcileAt: "2026-01-01",
			leaseUntil: "2026-01-03",
			due: false,
		},
		{
			status: "error",
			expiresAt: "2026-01-01",
			nextReconcileAt: "2026-01-01",
			leaseUntil: "2026-01-01",
			due: true,
		},
		{
			status: "disabled",
			expiresAt: "2026-01-01",
			nextReconcileAt: "2026-01-01",
			leaseUntil: null,
			due: false,
		},
	] as const)(
		"selects due subscriptions with $status, expiry $expiresAt and lease $leaseUntil",
		async ({ due, ...subscription }) => {
			const db = fixture();
			await createProviderEventSubscription(db, { ...row, ...subscription });
			expect(
				await dueProviderEventSubscriptions(db, "2026-01-02"),
			).toHaveLength(due ? 1 : 0);
		},
	);

	it("fences maintenance writes after another worker replaces the claimed lease", async () => {
		const db = fixture();
		await createProviderEventSubscription(db, row);
		expect(
			await claimProviderEventSubscription(
				db,
				"org-a",
				"sub",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(true);
		expect(
			await claimProviderEventSubscription(
				db,
				"org-a",
				"sub",
				"2026-01-04",
				"2026-01-05",
			),
		).toBe(true);
		const current = await getProviderEventSubscription(db, "org-a", "sub");
		for (const patch of [
			{ status: "active" as const, expiresAt: "2026-02-01" },
			{
				status: "error" as const,
				lastError: "stale failure",
				leaseUntil: null,
			},
			{ eventCursor: "stale cursor", lastNotificationAt: "2026-01-04" },
			{
				status: "active" as const,
				nextReconcileAt: "2026-02-01",
				leaseUntil: null,
			},
		]) {
			expect(
				await updateProviderEventSubscription(
					db,
					"org-a",
					"sub",
					patch,
					"2026-01-03",
				),
			).toEqual([]);
			expect(await getProviderEventSubscription(db, "org-a", "sub")).toEqual(
				current,
			);
		}
		expect(
			await updateProviderEventSubscription(
				db,
				"org-b",
				"sub",
				{ expiresAt: "2026-02-01" },
				"2026-01-05",
			),
		).toEqual([]);
		expect(
			await updateProviderEventSubscription(
				db,
				"org-a",
				"sub",
				{ expiresAt: "2026-02-01", eventCursor: "current cursor" },
				"2026-01-05",
			),
		).toHaveLength(1);
		expect(
			await updateProviderEventSubscription(
				db,
				"org-a",
				"sub",
				{ status: "active", leaseUntil: null },
				"2026-01-05",
			),
		).toHaveLength(1);
		expect(
			await updateProviderEventSubscription(
				db,
				"org-a",
				"sub",
				{ status: "error" },
				"2026-01-05",
			),
		).toEqual([]);
		expect(
			await getProviderEventSubscription(db, "org-a", "sub"),
		).toMatchObject({
			status: "active",
			expiresAt: "2026-02-01",
			eventCursor: "current cursor",
			leaseUntil: null,
		});
	});
	it("isolates records and cannot revive a concurrently disabled subscription", async () => {
		const db = fixture();
		await createProviderEventSubscription(db, row);
		expect(
			await getProviderEventSubscription(db, "org-b", "sub"),
		).toBeUndefined();
		expect(
			await updateProviderEventSubscription(db, "org-b", "sub", {
				status: "disabled",
			}),
		).toEqual([]);
		await updateProviderEventSubscription(db, "org-a", "sub", {
			status: "disabled",
		});
		expect(
			await updateProviderEventSubscription(db, "org-a", "sub", {
				status: "active",
			}),
		).toEqual([]);
		expect(
			await claimProviderEventSubscription(
				db,
				"org-a",
				"sub",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(false);
	});
	it("deduplicates redelivery and recovers expired claims without losing pending events", async () => {
		const db = fixture();
		const delivery = {
			id: "event",
			organizationId: "org-a",
			subscriptionId: "sub",
			status: "pending" as const,
			createdAt: "2026-01-01",
		};
		expect(await addProviderEventDelivery(db, delivery)).toHaveLength(1);
		expect(await addProviderEventDelivery(db, delivery)).toEqual([]);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-b",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(false);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(true);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(false);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-02")).toEqual(
			[],
		);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-04",
				"2026-01-05",
			),
		).toBe(true);
		await settleProviderEventDelivery(
			db,
			"event",
			"org-a",
			"2026-01-05",
			"pending",
			"2026-01-04",
			"2026-01-06",
		);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-05")).toEqual(
			[],
		);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-07")).toEqual([
			expect.objectContaining({ id: "event" }),
		]);
		await settleProviderEventDelivery(
			db,
			"event",
			"org-a",
			"2026-01-06",
			"sent",
			"2026-01-07",
		);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-08")).toEqual(
			[],
		);
	});
	it("keeps admitting deliveries undispatchable until admission settles them", async () => {
		const db = fixture();
		await addProviderEventDelivery(db, {
			id: "event",
			organizationId: "org-a",
			subscriptionId: "sub",
			status: "admitting",
			leaseUntil: "2026-01-02",
			createdAt: "2026-01-01",
		});
		expect(await listPendingProviderEventDeliveries(db, "2026-01-09")).toEqual(
			[],
		);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-09",
				"2026-01-10",
			),
		).toBe(false);
		// Only an expired admission lease can be retaken, and only by its organization.
		expect(
			await reclaimProviderEventAdmission(
				db,
				"event",
				"org-a",
				"2026-01-01",
				"2026-01-03",
			),
		).toBe(false);
		expect(
			await reclaimProviderEventAdmission(
				db,
				"event",
				"org-b",
				"2026-01-04",
				"2026-01-05",
			),
		).toBe(false);
		expect(
			await reclaimProviderEventAdmission(
				db,
				"event",
				"org-a",
				"2026-01-04",
				"2026-01-05",
			),
		).toBe(true);
		// The superseded admission cannot settle; the current one can.
		expect(
			await settleProviderEventAdmission(
				db,
				"event",
				"org-a",
				"2026-01-02",
				"pending",
			),
		).toBe(false);
		expect(
			await settleProviderEventAdmission(
				db,
				"event",
				"org-a",
				"2026-01-05",
				"pending",
			),
		).toBe(true);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-06")).toEqual([
			expect.objectContaining({ id: "event", leaseUntil: null }),
		]);
		expect(
			await reclaimProviderEventAdmission(
				db,
				"event",
				"org-a",
				"2026-01-09",
				"2026-01-10",
			),
		).toBe(false);
	});
	it("rejects a stale claimant's settlement after the delivery lease is reclaimed", async () => {
		const db = fixture();
		await addProviderEventDelivery(db, {
			id: "event",
			organizationId: "org-a",
			subscriptionId: "sub",
			status: "pending",
			createdAt: "2026-01-01",
		});
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-02",
				"2026-01-03",
			),
		).toBe(true);
		expect(
			await claimProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-04",
				"2026-01-05",
			),
		).toBe(true);
		expect(
			await settleProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-03",
				"pending",
				"2026-01-04",
			),
		).toBe(false);
		expect(
			await settleProviderEventDelivery(
				db,
				"event",
				"org-a",
				"2026-01-05",
				"sent",
				"2026-01-04",
			),
		).toBe(true);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-06")).toEqual(
			[],
		);
	});
});

it("spends one hourly wake budget per subscription and organization, then resets with the window", async () => {
	const db = fixture();
	await createProviderEventSubscription(db, {
		...row,
		adapter: "mcp_events",
		calendarId: "vendor.alert",
	});
	await createProviderEventSubscription(db, {
		...row,
		id: "sub-b",
		organizationId: "org-b",
		adapter: "mcp_events",
		calendarId: "vendor.alert",
	});
	const wake = (org: string, id: string, now: string, windowStart: string) =>
		claimProviderEventWake(db, org, id, now, windowStart, 2);
	expect(await wake("org-a", "sub", "2026-01-02T00:00", "2026-01-01")).toBe(
		true,
	);
	expect(await wake("org-a", "sub", "2026-01-02T00:01", "2026-01-01")).toBe(
		true,
	);
	expect(await wake("org-a", "sub", "2026-01-02T00:02", "2026-01-01")).toBe(
		false,
	);
	// Another organization's id never spends or reads this budget.
	expect(await wake("org-b", "sub", "2026-01-02T00:02", "2026-01-01")).toBe(
		false,
	);
	expect(await wake("org-b", "sub-b", "2026-01-02T00:02", "2026-01-01")).toBe(
		true,
	);
	// A window that started before the new window start resets the count.
	expect(
		await wake("org-a", "sub", "2026-01-02T01:05", "2026-01-02T00:05"),
	).toBe(true);
	expect(await getProviderEventSubscription(db, "org-a", "sub")).toMatchObject({
		wakeWindowStartedAt: "2026-01-02T01:05",
		wakeWindowCount: 1,
	});
	await updateProviderEventSubscription(db, "org-a", "sub", {
		status: "disabled",
	});
	expect(
		await wake("org-a", "sub", "2026-01-03T00:00", "2026-01-02T23:00"),
	).toBe(false);
});

it("applies personal subscription visibility before the inventory limit", async () => {
	const db = fixture();
	for (let index = 0; index < 100; index += 1) {
		await createProviderEventSubscription(db, {
			...row,
			id: `personal-${index}`,
			connectionScope: "user",
			personalOwnerUserId: "another-user",
		});
	}
	await createProviderEventSubscription(db, {
		...row,
		id: "visible",
		connectionScope: "user",
		personalOwnerUserId: "caller",
	});

	expect(
		(
			await listProviderEventSubscriptions(db, "org-a", {
				personalOwnerUserId: "caller",
			})
		).map((subscription) => subscription.id),
	).toEqual(["visible"]);
});

it("stores a wrapped event payload once per event id", async () => {
	const db = fixture();
	const delivery = {
		id: "evt-hash",
		organizationId: "org-a",
		subscriptionId: "sub",
		status: "pending" as const,
		createdAt: "2026-01-01",
		payload: { trust: "untrusted", eventId: "e1" },
	};
	expect(await addProviderEventDelivery(db, delivery)).toMatchObject([
		{ payload: { trust: "untrusted", eventId: "e1" } },
	]);
	expect(await addProviderEventDelivery(db, delivery)).toEqual([]);
});

it("lists active channels even when newer stopped channel history fills the page", async () => {
	const db = fixture();
	for (let index = 0; index < 100; index++) {
		await addProviderEventChannel(db, {
			id: `stopped-${index}`,
			subscriptionId: "sub",
			organizationId: "org-a",
			tokenHash: "hash",
			status: "stopped",
			expiresAt: "2026-02-01",
			createdAt: `2026-01-02T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
		});
	}
	await addProviderEventChannel(db, {
		id: "active",
		subscriptionId: "sub",
		organizationId: "org-a",
		tokenHash: "hash",
		status: "active",
		expiresAt: "2026-02-01",
		createdAt: "2026-01-01",
	});

	expect(await listProviderEventChannels(db, "org-a", "sub")).toMatchObject([
		{ id: "active", status: "active" },
	]);
});

it("prunes expired callback capabilities and completed deliveries while retaining pending retries", async () => {
	const db = fixture();
	await addProviderEventChannel(db, {
		id: "expired",
		subscriptionId: "sub",
		organizationId: "org-a",
		tokenHash: "hash",
		status: "stopped",
		expiresAt: "2026-01-01",
		createdAt: "2026-01-01",
	});
	await addProviderEventDelivery(db, {
		id: "sent",
		organizationId: "org-a",
		subscriptionId: "sub",
		status: "sent",
		createdAt: "2026-01-01",
	});
	await addProviderEventDelivery(db, {
		id: "pending",
		organizationId: "org-a",
		subscriptionId: "sub",
		status: "pending",
		createdAt: "2026-01-01",
	});
	expect(await pruneProviderEvents(db, "2026-03-01", "2026-02-01")).toEqual({
		channels: 1,
		deliveries: 1,
	});
	expect(
		await listPendingProviderEventDeliveries(db, "2026-03-01"),
	).toHaveLength(1);
});
