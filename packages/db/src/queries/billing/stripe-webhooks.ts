/** Canonical billing stripe-webhooks queries. */

import type { CoreStoreBinding } from "../postgres/core-store";
import type { PgQueryClient } from "../../pg/query-client";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type StripeWebhookEvent,
	stripeWebhookEvents,
} from "../../schema/billing";

export async function claimStripeWebhookEvent(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: {
		eventId: string;
		eventType: string;
		entityKey: string;
		eventCreatedAt: number;
		now: string;
		leaseExpiresAt: string;
	},
): Promise<{ claimed: boolean; event: StripeWebhookEvent }> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/stripe-webhooks")
			).claimStripeWebhookEvent(db.db, input);
		db = db.db;
	}

	const [claimed] = await db
		.insert(stripeWebhookEvents)
		.values({
			eventId: input.eventId,
			eventType: input.eventType,
			entityKey: input.entityKey,
			eventCreatedAt: input.eventCreatedAt,
			status: "processing",
			attemptCount: 1,
			leaseExpiresAt: input.leaseExpiresAt,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: stripeWebhookEvents.eventId,
			set: {
				status: "processing",
				attemptCount: sql`${stripeWebhookEvents.attemptCount} + 1`,
				leaseExpiresAt: input.leaseExpiresAt,
				lastError: null,
				updatedAt: input.now,
			},
			setWhere: or(
				eq(stripeWebhookEvents.status, "failed"),
				and(
					eq(stripeWebhookEvents.status, "processing"),
					lte(stripeWebhookEvents.leaseExpiresAt, input.now),
				),
			),
		})
		.returning();
	if (claimed) return { claimed: true, event: claimed };
	const [existing] = await db
		.select()
		.from(stripeWebhookEvents)
		.where(eq(stripeWebhookEvents.eventId, input.eventId))
		.limit(1);
	if (!existing) throw new Error("Failed to load Stripe webhook receipt");
	return { claimed: false, event: existing };
}

export async function hasNewerProcessedStripeWebhookEvent(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: {
		entityKey: string;
		eventCreatedAt: number;
		eventId: string;
	},
): Promise<boolean> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/stripe-webhooks")
			).hasNewerProcessedStripeWebhookEvent(db.db, input);
		db = db.db;
	}

	const [newer] = await db
		.select({ eventId: stripeWebhookEvents.eventId })
		.from(stripeWebhookEvents)
		.where(
			and(
				eq(stripeWebhookEvents.entityKey, input.entityKey),
				eq(stripeWebhookEvents.status, "processed"),
				gt(stripeWebhookEvents.eventCreatedAt, input.eventCreatedAt),
				sql`${stripeWebhookEvents.eventId} <> ${input.eventId}`,
			),
		)
		.limit(1);
	return Boolean(newer);
}

export async function markStripeWebhookEventProcessed(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: {
		eventId: string;
		outcome: string;
		now: string;
	},
): Promise<void> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/stripe-webhooks")
			).markStripeWebhookEventProcessed(db.db, input);
		db = db.db;
	}

	await db
		.update(stripeWebhookEvents)
		.set({
			status: "processed",
			outcome: input.outcome,
			leaseExpiresAt: null,
			lastError: null,
			processedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(stripeWebhookEvents.eventId, input.eventId),
				eq(stripeWebhookEvents.status, "processing"),
			),
		);
}

export async function markStripeWebhookEventFailed(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: {
		eventId: string;
		error: string;
		now: string;
	},
): Promise<void> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/stripe-webhooks")
			).markStripeWebhookEventFailed(db.db, input);
		db = db.db;
	}

	await db
		.update(stripeWebhookEvents)
		.set({
			status: "failed",
			leaseExpiresAt: null,
			lastError: input.error.slice(0, 2_000),
			updatedAt: input.now,
		})
		.where(
			and(
				eq(stripeWebhookEvents.eventId, input.eventId),
				eq(stripeWebhookEvents.status, "processing"),
			),
		);
}
