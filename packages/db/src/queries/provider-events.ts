import { and, eq, lt, ne, or, isNull, sql, inArray, desc } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	providerEventSubscriptions as subscriptions,
	providerEventChannels as channels,
	providerEventDeliveries as deliveries,
} from "../schema/provider-events";
export async function createProviderEventSubscription(
	db: DbQueryClient,
	row: typeof subscriptions.$inferInsert,
) {
	await db.insert(subscriptions).values(row);
}
export async function getProviderEventSubscription(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	return (
		await db
			.select()
			.from(subscriptions)
			.where(
				and(
					eq(subscriptions.organizationId, organizationId),
					eq(subscriptions.id, id),
				),
			)
			.limit(1)
	)[0];
}
export async function listProviderEventSubscriptions(
	db: DbQueryClient,
	organizationId: string,
) {
	return db
		.select()
		.from(subscriptions)
		.where(eq(subscriptions.organizationId, organizationId))
		.limit(100);
}
export async function updateProviderEventSubscription(
	db: DbQueryClient,
	organizationId: string,
	id: string,
	patch: Partial<
		Pick<
			typeof subscriptions.$inferInsert,
			| "status"
			| "expiresAt"
			| "nextReconcileAt"
			| "lastNotificationAt"
			| "lastDispatchAt"
			| "lastError"
			| "leaseUntil"
		>
	>,
) {
	return db
		.update(subscriptions)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(subscriptions.organizationId, organizationId),
				eq(subscriptions.id, id),
				...(patch.status && patch.status !== "disabled"
					? [ne(subscriptions.status, "disabled")]
					: []),
			),
		)
		.returning();
}
export async function addProviderEventChannel(
	db: DbQueryClient,
	row: typeof channels.$inferInsert,
) {
	await db.insert(channels).values(row);
}
// A random channel UUID is only an ingress locator; handlers must verify its token hash.
export async function resolveProviderEventChannel(
	db: DbQueryClient,
	id: string,
) {
	return (
		await db.select().from(channels).where(eq(channels.id, id)).limit(1)
	)[0];
}
export async function listProviderEventChannels(
	db: DbQueryClient,
	organizationId: string,
	subscriptionId: string,
) {
	return db
		.select()
		.from(channels)
		.where(
			and(
				eq(channels.organizationId, organizationId),
				eq(channels.subscriptionId, subscriptionId),
			),
		)
		.orderBy(desc(channels.createdAt))
		.limit(100);
}
export async function updateProviderEventChannel(
	db: DbQueryClient,
	organizationId: string,
	id: string,
	patch: Partial<
		Pick<
			typeof channels.$inferInsert,
			"providerChannelId" | "resourceId" | "status" | "expiresAt"
		>
	>,
) {
	await db
		.update(channels)
		.set(patch)
		.where(
			and(eq(channels.organizationId, organizationId), eq(channels.id, id)),
		);
}
export async function addProviderEventDelivery(
	db: DbQueryClient,
	row: typeof deliveries.$inferInsert,
) {
	return db.insert(deliveries).values(row).onConflictDoNothing().returning();
}
export async function listPendingProviderEventDeliveries(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select()
		.from(deliveries)
		.where(
			and(
				eq(deliveries.status, "pending"),
				or(isNull(deliveries.leaseUntil), lt(deliveries.leaseUntil, now)),
			),
		)
		.limit(50);
}
export async function claimProviderEventDelivery(
	db: DbQueryClient,
	id: string,
	organizationId: string,
	now: string,
	until: string,
) {
	return (
		(
			await db
				.update(deliveries)
				.set({ leaseUntil: until, attempts: sql`${deliveries.attempts}+1` })
				.where(
					and(
						eq(deliveries.id, id),
						eq(deliveries.organizationId, organizationId),
						eq(deliveries.status, "pending"),
						or(isNull(deliveries.leaseUntil), lt(deliveries.leaseUntil, now)),
					),
				)
				.returning()
		).length > 0
	);
}
export async function settleProviderEventDelivery(
	db: DbQueryClient,
	id: string,
	organizationId: string,
	status: "sent" | "discarded" | "pending",
	now: string,
) {
	await db
		.update(deliveries)
		.set({ status, leaseUntil: null, sentAt: status === "sent" ? now : null })
		.where(
			and(eq(deliveries.id, id), eq(deliveries.organizationId, organizationId)),
		);
}
// Platform maintenance scans contain no caller-supplied organization selector.
export async function dueProviderEventSubscriptions(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select()
		.from(subscriptions)
		.where(
			and(
				ne(subscriptions.status, "disabled"),
				or(
					lt(subscriptions.nextReconcileAt, now),
					lt(subscriptions.expiresAt, now),
				),
				or(isNull(subscriptions.leaseUntil), lt(subscriptions.leaseUntil, now)),
			),
		)
		.limit(50);
}
export async function claimProviderEventSubscription(
	db: DbQueryClient,
	organizationId: string,
	id: string,
	now: string,
	until: string,
) {
	return (
		(
			await db
				.update(subscriptions)
				.set({ leaseUntil: until })
				.where(
					and(
						eq(subscriptions.id, id),
						eq(subscriptions.organizationId, organizationId),
						ne(subscriptions.status, "disabled"),
						or(
							isNull(subscriptions.leaseUntil),
							lt(subscriptions.leaseUntil, now),
						),
					),
				)
				.returning()
		).length > 0
	);
}

/** Bounded retention: callback capabilities expire; sent outbox records stay 30 days. */
export async function pruneProviderEvents(
	db: DbQueryClient,
	now: string,
	retainAfter: string,
) {
	const channelIds = db
		.select({ id: channels.id })
		.from(channels)
		.where(lt(channels.expiresAt, now))
		.limit(50);
	const deliveryIds = db
		.select({ id: deliveries.id })
		.from(deliveries)
		.where(
			and(
				ne(deliveries.status, "pending"),
				lt(deliveries.createdAt, retainAfter),
			),
		)
		.limit(50);
	const removedChannels = await db
		.delete(channels)
		.where(inArray(channels.id, channelIds))
		.returning({ id: channels.id });
	const removedDeliveries = await db
		.delete(deliveries)
		.where(inArray(deliveries.id, deliveryIds))
		.returning({ id: deliveries.id });
	return {
		channels: removedChannels.length,
		deliveries: removedDeliveries.length,
	};
}
