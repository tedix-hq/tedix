/**
 * Tell organization admins when monthly credits reach 80% or 100%.
 *
 * Settlement records each threshold once per period in
 * billing_credit_notices. Planning turns a new notice into one outbox row per
 * admin and channel (Deck card, email) and stamps the notice, in one batch.
 * Rows have deterministic ids, so planning again queues nothing new. The
 * sender claims due rows under a lease, delivers, and marks them sent; a sent
 * row is never claimed again. A Deck card also has a deterministic id, so a
 * retry after a lost "sent" mark finds the card instead of adding another.
 * Rows left over when the period ends expire unsent: the month already reset.
 */

import {
	type CreditNoticeThreshold,
	CREDIT_NOTICE_THRESHOLDS,
} from "@tedix/api-contract/utils/credit-pricing";
import {
	CREDIT_NOTICE_LINK_LABEL,
	CREDIT_NOTICE_PATH,
	creditNoticeCopy,
} from "@tedix/api-contract/utils/credit-notice-copy";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type BillingCreditNoticeDelivery,
	type CreditNoticeDeliveryChannel,
	CREDIT_NOTICE_DELIVERY_CHANNELS,
	billingAccounts,
	billingCreditNoticeDeliveries,
	billingCreditNotices,
} from "../../schema/billing";
import { organizationMembers } from "../../schema/organization-members";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { chunkForBoundParams } from "../../utils/batch";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "../work-items/interactions";

/** `metadata.schema` of the credit notice Deck card. */
export const CREDIT_NOTICE_CARD_SCHEMA = "tedix.credit-notice.v1";

/** Ten tries with backoff capped at six hours span about two days. */
export const CREDIT_NOTICE_DELIVERY_MAX_ATTEMPTS = 10;

const ADMIN_ROLES = ["owner", "admin"] as const;

export function creditNoticeDeliveryId(input: {
	organizationId: string;
	periodStart: string;
	threshold: number;
	channel: CreditNoticeDeliveryChannel;
	recipientUserId: string;
}): string {
	return [
		"credit-notice",
		input.organizationId,
		input.periodStart,
		input.threshold,
		input.channel,
		input.recipientUserId,
	].join(":");
}

/** Active people who can manage billing: owners and admins, one per user. */
export async function listCreditNoticeRecipients(
	db: DbQueryClient,
	organizationId: string,
): Promise<Array<{ userId: string; email: string }>> {
	const rows = await db
		.select({
			userId: organizationMembers.userId,
			email: organizationMembers.email,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.status, "active"),
				eq(organizationMembers.kind, "human"),
				inArray(organizationMembers.role, [...ADMIN_ROLES]),
				isNotNull(organizationMembers.userId),
			),
		)
		.orderBy(asc(organizationMembers.id));
	const seen = new Set<string>();
	const recipients: Array<{ userId: string; email: string }> = [];
	for (const row of rows) {
		const email = row.email.trim();
		if (!row.userId || !email || seen.has(row.userId)) continue;
		seen.add(row.userId);
		recipients.push({ userId: row.userId, email });
	}
	return recipients;
}

export interface PlanCreditNoticeDeliveriesResult {
	notices: number;
	queued: number;
	/** Notices from a period that already ended; stamped, nothing queued. */
	stale: number;
}

/**
 * Queue deliveries for notices not yet planned. Each notice is planned in
 * one batch: its outbox rows plus the stamp, so a crash leaves it unplanned
 * and the next run redoes it without duplicates.
 */
