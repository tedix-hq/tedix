/**
 * apps/api — Stripe test-mode meter certification (safe positive path).
 *
 * The production Stripe account only ever receives real billing traffic, so a
 * positive end-to-end meter-event certification must run in Stripe TEST mode.
 * This module owns the pure, unit-testable logic:
 *
 *   - explicit test-key verification that FAILS CLOSED for live keys
 *   - uniquely namespaced test artifacts (meter, customer, identifier)
 *   - a positive meter event mirroring the production outbox call shape
 *     (`drainStripeMeterOutbox`: event_name / identifier / stripe_customer_id
 *     / value, plus the HTTP idempotency key)
 *   - a duplicate re-send proving identifier-level idempotency
 *   - a secret-free machine-readable receipt
 *
 * `scripts/billing/certify-stripe-meter.ts` wires this against the real Stripe SDK.
 */

import { sleep as sleepDefault } from "@tedix/worker-kit/sleep";

export const CERT_NAMESPACE = "tedix-cert" as const;
/** Dedicated event name so certification never pollutes `token_usage`. */
export const CERT_METER_EVENT_NAME = "tedix_cert_token_usage" as const;
export const CERT_METER_VALUE = 1000 as const;

const HOUR_SECONDS = 3600;

/**
 * Stripe's meter event summaries reject a window whose bounds are not aligned
 * to the `value_grouping_window`. With hourly grouping, an unaligned
 * `start_time` fails the whole read, so both bounds are widened to the
 * enclosing hour rather than narrowed (never drop the events under test).
 */
export function floorToHour(epochSeconds: number): number {
	return Math.floor(epochSeconds / HOUR_SECONDS) * HOUR_SECONDS;
}

export function ceilToHour(epochSeconds: number): number {
	return Math.ceil(epochSeconds / HOUR_SECONDS) * HOUR_SECONDS;
}

export type TestKeyVerdict =
	| { ok: true; key: string }
	| { ok: false; reason: "missing" | "not_test_mode" };

/**
 * Only an explicit `sk_test_` secret is acceptable. Live (`sk_live_`),
 * restricted (`rk_*`), publishable (`pk_*`), and unrecognized keys all fail
 * closed — certification must be impossible to point at live Stripe.
 */
export function verifyTestModeKey(
	secretKey: string | undefined,
): TestKeyVerdict {
	const key = secretKey?.trim();
	if (!key) return { ok: false, reason: "missing" };
	if (!key.startsWith("sk_test_"))
		return { ok: false, reason: "not_test_mode" };
	return { ok: true, key };
}

export interface CertMeterEvent {
	eventName: string;
	identifier: string;
	payload: { stripe_customer_id: string; value: string };
	idempotencyKey: string;
}

/**
 * Build the positive certification meter event with the exact payload shape
 * `drainStripeMeterOutbox` sends in production. `runKey` must be stable for a
 * certification run so retries dedupe instead of double-counting.
 */
export function buildCertMeterEvent(input: {
	customerId: string;
	runKey: string;
}): CertMeterEvent {
	const identifier = `${CERT_NAMESPACE}:${input.runKey}`;
	return {
		eventName: CERT_METER_EVENT_NAME,
		identifier,
		payload: {
			stripe_customer_id: input.customerId,
			value: String(CERT_METER_VALUE),
		},
		idempotencyKey: identifier,
	};
}

/** Minimal Stripe surface the certification needs — mockable in unit tests. */
export interface CertStripeClient {
	retrieveAccountId(): Promise<string>;
	/** Find-or-create the namespaced certification meter; returns its id. */
	ensureMeter(eventName: string, idempotencyKey: string): Promise<string>;
	/** Find-or-create the namespaced certification customer; returns its id. */
	ensureCustomer(namespace: string, idempotencyKey: string): Promise<string>;
	createMeterEvent(event: CertMeterEvent): Promise<{ identifier: string }>;
	/**
	 * Aggregated value for the certification customer/meter over the window, or
	 * null when Stripe has not materialized the summary yet.
	 */
	readMeterSummaryValue(input: {
		meterId: string;
		customerId: string;
		startEpochSeconds: number;
		endEpochSeconds: number;
	}): Promise<number | null>;
}

export interface CertificationReceipt {
	harness: "stripe-meter-certification";
	mode: "certified" | "blocked" | "failed";
	keyMode: "test" | "missing" | "live_rejected";
	blockedReason?: string;
	error?: string;
	accountId?: string;
	meterId?: string;
	customerId?: string;
	eventName?: string;
	identifier?: string;
	firstSendAccepted?: boolean;
	duplicateSendAccepted?: boolean;
	idempotency?: "duplicate_identifier_accepted";
	summary?: {
		value: number | null;
		state: "confirmed" | "pending_aggregation";
	};
	startedAt?: string;
	finishedAt?: string;
}

