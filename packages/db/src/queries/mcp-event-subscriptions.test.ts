/**
 * Webhook subscription leases behind MCP `events/subscribe`: renewal, claim
 * leasing, expiry and organization isolation.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { mcpEventSubscriptions } from "../schema/mcp-event-subscriptions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	claimDueMcpEventSubscriptions,
	deleteMcpEventSubscription,
	getMcpEventSubscription,
	MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER,
	recordMcpEventDelivery,
	upsertMcpEventSubscription,
} from "./mcp-event-subscriptions";

const T0 = "2026-10-15T12:00:00.000Z";
const T1 = "2026-10-15T12:01:00.000Z";
const LATER = "2026-10-15T13:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(mcpEventSubscriptions));
	return createDbQueryClient(createD1Facade(sqlite));
}

function params(
	id: string,
	organizationId = "org-a",
	overrides: Partial<Parameters<typeof upsertMcpEventSubscription>[1]> = {},
) {
	return {
		id,
		organizationId,
		ownerSubject: "user-1",
		mcpUrl: "https://tedix.mcp.example/mcp",
		eventName: "work.item.state_changed",
		arguments: { organization_id: organizationId },
		callbackUrl: "https://hooks.example/a",
		sealedCredential: "sealed",
		cursor: "wsc1.10",
		expiresAt: LATER,
		now: T0,
		...overrides,
	};
}

describe("MCP event webhook subscriptions", () => {
	it("renews in place and resets health", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(db, params("sub-1"));
		await recordMcpEventDelivery(db, {
			id: "sub-1",
			organizationId: "org-a",
			cursor: "wsc1.12",
			status: "unhealthy",
			consecutiveFailures: 6,
			nextAttemptAt: LATER,
			rateWindowStartedAt: T0,
			rateWindowCount: 2,
			lastDeliveredAt: null,
			lastStatus: 500,
			now: T0,
		});
		const renewed = await upsertMcpEventSubscription(
			db,
			params("sub-1", "org-a", { cursor: "wsc1.20", now: T1 }),
		);
		expect(renewed).toMatchObject({
			status: "active",
			consecutiveFailures: 0,
			cursor: "wsc1.20",
			nextAttemptAt: T1,
			createdAt: T0,
		});
	});

	it("caps live subscriptions per owner", async () => {
		const db = fixture();
		for (let i = 0; i < MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER; i++)
			expect(
				await upsertMcpEventSubscription(db, params(`sub-${i}`)),
			).not.toBeNull();
		expect(await upsertMcpEventSubscription(db, params("one-more"))).toBeNull();
		// Renewing an existing lease is never refused by the cap.
		expect(
			await upsertMcpEventSubscription(db, params("sub-0")),
		).not.toBeNull();
	});

	it("claims each due row once and drops expired leases", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(db, params("live"));
		await upsertMcpEventSubscription(
			db,
			params("expired", "org-a", { expiresAt: T1 }),
		);
		const first = await claimDueMcpEventSubscriptions(db, {
			now: T1,
			leaseUntil: "2026-10-15T12:03:00.000Z",
			limit: 10,
		});
		expect(first.map((row) => row.id)).toEqual(["live"]);
		expect(
			await claimDueMcpEventSubscriptions(db, {
				now: T1,
				leaseUntil: "2026-10-15T12:03:00.000Z",
				limit: 10,
			}),
		).toEqual([]);
		expect(
			await getMcpEventSubscription(db, {
				id: "expired",
				organizationId: "org-a",
				ownerSubject: "user-1",
			}),
		).toBeNull();
	});

	it("drains expired backlogs in bounded passes while claiming live rows", async () => {
		const db = fixture();
		for (let i = 0; i < 205; i++)
			await upsertMcpEventSubscription(
				db,
				params(`expired-${i}`, i % 2 ? "org-a" : "org-b", {
					ownerSubject: `owner-${i}`,
					expiresAt: i % 2 ? T0 : T1,
				}),
			);
		await upsertMcpEventSubscription(db, params("live-a", "org-a"));
		await upsertMcpEventSubscription(db, params("live-b", "org-b"));
		await upsertMcpEventSubscription(
			db,
			params("future", "org-a", {
				now: LATER,
				expiresAt: "2026-10-15T14:00:00.000Z",
			}),
		);
		const claimedIds: string[] = [];
		for (const remainingExpired of [105, 5, 0]) {
			const claimed = await claimDueMcpEventSubscriptions(db, {
				now: T1,
				leaseUntil: LATER,
				limit: 1,
			});
			expect(claimed).toHaveLength(remainingExpired ? 1 : 0);
			claimedIds.push(...claimed.map((row) => row.id));
			const remaining = await db.select().from(mcpEventSubscriptions);
			expect(
				remaining.filter((row) => row.id.startsWith("expired-")),
			).toHaveLength(remainingExpired);
			expect(
				remaining.filter((row) => !row.id.startsWith("expired-")),
			).toHaveLength(3);
			expect(remaining.find((row) => row.id === "future")).toMatchObject({
				nextAttemptAt: LATER,
			});
		}
		expect(claimedIds.sort()).toEqual(["live-a", "live-b"]);
	});

	it("never claims an unhealthy subscription", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(db, params("sick"));
		await recordMcpEventDelivery(db, {
			id: "sick",
			organizationId: "org-a",
			cursor: "wsc1.10",
			status: "unhealthy",
			consecutiveFailures: 6,
			nextAttemptAt: T0,
			rateWindowStartedAt: null,
			rateWindowCount: 0,
			lastDeliveredAt: null,
			lastStatus: 500,
			now: T0,
		});
		expect(
			await claimDueMcpEventSubscriptions(db, {
				now: T1,
				leaseUntil: LATER,
				limit: 10,
			}),
		).toEqual([]);
	});

	it("keeps every write bound to its organization and owner", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(db, params("sub-a", "org-a"));
		expect(
			await deleteMcpEventSubscription(db, {
				id: "sub-a",
				organizationId: "org-b",
				ownerSubject: "user-1",
			}),
		).toBe(false);
		expect(
			await deleteMcpEventSubscription(db, {
				id: "sub-a",
				organizationId: "org-a",
				ownerSubject: "user-2",
			}),
		).toBe(false);
		expect(
			await recordMcpEventDelivery(db, {
				id: "sub-a",
				organizationId: "org-b",
				cursor: "wsc1.99",
				status: "active",
				consecutiveFailures: 0,
				nextAttemptAt: T0,
				rateWindowStartedAt: null,
				rateWindowCount: 0,
				lastDeliveredAt: null,
				lastStatus: null,
				now: T0,
			}),
		).toBe(false);
		// Another organization's id collision cannot overwrite the row.
		expect(
			await upsertMcpEventSubscription(
				db,
				params("sub-a", "org-b", { cursor: "wsc1.99" }),
			),
		).toBeNull();
		expect(
			await getMcpEventSubscription(db, {
				id: "sub-a",
				organizationId: "org-a",
				ownerSubject: "user-1",
			}),
		).toMatchObject({ cursor: "wsc1.10" });
		expect(
			await deleteMcpEventSubscription(db, {
				id: "sub-a",
				organizationId: "org-a",
				ownerSubject: "user-1",
			}),
		).toBe(true);
	});
});