export async function planCreditNoticeDeliveries(
	db: DbQueryClient,
	input: { now: string; limit?: number },
): Promise<PlanCreditNoticeDeliveriesResult> {
	const notices = await db
		.select({
			organizationId: billingCreditNotices.organizationId,
			periodStart: billingCreditNotices.periodStart,
			threshold: billingCreditNotices.threshold,
			accountPeriodStart: sql<string | null>`${billingAccounts.periodStart}`.as(
				"account_period_start",
			),
			accountPeriodEnd: sql<string | null>`${billingAccounts.periodEnd}`.as(
				"account_period_end",
			),
		})
		.from(billingCreditNotices)
		.leftJoin(
			billingAccounts,
			eq(billingAccounts.organizationId, billingCreditNotices.organizationId),
		)
		.where(isNull(billingCreditNotices.deliveriesPlannedAt))
		.orderBy(asc(billingCreditNotices.reachedAt))
		.limit(input.limit ?? 50);
	const result: PlanCreditNoticeDeliveriesResult = {
		notices: notices.length,
		queued: 0,
		stale: 0,
	};
	for (const notice of notices) {
		const stamp = db
			.update(billingCreditNotices)
			.set({ deliveriesPlannedAt: input.now })
			.where(
				and(
					eq(billingCreditNotices.organizationId, notice.organizationId),
					eq(billingCreditNotices.periodStart, notice.periodStart),
					eq(billingCreditNotices.threshold, notice.threshold),
					isNull(billingCreditNotices.deliveriesPlannedAt),
				),
			);
		const current =
			notice.accountPeriodStart === notice.periodStart &&
			notice.accountPeriodEnd !== null &&
			notice.accountPeriodEnd > input.now;
		if (!current) {
			await stamp;
			result.stale++;
			continue;
		}
		const recipients = await listCreditNoticeRecipients(
			db,
			notice.organizationId,
		);
		const inserts = recipients.flatMap((recipient) =>
			CREDIT_NOTICE_DELIVERY_CHANNELS.map((channel) =>
				db
					.insert(billingCreditNoticeDeliveries)
					.values({
						id: creditNoticeDeliveryId({
							organizationId: notice.organizationId,
							periodStart: notice.periodStart,
							threshold: notice.threshold,
							channel,
							recipientUserId: recipient.userId,
						}),
						organizationId: notice.organizationId,
						periodStart: notice.periodStart,
						threshold: notice.threshold,
						channel,
						recipientUserId: recipient.userId,
						recipientEmail: recipient.email,
						status: "pending",
						nextAttemptAt: input.now,
						createdAt: input.now,
						updatedAt: input.now,
					})
					.onConflictDoNothing(),
			),
		);
		// One batch: the rows and the stamp land together or not at all.
		await db.batch([stamp, ...inserts]);
		result.queued += inserts.length;
	}
	return result;
}

export interface ClaimedCreditNoticeDelivery extends BillingCreditNoticeDelivery {
	threshold: CreditNoticeThreshold;
	organizationName: string | null;
	periodEnd: string;
}

/** Rows that may be (re)sent now: pending, failed, or a lapsed lease. */
function claimable(now: string) {
	return and(
		inArray(billingCreditNoticeDeliveries.status, [
			"pending",
			"failed",
			"sending",
		]),
		lte(billingCreditNoticeDeliveries.nextAttemptAt, now),
		or(
			eq(billingCreditNoticeDeliveries.status, "pending"),
			eq(billingCreditNoticeDeliveries.status, "failed"),
			lte(billingCreditNoticeDeliveries.leaseExpiresAt, now),
		),
	);
}

/**
 * Expire rows whose period ended, then lease up to `limit` due rows. Only a
 * row whose organization is still in the notice's period is claimed.
 */
