import { and, asc, count, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	mcpEventSubscriptions,
	type McpEventSubscriptionRow,
} from "../schema/mcp-event-subscriptions";

/** Live webhook subscriptions one caller may hold in one organization. */
export const MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER = 20;

export interface McpEventSubscriptionKey {
	id: string;
	organizationId: string;
	ownerSubject: string;
}

export interface UpsertMcpEventSubscriptionParams extends McpEventSubscriptionKey {
	mcpUrl: string;
	eventName: string;
	arguments: Record<string, string>;
	callbackUrl: string;
	sealedCredential: string;
	cursor: string;
	expiresAt: string;
	now: string;
}

export async function getMcpEventSubscription(
	db: DbQueryClient,
	key: McpEventSubscriptionKey,
): Promise<McpEventSubscriptionRow | null> {
	const [row] = await db
		.select()
		.from(mcpEventSubscriptions)
		.where(keyCondition(key))
		.limit(1);
	return row ?? null;
}

/**
 * Create or renew one subscription. A renewal resets health, so a subscriber
 * that re-verified its callback is delivered to again. Returns `null` when the
 * caller already holds the maximum number of other live subscriptions.
 */
export async function upsertMcpEventSubscription(
	db: DbQueryClient,
	params: UpsertMcpEventSubscriptionParams,
): Promise<McpEventSubscriptionRow | null> {
	const held = db
		.select({ total: count() })
		.from(mcpEventSubscriptions)
		.where(
			and(
				eq(mcpEventSubscriptions.organizationId, params.organizationId),
				eq(mcpEventSubscriptions.ownerSubject, params.ownerSubject),
				gt(mcpEventSubscriptions.expiresAt, params.now),
				ne(mcpEventSubscriptions.id, params.id),
			),
		);
	const renewed = {
		mcpUrl: params.mcpUrl,
		eventName: params.eventName,
		arguments: params.arguments,
		callbackUrl: params.callbackUrl,
		sealedCredential: params.sealedCredential,
		cursor: params.cursor,
		status: "active" as const,
		consecutiveFailures: 0,
		nextAttemptAt: params.now,
		claimToken: null,
		expiresAt: params.expiresAt,
		updatedAt: params.now,
	};
	const [row] = await db
		.insert(mcpEventSubscriptions)
		// D1 serializes the count and write as one statement. Excluding this id
		// lets a live lease renew at capacity without admitting another lease.
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					organizationId: sql<string>`${params.organizationId}`.as(
						"organization_id",
					),
					ownerSubject: sql<string>`${params.ownerSubject}`.as("owner_subject"),
					mcpUrl: sql<string>`${renewed.mcpUrl}`.as("mcp_url"),
					eventName: sql<string>`${renewed.eventName}`.as("event_name"),
					arguments: sql<
						Record<string, string>
					>`${JSON.stringify(renewed.arguments)}`.as("arguments"),
					callbackUrl: sql<string>`${renewed.callbackUrl}`.as("callback_url"),
					sealedCredential: sql<string>`${renewed.sealedCredential}`.as(
						"sealed_credential",
					),
					cursor: sql<string>`${renewed.cursor}`.as("cursor"),
					status: sql<"active">`${renewed.status}`.as("status"),
					consecutiveFailures: sql<number>`${renewed.consecutiveFailures}`.as(
						"consecutive_failures",
					),
					nextAttemptAt: sql<string>`${renewed.nextAttemptAt}`.as(
						"next_attempt_at",
					),
					claimToken: sql<string | null>`null`.as("claim_token"),
					rateWindowStartedAt: sql<string | null>`null`.as(
						"rate_window_started_at",
					),
					rateWindowCount: sql<number>`0`.as("rate_window_count"),
					lastDeliveredAt: sql<string | null>`null`.as("last_delivered_at"),
					lastStatus: sql<number | null>`null`.as("last_status"),
					expiresAt: sql<string>`${renewed.expiresAt}`.as("expires_at"),
					createdAt: sql<string>`${params.now}`.as("created_at"),
					updatedAt: sql<string>`${renewed.updatedAt}`.as("updated_at"),
				})
				.from(sql`(select 1)`)
				.where(sql`(${held}) < ${MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER}`),
		)
		.onConflictDoUpdate({
			target: mcpEventSubscriptions.id,
			set: renewed,
			// An id is derived from organization and owner, but never let a
			// collision rewrite another caller's or organization's row.
			setWhere: and(
				eq(mcpEventSubscriptions.organizationId, params.organizationId),
				eq(mcpEventSubscriptions.ownerSubject, params.ownerSubject),
			),
		})
		.returning();
	return row ?? null;
}

