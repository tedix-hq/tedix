import { and, asc, count, eq, gt, inArray, lte, ne } from "drizzle-orm";
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
	const [held] = await db
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
	if ((held?.total ?? 0) >= MAX_MCP_EVENT_SUBSCRIPTIONS_PER_OWNER) return null;
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
		expiresAt: params.expiresAt,
		updatedAt: params.now,
	};
	const [row] = await db
		.insert(mcpEventSubscriptions)
		.values({
			id: params.id,
			organizationId: params.organizationId,
			ownerSubject: params.ownerSubject,
			...renewed,
			createdAt: params.now,
		})
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
 * Remove expired leases, then claim healthy due subscriptions across every
 * organization for one delivery pass. The claim is one conditional UPDATE, so
 * two overlapping passes never claim the same row.
 */
export async function claimDueMcpEventSubscriptions(
	db: DbQueryClient,
	params: ClaimDueMcpEventSubscriptionsParams,
): Promise<McpEventSubscriptionRow[]> {
	await db
		.delete(mcpEventSubscriptions)
		.where(lte(mcpEventSubscriptions.expiresAt, params.now));
	const due = and(
		eq(mcpEventSubscriptions.status, "active"),
		gt(mcpEventSubscriptions.expiresAt, params.now),
		lte(mcpEventSubscriptions.nextAttemptAt, params.now),
	);
	return db
		.update(mcpEventSubscriptions)
		.set({ nextAttemptAt: params.leaseUntil })
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

/** Store one delivery pass's outcome; the row stays bound to its organization. */
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
			updatedAt: params.now,
		})
		.where(
			and(
				eq(mcpEventSubscriptions.id, params.id),
				eq(mcpEventSubscriptions.organizationId, params.organizationId),
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
