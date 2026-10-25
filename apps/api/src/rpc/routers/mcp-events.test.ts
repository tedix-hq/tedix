import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { mcpEventSubscriptions } from "@tedix/db/schema/mcp-event-subscriptions";
import { upsertMcpEventSubscription } from "@tedix/db/queries/mcp-event-subscriptions";
import { RecordMcpEventWebhookDeliveryInputSchema } from "@tedix/api-contract/schemas/mcp-events";
import { workEvents } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { mcpEventsContractRouter } from "./mcp-events";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(workEvents, workInteractions, organizationMembers));
	const db = createDbClient(createD1Facade(sqlite));
	const client = () =>
		createRouterClient(mcpEventsContractRouter, {
			context: {
				authType: "user",
				organizationId: "org-maple",
				db,
				env: { ENVIRONMENT: "test" },
				headers: new Headers(),
				user: { sub: "member-robin", permissions: [], roles: [] },
			} as unknown as BaseContext,
		});
	const append = (id: string, org = "org-maple", eventType = "work.accepted") =>
		sqlite
			.prepare(
				"INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, ?, 'work-cedar', ?, 'user', 'member-robin', ?, ?)",
			)
			.run(
				id,
				org,
				eventType,
				JSON.stringify({
					summary: "Private fictional notes",
					outcome: eventType === "attempt.expired" ? "expired" : "failed",
				}),
				"2026-10-17T00:00:00.000Z",
			);
	return { client, append, db };
}

describe("MCP ledger replay", () => {
	it("replays committed events across fresh clients with stable ids and paginated cursors", async () => {
		const { client, append } = fixture();
		append("accepted");
		append("foreign", "org-birch");
		append("comment", "org-maple", "comment.created");
		append("settled", "org-maple", "attempt.settled");
		const input = { afterSequence: 0, limit: 1 };
		const first = await client().pollWorkStateChanges(input);
		expect(first).toMatchObject({ afterSequence: 1, hasMore: true });
		expect(first.events.map((event) => event.eventId)).toEqual([
			"evt_work_accepted",
		]);
		// A reconnect retries the old cursor; delivery identities remain stable.
		expect(await client().pollWorkStateChanges(input)).toEqual(first);
		const second = await client().pollWorkStateChanges({
			...input,
			afterSequence: first.afterSequence,
		});
		expect(second).toMatchObject({ afterSequence: 4, hasMore: false });
		expect(second.events[0]).toMatchObject({
			eventId: "evt_work_settled",
			data: {
				change: "attempt_settled",
				attempt_outcome: "failed",
				organization_id: "org-maple",
			},
		});
		expect(JSON.stringify([first, second])).not.toContain(
			"Private fictional notes",
		);
		expect(
			await client().pollWorkStateChanges({
				...input,
				afterSequence: second.afterSequence,
			}),
		).toEqual({ events: [], afterSequence: 4, hasMore: false });
	});

	it("starts without historical events, then observes only new commits in its organization", async () => {
		const { client, append } = fixture();
		append("old");
		append("foreign", "org-birch");
		const head = await client().pollWorkStateChanges({});
		expect(head).toEqual({ events: [], afterSequence: 1, hasMore: false });
		append("new", "org-maple", "work.completed");
		const next = await client().pollWorkStateChanges({
			afterSequence: head.afterSequence,
		});
		expect(next.events.map((event) => event.eventId)).toEqual(["evt_work_new"]);
		expect(next.afterSequence).toBe(3);
	});
});