export async function deleteMcpEventSubscription(
	db: DbQueryClient,
	key: McpEventSubscriptionKey,
): Promise<boolean> {
	const deleted = await db
		.delete(mcpEventSubscriptions)
		.where(keyCondition(key))
		.returning({ id: mcpEventSubscriptions.id });
	return deleted.length > 0;
}

export interface ClaimDueMcpEventSubscriptionsParams {
	now: string;
	/** A claimed row is not due again before this instant. */
	leaseUntil: string;
	limit: number;
}

/**
 * Remove up to 100 expired leases, then claim healthy due subscriptions across
 * every organization for one delivery pass. The claim is one conditional UPDATE, so
 * two overlapping passes never claim the same row.
 */
export async function claimDueMcpEventSubscriptions(
	db: DbQueryClient,
	params: ClaimDueMcpEventSubscriptionsParams,
): Promise<McpEventSubscriptionRow[]> {
	await db.delete(mcpEventSubscriptions).where(
		// bound-params: capped SQL subquery, not a bound id list
		inArray(
			mcpEventSubscriptions.id,
			db
				.select({ id: mcpEventSubscriptions.id })
				.from(mcpEventSubscriptions)
				.where(lte(mcpEventSubscriptions.expiresAt, params.now))
				.limit(100),
		),
	);
	const due = and(
		eq(mcpEventSubscriptions.status, "active"),
		gt(mcpEventSubscriptions.expiresAt, params.now),
		lte(mcpEventSubscriptions.nextAttemptAt, params.now),
	);
	return db
		.update(mcpEventSubscriptions)
		.set({ nextAttemptAt: params.leaseUntil, claimToken: crypto.randomUUID() })
		.where(
			and(
				due,
				// bound-params: a SQL subquery capped by `limit`, not a bound id list
				inArray(
					mcpEventSubscriptions.id,
					db
						.select({ id: mcpEventSubscriptions.id })
						.from(mcpEventSubscriptions)
						.where(due)
						.orderBy(asc(mcpEventSubscriptions.nextAttemptAt))
						.limit(params.limit),
				),
			),
		)
		.returning();
}

export interface RecordMcpEventDeliveryParams {
	id: string;
	claimToken: string;
	organizationId: string;
	cursor: string;
	status: McpEventSubscriptionRow["status"];
	consecutiveFailures: number;
	nextAttemptAt: string;
	rateWindowStartedAt: string | null;
	rateWindowCount: number;
	lastDeliveredAt: string | null;
	lastStatus: number | null;
	now: string;
}

/** Store and consume only the current claim; renewal or reclaim fences late results. */
export async function recordMcpEventDelivery(
	db: DbQueryClient,
	params: RecordMcpEventDeliveryParams,
): Promise<boolean> {
	const updated = await db
		.update(mcpEventSubscriptions)
		.set({
			cursor: params.cursor,
			status: params.status,
			consecutiveFailures: params.consecutiveFailures,
			nextAttemptAt: params.nextAttemptAt,
			rateWindowStartedAt: params.rateWindowStartedAt,
			rateWindowCount: params.rateWindowCount,
			lastDeliveredAt: params.lastDeliveredAt,
			lastStatus: params.lastStatus,
			claimToken: null,
			updatedAt: params.now,
		})
		.where(
			and(
				eq(mcpEventSubscriptions.id, params.id),
				eq(mcpEventSubscriptions.organizationId, params.organizationId),
				eq(mcpEventSubscriptions.claimToken, params.claimToken),
			),
		)
		.returning({ id: mcpEventSubscriptions.id });
	return updated.length > 0;
}

function keyCondition(key: McpEventSubscriptionKey) {
	return and(
		eq(mcpEventSubscriptions.id, key.id),
		eq(mcpEventSubscriptions.organizationId, key.organizationId),
		eq(mcpEventSubscriptions.ownerSubject, key.ownerSubject),
	);
}