export async function claimCreditNoticeDeliveries(
	db: DbQueryClient,
	input: { now: string; leaseExpiresAt: string; limit: number },
): Promise<{ claimed: ClaimedCreditNoticeDelivery[]; expired: number }> {
	const expired = await db
		.update(billingCreditNoticeDeliveries)
		.set({ status: "expired", leaseExpiresAt: null, updatedAt: input.now })
		.where(
			and(
				inArray(billingCreditNoticeDeliveries.status, [
					"pending",
					"failed",
					"sending",
				]),
				or(
					eq(billingCreditNoticeDeliveries.status, "pending"),
					eq(billingCreditNoticeDeliveries.status, "failed"),
					lte(billingCreditNoticeDeliveries.leaseExpiresAt, input.now),
				),
				sql`NOT EXISTS (
					SELECT 1 FROM ${billingAccounts}
					WHERE ${billingAccounts.organizationId} = ${billingCreditNoticeDeliveries.organizationId}
						AND ${billingAccounts.periodStart} = ${billingCreditNoticeDeliveries.periodStart}
						AND ${billingAccounts.periodEnd} > ${input.now}
				)`,
			),
		)
		.returning({ id: billingCreditNoticeDeliveries.id });

	const candidates = await db
		.select({ id: billingCreditNoticeDeliveries.id })
		.from(billingCreditNoticeDeliveries)
		.where(claimable(input.now))
		.orderBy(asc(billingCreditNoticeDeliveries.createdAt))
		.limit(input.limit);
	const leased: BillingCreditNoticeDelivery[] = [];
	for (const chunk of chunkForBoundParams(
		candidates.map((row) => row.id),
		50,
	)) {
		leased.push(
			...(await db
				.update(billingCreditNoticeDeliveries)
				.set({
					status: "sending",
					leaseExpiresAt: input.leaseExpiresAt,
					updatedAt: input.now,
				})
				.where(
					and(
						inArray(billingCreditNoticeDeliveries.id, chunk),
						claimable(input.now),
					),
				)
				.returning()),
		);
	}
	if (leased.length === 0) return { claimed: [], expired: expired.length };

	const orgIds = [...new Set(leased.map((row) => row.organizationId))];
	const context = new Map<
		string,
		{ organizationName: string | null; periodStart: string; periodEnd: string }
	>();
	for (const chunk of chunkForBoundParams(orgIds, 50)) {
		const rows = await db
			.select({
				organizationId: billingAccounts.organizationId,
				organizationName: organizations.name,
				periodStart: billingAccounts.periodStart,
				periodEnd: billingAccounts.periodEnd,
			})
			.from(billingAccounts)
			.innerJoin(
				organizations,
				eq(organizations.id, billingAccounts.organizationId),
			)
			.where(inArray(billingAccounts.organizationId, chunk));
		for (const row of rows) context.set(row.organizationId, row);
	}
	const claimed: ClaimedCreditNoticeDelivery[] = [];
	for (const row of leased) {
		const org = context.get(row.organizationId);
		if (
			!org ||
			!(CREDIT_NOTICE_THRESHOLDS as readonly number[]).includes(row.threshold)
		)
			continue;
		claimed.push({
			...row,
			threshold: row.threshold as CreditNoticeThreshold,
			organizationName: org.organizationName,
			periodEnd: org.periodEnd,
		});
	}
	return { claimed, expired: expired.length };
}

export async function markCreditNoticeDeliverySent(
	db: DbQueryClient,
	input: { id: string; deliveryRef: string | null; now: string },
): Promise<void> {
	await db
		.update(billingCreditNoticeDeliveries)
		.set({
			status: "sent",
			deliveryRef: input.deliveryRef,
			sentAt: input.now,
			leaseExpiresAt: null,
			lastError: null,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingCreditNoticeDeliveries.id, input.id),
				eq(billingCreditNoticeDeliveries.status, "sending"),
			),
		);
}

export async function markCreditNoticeDeliveryFailed(
	db: DbQueryClient,
	input: {
		id: string;
		error: string;
		nextAttemptAt: string;
		now: string;
		maxAttempts?: number;
	},
): Promise<void> {
	const maxAttempts = input.maxAttempts ?? CREDIT_NOTICE_DELIVERY_MAX_ATTEMPTS;
	await db
		.update(billingCreditNoticeDeliveries)
		.set({
			status: sql`CASE WHEN ${billingCreditNoticeDeliveries.attemptCount} + 1 >= ${maxAttempts} THEN 'dead' ELSE 'failed' END`,
			attemptCount: sql`${billingCreditNoticeDeliveries.attemptCount} + 1`,
			nextAttemptAt: input.nextAttemptAt,
			leaseExpiresAt: null,
			lastError: input.error.slice(0, 2_000),
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingCreditNoticeDeliveries.id, input.id),
				eq(billingCreditNoticeDeliveries.status, "sending"),
			),
		);
}