it("delivers lane requests only to a fresh active canonical recipient", async () => {
	const { client, db } = fixture();
	const input = {
		laneRequestsOnly: true,
		after: { at: "", id: "" },
		targetId: "another-user",
	};
	await expect(
		client().pollWorkInteractionRequests(input),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await db.insert(organizationMembers).values({
		id: "membership",
		organizationId: "org-maple",
		descopeUserId: "member-robin",
		userId: "user-robin",
		email: "robin@example.invalid",
		status: "active",
	});
	for (const [id, targetId] of [
		["own", "user-robin"],
		["other", "another-user"],
	])
		await db.insert(workInteractions).values({
			id,
			orgId: "org-maple",
			workItemId: "work-cedar",
			kind: "handoff",
			subject: "Run lane",
			prompt: "Read Work",
			creatorType: "system",
			creatorId: "tedix",
			targetType: "user",
			targetId,
			createdAt: "2026-10-17T00:00:00.000Z",
			metadata: { laneRequest: { harness: "codex" } },
		});
	expect(
		(await client().pollWorkInteractionRequests(input)).events.map(
			(e) => e.data.request_id,
		),
	).toEqual(["own"]);
	await db.delete(organizationMembers);
	await db.insert(organizationMembers).values({
		id: "membership",
		organizationId: "org-maple",
		descopeUserId: "member-robin",
		userId: null,
		email: "robin@example.invalid",
		status: "active",
	});
	await expect(
		client().pollWorkInteractionRequests(input),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("publishes server stale and expiry notices without requiring a human identity on the Attempt", async () => {
	const { client, append } = fixture();
	append("stale", "org-maple", "lane.stale");
	append("expired", "org-maple", "attempt.expired");
	append("foreign-stale", "org-birch", "lane.stale");
	const r = await client().pollWorkStateChanges({ afterSequence: 0 });
	expect(r.events.map((e) => [e.data.change, e.data.attempt_outcome])).toEqual([
		["lane_stale", null],
		["attempt_expired", "expired"],
	]);
	expect(JSON.stringify(r)).not.toContain("Private fictional notes");
});

describe("MCP webhook result fencing over RPC", () => {
	it("returns the claim token and rejects results superseded by renewal", async () => {
		const sqlite = new DatabaseSync(":memory:");
		onTestFinished(() => sqlite.close());
		sqlite.exec(schemaDdl(mcpEventSubscriptions));
		const db = createDbClient(createD1Facade(sqlite));
		const client = createRouterClient(mcpEventsContractRouter, {
			context: {
				db,
				env: { ENVIRONMENT: "test" },
				headers: new Headers({ "X-Service-Binding": "true" }),
			} as unknown as BaseContext,
		});
		const now = new Date().toISOString();
		const subscription = {
			id: `evsub_${"a".repeat(64)}`,
			organizationId: "org-maple",
			ownerSubject: "member-robin",
			mcpUrl: "https://mcp.example/mcp",
			eventName: "work.item.state_changed",
			arguments: { organization_id: "org-maple" },
			callbackUrl: "https://hooks.example/old",
			sealedCredential: "sealed",
			cursor: "wsc1.10",
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			now,
		};
		await upsertMcpEventSubscription(db, subscription);
		const first = await client.claimDueWebhookSubscriptions({ limit: 1 });
		const old = first.subscriptions[0]!;
		expect(old.claimToken).toEqual(expect.any(String));
		const renewed = await upsertMcpEventSubscription(db, {
			...subscription,
			cursor: "wsc1.20",
			callbackUrl: "https://hooks.example/new",
		});
		const result = {
			id: old.id,
			organizationId: old.organizationId,
			claimToken: old.claimToken,
			cursor: "wsc1.11",
			status: "unhealthy" as const,
			consecutiveFailures: 6,
			nextAttemptAt: now,
			rateWindowStartedAt: now,
			rateWindowCount: 1,
			lastDeliveredAt: null,
			lastStatus: 500,
		};
		expect(await client.recordWebhookDelivery(result)).toEqual({
			recorded: false,
		});
		expect(await db.select().from(mcpEventSubscriptions)).toEqual([renewed]);
		const { claimToken: _token, ...unfenced } = result;
		expect(
			RecordMcpEventWebhookDeliveryInputSchema.safeParse(unfenced).success,
		).toBe(false);
		expect(
			RecordMcpEventWebhookDeliveryInputSchema.safeParse({
				...result,
				claimToken: null,
			}).success,
		).toBe(false);
		const current = await client.claimDueWebhookSubscriptions({ limit: 1 });
		expect(current.subscriptions[0]!.claimToken).not.toBe(old.claimToken);
		expect(
			await client.recordWebhookDelivery({
				...result,
				claimToken: current.subscriptions[0]!.claimToken,
				cursor: "wsc1.21",
				status: "active",
				consecutiveFailures: 0,
				lastStatus: 200,
			}),
		).toEqual({ recorded: true });
		expect(await db.select().from(mcpEventSubscriptions)).toMatchObject([
			{
				cursor: "wsc1.21",
				status: "active",
				claimToken: null,
				callbackUrl: "https://hooks.example/new",
			},
		]);
	});
});