/**
 * Run the positive certification against an already test-mode-verified client.
 * Never throws for expected outcomes — every path returns a receipt.
 */
export async function runMeterCertification(input: {
	stripe: CertStripeClient;
	runKey: string;
	now: () => Date;
	/** Bounded summary polling; certification does not hang on aggregation. */
	summaryPoll?: { attempts: number; delayMs: number };
	sleep?: (ms: number) => Promise<void>;
}): Promise<CertificationReceipt> {
	const startedAt = input.now().toISOString();
	const poll = input.summaryPoll ?? { attempts: 6, delayMs: 10_000 };
	const sleep = input.sleep ?? sleepDefault;
	try {
		const accountId = await input.stripe.retrieveAccountId();
		const meterId = await input.stripe.ensureMeter(
			CERT_METER_EVENT_NAME,
			`${CERT_NAMESPACE}:meter:${CERT_METER_EVENT_NAME}`,
		);
		const customerId = await input.stripe.ensureCustomer(
			CERT_NAMESPACE,
			`${CERT_NAMESPACE}:customer:v1`,
		);
		const event = buildCertMeterEvent({ customerId, runKey: input.runKey });
		const windowStart = Math.floor(input.now().getTime() / 1000) - 60;

		const first = await input.stripe.createMeterEvent(event);
		// Same identifier + same HTTP idempotency key: Stripe must accept the
		// duplicate without creating a second countable event.
		const duplicate = await input.stripe.createMeterEvent(event);

		let summaryValue: number | null = null;
		for (let attempt = 0; attempt < poll.attempts; attempt++) {
			if (attempt > 0) await sleep(poll.delayMs);
			summaryValue = await input.stripe.readMeterSummaryValue({
				meterId,
				customerId,
				startEpochSeconds: windowStart,
				endEpochSeconds: Math.floor(input.now().getTime() / 1000) + 60,
			});
			if (summaryValue !== null) break;
		}

		const doubleCounted =
			summaryValue !== null && summaryValue > CERT_METER_VALUE;
		if (doubleCounted) {
			return {
				harness: "stripe-meter-certification",
				mode: "failed",
				keyMode: "test",
				error: `duplicate identifier double-counted: summary=${summaryValue} expected<=${CERT_METER_VALUE}`,
				accountId,
				meterId,
				customerId,
				eventName: event.eventName,
				identifier: event.identifier,
				firstSendAccepted: first.identifier === event.identifier,
				duplicateSendAccepted: duplicate.identifier === event.identifier,
				summary: { value: summaryValue, state: "confirmed" },
				startedAt,
				finishedAt: input.now().toISOString(),
			};
		}

		return {
			harness: "stripe-meter-certification",
			mode: "certified",
			keyMode: "test",
			accountId,
			meterId,
			customerId,
			eventName: event.eventName,
			identifier: event.identifier,
			firstSendAccepted: first.identifier === event.identifier,
			duplicateSendAccepted: duplicate.identifier === event.identifier,
			idempotency: "duplicate_identifier_accepted",
			summary:
				summaryValue === null
					? { value: null, state: "pending_aggregation" }
					: { value: summaryValue, state: "confirmed" },
			startedAt,
			finishedAt: input.now().toISOString(),
		};
	} catch (error) {
		return {
			harness: "stripe-meter-certification",
			mode: "failed",
			keyMode: "test",
			error: error instanceof Error ? error.message : String(error),
			startedAt,
			finishedAt: input.now().toISOString(),
		};
	}
}

/** Receipt for a run that cannot start — never inspects live Stripe. */
export function blockedReceipt(
	verdict: Extract<TestKeyVerdict, { ok: false }>,
	now: Date,
): CertificationReceipt {
	return {
		harness: "stripe-meter-certification",
		mode: "blocked",
		keyMode: verdict.reason === "missing" ? "missing" : "live_rejected",
		blockedReason:
			verdict.reason === "missing"
				? "No STRIPE_TEST_SECRET_KEY available; external positive certification is blocked on a test-mode credential."
				: "Provided key is not an sk_test_ secret; refusing to certify against a non-test-mode Stripe environment.",
		startedAt: now.toISOString(),
		finishedAt: now.toISOString(),
	};
}