/** A UUID-shaped id derived from the delivery id, stable across retries. */
export async function creditNoticeCardId(deliveryId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(deliveryId),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The organization's oldest active project; a Deck card needs one. */
export async function noticeProjectId(
	db: DbQueryClient,
	organizationId: string,
): Promise<string | null> {
	const [project] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(
			and(
				eq(projects.orgId, organizationId),
				eq(projects.status, "active"),
				// The private agent-review project is not a place for owner notices.
				sql`json_extract(${projects.metadata}, '$.agentReviewTriage') IS NULL`,
			),
		)
		.orderBy(asc(projects.createdAt), asc(projects.id))
		.limit(1);
	return project?.id ?? null;
}

/**
 * Put the notice on the admin's Deck. Returns the card id; an existing card
 * with the same id counts as delivered.
 */
export async function deliverCreditNoticeDeckCard(
	db: DbQueryClient,
	input: { delivery: ClaimedCreditNoticeDelivery; now: string },
): Promise<string> {
	const { delivery } = input;
	const id = await creditNoticeCardId(delivery.id);
	const existing = await getWorkInteraction(db, {
		orgId: delivery.organizationId,
		interactionId: id,
	});
	if (existing) return id;
	const projectId = await noticeProjectId(db, delivery.organizationId);
	if (!projectId) throw new Error("no_work_context: no active project");
	const copy = creditNoticeCopy({
		threshold: delivery.threshold,
		organizationName: delivery.organizationName,
	});
	const link = `[${CREDIT_NOTICE_LINK_LABEL}](${CREDIT_NOTICE_PATH})`;
	const decision = DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "decision",
		classId: "billing.credit_notice",
		proposal: copy.subject,
		whyNow: copy.story,
		recommendation: `Open ${link} to buy a credit pack or turn on pay-as-you-go.`,
		preview: {
			body: `Nothing is bought or changed from this card. You choose in ${CREDIT_NOTICE_LINK_LABEL}.`,
		},
		reversibility: "two_way",
		// An owner's spending choice: it belongs on the Deck, not the Feed.
		tasteOrStrategy: true,
		protectedEffects: [],
		blastRadius: "Tedis and code runs in your organization",
		confidence: null,
		costOfWaiting:
			delivery.threshold === 100
				? "Tedis and code runs stay paused until the month resets."
				: "At 100%, tedis and code runs pause until the month resets.",
		reasoning: copy.story,
		informational: true,
		options: [
			{
				id: "seen",
				label: "Got it",
				intent: "approve",
				consequence: "Closes this card. Nothing is bought or changed.",
				cost: "None",
			},
			{
				id: "later",
				label: "Later",
				intent: "later",
				consequence: "Keeps this card open.",
				cost: "None",
			},
		],
	});
	try {
		await createWorkInteraction(db, {
			id,
			orgId: delivery.organizationId,
			projectId,
			kind: "question",
			subject: copy.subject,
			prompt: `${copy.story}\n\n${link}`,
			creator: { type: "system", id: "tedix" },
			targetType: "user",
			targetId: delivery.recipientUserId,
			expiresAt: delivery.periodEnd,
			metadata: {
				schema: CREDIT_NOTICE_CARD_SCHEMA,
				threshold: delivery.threshold,
				periodStart: delivery.periodStart,
				deliveryId: delivery.id,
				triage: { status: "ok", urgency: "now" },
				decisionDeck: decision,
			},
			now: input.now,
		});
	} catch (error) {
		if (
			!(await getWorkInteraction(db, {
				orgId: delivery.organizationId,
				interactionId: id,
			}))
		)
			throw error;
	}
	return id;
}
