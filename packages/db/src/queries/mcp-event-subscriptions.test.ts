/**
 * Webhook subscription leases behind MCP `events/subscribe`: renewal, claim
 * leasing, expiry and organization isolation.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { mcpEventSubscriptions } from "../schema/mcp-event-subscriptions";
import { createD1Facade, type D1FacadeOptions } from "../test/d1-facade";
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

function fixture(options: D1FacadeOptions = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(mcpEventSubscriptions));
	return createDbQueryClient(createD1Facade(sqlite, options));
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
			claimToken: (
				await claimDueMcpEventSubscriptions(db, {
					now: T0,
					leaseUntil: T1,
					limit: 10,
				})
			)[0]!.claimToken!,
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

	it.each(["active", "unhealthy"] as const)(
		"rejects a pre-renewal %s result even when renewal uses the same timestamp",
		async (status) => {
			const db = fixture();
			await upsertMcpEventSubscription(db, params("sub-1"));
			const [old] = await claimDueMcpEventSubscriptions(db, {
				now: T0,
				leaseUntil: T1,
				limit: 10,
			});
			const renewed = await upsertMcpEventSubscription(
				db,
				params("sub-1", "org-a", {
					cursor: "wsc1.20",
					callbackUrl: "https://hooks.example/renewed",
				}),
			);
			const result = {
				id: "sub-1",
				organizationId: "org-a",
				claimToken: old!.claimToken!,
				cursor: "wsc1.12",
				status,
				consecutiveFailures: 6,
				nextAttemptAt: LATER,
				rateWindowStartedAt: T0,
				rateWindowCount: 9,
				lastDeliveredAt: T0,
				lastStatus: 500,
				now: T1,
			};
			expect(await recordMcpEventDelivery(db, result)).toBe(false);
			expect(await getMcpEventSubscription(db, params("sub-1"))).toEqual(
				renewed,
			);
			const [current] = await claimDueMcpEventSubscriptions(db, {
				now: T0,
				leaseUntil: T1,
				limit: 10,
			});
			expect(current!.claimToken).not.toBe(old!.claimToken);
			expect(await recordMcpEventDelivery(db, result)).toBe(false);
			expect(
				await recordMcpEventDelivery(db, {
					...result,
					claimToken: current!.claimToken!,
					cursor: "wsc1.21",
					status: "active",
					consecutiveFailures: 0,
					lastStatus: 200,
				}),
			).toBe(true);
			expect(await getMcpEventSubscription(db, params("sub-1"))).toMatchObject({
				cursor: "wsc1.21",
				status: "active",
				consecutiveFailures: 0,
				lastStatus: 200,
				claimToken: null,
				callbackUrl: "https://hooks.example/renewed",
			});
		},
	);

	it("rejects expired claims and consumes the current claim exactly once", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(db, params("sub-1"));
		const [old] = await claimDueMcpEventSubscriptions(db, {
			now: T0,
			leaseUntil: T1,
			limit: 10,
		});
		const [current] = await claimDueMcpEventSubscriptions(db, {
			now: T1,
			leaseUntil: LATER,
			limit: 10,
		});
		const result = {
			id: "sub-1",
			organizationId: "org-a",
			claimToken: old!.claimToken!,
			cursor: "wsc1.12",
			status: "active" as const,
			consecutiveFailures: 0,
			nextAttemptAt: LATER,
			rateWindowStartedAt: T0,
			rateWindowCount: 1,
			lastDeliveredAt: T1,
			lastStatus: 200,
			now: T1,
		};
		expect(await recordMcpEventDelivery(db, result)).toBe(false);
		expect(await getMcpEventSubscription(db, params("sub-1"))).toEqual(current);
		result.claimToken = current!.claimToken!;
		expect(await recordMcpEventDelivery(db, result)).toBe(true);
		expect(
			await recordMcpEventDelivery(db, { ...result, cursor: "wsc1.99" }),
		).toBe(false);
		expect(await getMcpEventSubscription(db, params("sub-1"))).toMatchObject({
			cursor: "wsc1.12",
			claimToken: null,
			lastStatus: 200,
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

	it("rechecks admission atomically when a competitor takes the last slot", async () => {
		let competing = false;
		let inserted = false;
		const db = fixture({
			onPrepare(query, sqlite) {
				if (
					!competing ||
					!/^insert into "mcp_event_subscriptions"/i.test(query)
				)
					return;
				competing = false;
				sqlite.exec(`INSERT INTO mcp_event_subscriptions
					(id, organization_id, owner_subject, mcp_url, event_name, arguments,
					callback_url, sealed_credential, cursor, next_attempt_at, expires_at, created_at, updated_at)
					SELECT 'competitor', organization_id, owner_subject, mcp_url, event_name,
					arguments, callback_url, sealed_credential, cursor, next_attempt_at, expires_at, created_at, updated_at
					FROM mcp_event_subscriptions WHERE id = 'sub-0'`);
				inserted = true;
			},
		});
		for (let i = 0; i < MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER - 1; i++)
			await upsertMcpEventSubscription(db, params(`sub-${i}`));
		// Land a competing registration after any preflight read, before the write.
		competing = true;
		expect(await upsertMcpEventSubscription(db, params("loser"))).toBeNull();
		expect(inserted).toBe(true);
		expect(await db.select().from(mcpEventSubscriptions)).toHaveLength(20);
		expect(
			await upsertMcpEventSubscription(db, params("sub-0")),
		).not.toBeNull();
		expect(
			await upsertMcpEventSubscription(db, params("other-org", "org-b")),
		).not.toBeNull();
		expect(
			await upsertMcpEventSubscription(
				db,
				params("other-owner", "org-a", { ownerSubject: "user-2" }),
			),
		).not.toBeNull();
	});

	it("counts expired renewals as new admissions but excludes expired leases", async () => {
		const db = fixture();
		await upsertMcpEventSubscription(
			db,
			params("expired", "org-a", { expiresAt: T1 }),
		);
		for (let i = 0; i < MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER; i++)
			expect(
				await upsertMcpEventSubscription(
					db,
					params(`sub-${i}`, "org-a", { now: T1 }),
				),
			).not.toBeNull();
		expect(
			await upsertMcpEventSubscription(
				db,
				params("expired", "org-a", { now: T1 }),
			),
		).toBeNull();
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
			claimToken: (
				await claimDueMcpEventSubscriptions(db, {
					now: T0,
					leaseUntil: T1,
					limit: 10,
				})
			)[0]!.claimToken!,
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
				claimToken: (
					await claimDueMcpEventSubscriptions(db, {
						now: T0,
						leaseUntil: T1,
						limit: 10,
					})
				)[0]!.claimToken!,
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
