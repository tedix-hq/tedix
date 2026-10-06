/** Canonical billing meter-outbox queries. */

import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { chunkForBoundParams } from "../../utils/batch";
import {
	type StripeMeterOutboxRow,
	stripeMeterOutbox,
} from "../../schema/billing";

export async function claimStripeMeterOutbox(
	db: DbClient,
	input: {
		stripeEnvironment?: "test" | "live";
		now: string;
		leaseExpiresAt: string;
		limit: number;
	},
): Promise<StripeMeterOutboxRow[]> {
	const candidates = await db
		.select({ id: stripeMeterOutbox.id })
		.from(stripeMeterOutbox)
		.where(
			and(
				eq(
					stripeMeterOutbox.stripeEnvironment,
					input.stripeEnvironment ?? "live",
				),
				inArray(stripeMeterOutbox.status, ["pending", "failed", "sending"]),
				lte(stripeMeterOutbox.nextAttemptAt, input.now),
				or(
					eq(stripeMeterOutbox.status, "pending"),
					eq(stripeMeterOutbox.status, "failed"),
					lte(stripeMeterOutbox.leaseExpiresAt, input.now),
				),
			),
		)
		.orderBy(asc(stripeMeterOutbox.createdAt))
		.limit(input.limit);
	if (candidates.length === 0) return [];
	// D1 caps bound parameters at 100 per statement; the drain batch is 100
	// rows and the guard predicates bind params of their own, so the claim
	// UPDATE is issued in id chunks. Each row's claim stays row-atomic.
	const claimed: (typeof stripeMeterOutbox.$inferSelect)[] = [];
	for (const chunk of chunkForBoundParams(
		candidates.map((row) => row.id),
		50,
	)) {
		claimed.push(
			...(await db
				.update(stripeMeterOutbox)
				.set({
					status: "sending",
					leaseExpiresAt: input.leaseExpiresAt,
					updatedAt: input.now,
				})
				.where(
					and(
						eq(
							stripeMeterOutbox.stripeEnvironment,
							input.stripeEnvironment ?? "live",
						),
						inArray(stripeMeterOutbox.id, chunk),
						inArray(stripeMeterOutbox.status, ["pending", "failed", "sending"]),
						or(
							eq(stripeMeterOutbox.status, "pending"),
							eq(stripeMeterOutbox.status, "failed"),
							lte(stripeMeterOutbox.leaseExpiresAt, input.now),
						),
					),
				)
				.returning()),
		);
	}
	return claimed;
}

export async function markStripeMeterOutboxSent(
	db: DbClient,
	input: {
		id: string;
		stripeEventId: string;
		now: string;
	},
): Promise<void> {
	await db
		.update(stripeMeterOutbox)
		.set({
			status: "sent",
			stripeEventId: input.stripeEventId,
			sentAt: input.now,
			leaseExpiresAt: null,
			lastError: null,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(stripeMeterOutbox.id, input.id),
				eq(stripeMeterOutbox.status, "sending"),
			),
		);
}

/**
 * Retry ceiling for one outbox row. With exponential backoff capped at 24h
 * this spans roughly ten days of retries before the row dead-letters — long
 * past any transient Stripe outage, short enough that a poisoned row (deleted
 * customer, retired meter) stops consuming batch slots forever.
 */
export const STRIPE_METER_OUTBOX_MAX_ATTEMPTS = 20;

export async function markStripeMeterOutboxFailed(
	db: DbClient,
	input: {
		id: string;
		error: string;
		nextAttemptAt: string;
		now: string;
		maxAttempts?: number;
	},
): Promise<void> {
	const maxAttempts = input.maxAttempts ?? STRIPE_METER_OUTBOX_MAX_ATTEMPTS;
	await db
		.update(stripeMeterOutbox)
		.set({
			status: sql`CASE WHEN ${stripeMeterOutbox.attemptCount} + 1 >= ${maxAttempts} THEN 'dead' ELSE 'failed' END`,
			attemptCount: sql`${stripeMeterOutbox.attemptCount} + 1`,
			nextAttemptAt: input.nextAttemptAt,
			leaseExpiresAt: null,
			lastError: input.error.slice(0, 2_000),
			updatedAt: input.now,
		})
		.where(
			and(
				eq(stripeMeterOutbox.id, input.id),
				eq(stripeMeterOutbox.status, "sending"),
			),
		);
}
