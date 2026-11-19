/**
 * Tell organization admins when monthly credits reach 80% or 100%: a Deck
 * card and an email per admin, once per notice and period.
 *
 * Runs on the 15-minute billing tick. Planning and the outbox live in
 * @tedix/db/queries/billing/credit-notice-deliveries; this module only sends.
 * A row is marked sent right after its send, so a retry never repeats a
 * delivery already recorded. If the worker stops between an email send and
 * its mark, the lease lapses and that one email can go out again; a Deck card
 * cannot, because its id is fixed.
 */

import {
	CREDIT_NOTICE_LINK_LABEL,
	CREDIT_NOTICE_PATH,
	creditNoticeCopy,
} from "@tedix/api-contract/utils/credit-notice-copy";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	type ClaimedCreditNoticeDelivery,
	claimCreditNoticeDeliveries,
	deliverCreditNoticeDeckCard,
	markCreditNoticeDeliveryFailed,
	markCreditNoticeDeliverySent,
	planCreditNoticeDeliveries,
} from "@tedix/db/queries/billing/credit-notice-deliveries";
import { sendTransactionalEmail } from "../lib/email";

const BATCH_SIZE = 100;
const LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_OS_URL = "https://os.tedix.dev";

export interface CreditNoticeDeliveryEnv {
	EMAIL?: SendEmail;
	OS_URL?: string;
}

export interface CreditNoticeDeliveryResult {
	planned: number;
	queued: number;
	expired: number;
	claimed: number;
	sent: number;
	failed: number;
}

/** Plain-text email: the story, then the link to Settings › Billing › Usage. */
export function creditNoticeEmail(
	delivery: Pick<ClaimedCreditNoticeDelivery, "threshold" | "organizationName">,
	osUrl: string | undefined,
): { subject: string; text: string } {
	const copy = creditNoticeCopy({
		threshold: delivery.threshold,
		organizationName: delivery.organizationName,
	});
	const url = new URL(
		CREDIT_NOTICE_PATH,
		osUrl?.trim() || DEFAULT_OS_URL,
	).toString();
	return {
		subject: copy.subject,
		text: `${copy.story}\n\nOpen ${CREDIT_NOTICE_LINK_LABEL}: ${url}`,
	};
}

function retryAt(attemptCount: number, nowMs: number): string {
	const delayMs = Math.min(
		6 * 60 * 60 * 1_000,
		60_000 * 2 ** Math.min(attemptCount, 10),
	);
	return new Date(nowMs + delayMs).toISOString();
}

async function deliver(
	env: CreditNoticeDeliveryEnv,
	db: DbQueryClient,
	row: ClaimedCreditNoticeDelivery,
	now: string,
): Promise<string | null> {
	if (row.channel === "deck")
		return deliverCreditNoticeDeckCard(db, { delivery: row, now });
	const email = creditNoticeEmail(row, env.OS_URL);
	const result = await sendTransactionalEmail(env, {
		from: { email: "noreply@tedix.tech", name: "Tedix Billing" },
		to: [{ email: row.recipientEmail }],
		subject: email.subject,
		text: email.text,
	});
	if (!result.sent) throw new Error(result.reason);
	return result.messageId ?? null;
}

export async function deliverCreditNotices(
	env: CreditNoticeDeliveryEnv,
	db: DbQueryClient,
	nowMs = Date.now(),
): Promise<CreditNoticeDeliveryResult> {
	const now = new Date(nowMs).toISOString();
	const plan = await planCreditNoticeDeliveries(db, { now });
	const { claimed, expired } = await claimCreditNoticeDeliveries(db, {
		now,
		leaseExpiresAt: new Date(nowMs + LEASE_MS).toISOString(),
		limit: BATCH_SIZE,
	});
	let sent = 0;
	let failed = 0;
	for (const row of claimed) {
		try {
			const deliveryRef = await deliver(env, db, row, now);
			await markCreditNoticeDeliverySent(db, {
				id: row.id,
				deliveryRef,
				now: new Date().toISOString(),
			});
			sent++;
		} catch (error) {
			failed++;
			const message = error instanceof Error ? error.message : String(error);
			await markCreditNoticeDeliveryFailed(db, {
				id: row.id,
				error: message,
				nextAttemptAt: retryAt(row.attemptCount + 1, nowMs),
				now: new Date().toISOString(),
			});
			console.warn(
				JSON.stringify({
					signal: "billing.credit_notice.delivery_failed",
					deliveryId: row.id,
					channel: row.channel,
					attempt: row.attemptCount + 1,
					error: message.slice(0, 240),
				}),
			);
		}
	}
	return {
		planned: plan.notices,
		queued: plan.queued,
		expired,
		claimed: claimed.length,
		sent,
		failed,
	};
}
