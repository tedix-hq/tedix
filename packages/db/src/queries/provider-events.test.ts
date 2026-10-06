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
	claimProviderEventSubscription,
	pruneProviderEvents,
	addProviderEventChannel,
} from "./provider-events";
function fixture() {
	const sql = new DatabaseSync(":memory:");
	sql.exec(
		`CREATE TABLE provider_event_subscriptions(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,adapter TEXT NOT NULL,provider_id TEXT NOT NULL,connection_instance_id TEXT,calendar_id TEXT NOT NULL,connection_scope TEXT NOT NULL DEFAULT 'tenant',personal_owner_user_id TEXT,workspace_id TEXT,workspace_resource_id TEXT,delegation_id TEXT,execution_tool_id TEXT,resource_delegation_ids TEXT NOT NULL DEFAULT '[]',tedi_id TEXT NOT NULL,skill_id TEXT NOT NULL,skill_revision INTEGER NOT NULL,delivery_mode TEXT NOT NULL,status TEXT NOT NULL,expires_at TEXT,next_reconcile_at TEXT NOT NULL,last_notification_at TEXT,last_dispatch_at TEXT,last_error TEXT,lease_until TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE provider_event_channels(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,organization_id TEXT NOT NULL,token_hash TEXT NOT NULL,provider_channel_id TEXT,resource_id TEXT,status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE provider_event_deliveries(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,subscription_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease_until TEXT,created_at TEXT NOT NULL,sent_at TEXT);`,
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
			"sent",
			"2026-01-04",
		);
		expect(await listPendingProviderEventDeliveries(db, "2026-01-06")).toEqual(
			[],
		);
	});
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
