/**
 * Unit tests for the Stripe test-mode meter certification.
 *
 * The external positive canary requires a real sk_test_ credential; these
 * tests certify every piece of harness behavior that must hold before that
 * credential exists:
 *   1. key verification fails closed for live/restricted/missing keys
 *   2. the meter event mirrors the production outbox call shape
 *   3. duplicate sends reuse the same identifier + idempotency key
 *   4. double-counted summaries fail certification
 *   5. receipts are machine-readable and secret-free
 */

import { describe, expect, it } from "vite-plus/test";
import {
	blockedReceipt,
	buildCertMeterEvent,
	CERT_METER_EVENT_NAME,
	CERT_METER_VALUE,
	type CertStripeClient,
	ceilToHour,
	floorToHour,
	runMeterCertification,
	verifyTestModeKey,
} from "./stripe-certification";

describe("verifyTestModeKey", () => {
	it("accepts an explicit sk_test_ secret", () => {
		expect(verifyTestModeKey("sk_test_abc123")).toEqual({
			ok: true,
			key: "sk_test_abc123",
		});
	});

	it("trims surrounding whitespace before validating", () => {
		expect(verifyTestModeKey("  sk_test_abc123  ")).toEqual({
			ok: true,
			key: "sk_test_abc123",
		});
	});

	it.each([
		["live secret", "sk_live_abc123"],
		["restricted key", "rk_live_abc123"],
		["restricted test key", "rk_test_abc123"],
		["publishable key", "pk_test_abc123"],
		["garbage", "not-a-key"],
	])("fails closed for a %s", (_label, key) => {
		expect(verifyTestModeKey(key)).toEqual({
			ok: false,
			reason: "not_test_mode",
		});
	});

	it.each([
		["undefined", undefined],
		["empty", ""],
		["whitespace", "   "],
	])("reports %s as missing", (_label, key) => {
		expect(verifyTestModeKey(key)).toEqual({ ok: false, reason: "missing" });
	});
});

describe("buildCertMeterEvent", () => {
	it("mirrors the production outbox payload shape", () => {
		const event = buildCertMeterEvent({
			customerId: "cus_cert",
			runKey: "tedix-cert-2026-07-29",
		});
		expect(event).toEqual({
			eventName: CERT_METER_EVENT_NAME,
			identifier: "tedix-cert:tedix-cert-2026-07-29",
			payload: { stripe_customer_id: "cus_cert", value: "1000" },
			idempotencyKey: "tedix-cert:tedix-cert-2026-07-29",
		});
	});

	it("keeps the identifier and HTTP idempotency key identical", () => {
		const event = buildCertMeterEvent({ customerId: "c", runKey: "r1" });
		expect(event.idempotencyKey).toBe(event.identifier);
	});

	it("never targets the production token_usage meter", () => {
		const event = buildCertMeterEvent({ customerId: "c", runKey: "r1" });
		expect(event.eventName).not.toBe("token_usage");
		expect(event.eventName.startsWith("tedix_cert_")).toBe(true);
	});
});

interface FakeState {
	meterEvents: Array<{ identifier: string; idempotencyKey: string }>;
	summaryValue: number | null;
	summaryReads: number;
}

function fakeStripe(state: FakeState): CertStripeClient {
	return {
		retrieveAccountId: () => Promise.resolve("acct_test_cert"),
		ensureMeter: () => Promise.resolve("mtr_cert"),
		ensureCustomer: () => Promise.resolve("cus_cert"),
		createMeterEvent: (event) => {
			state.meterEvents.push({
				identifier: event.identifier,
				idempotencyKey: event.idempotencyKey,
			});
			return Promise.resolve({ identifier: event.identifier });
		},
		readMeterSummaryValue: () => {
			state.summaryReads++;
			return Promise.resolve(state.summaryValue);
		},
	};
}

const fixedNow = () => new Date("2026-07-29T00:00:00.000Z");

describe("runMeterCertification", () => {
	it("certifies: two sends, one identifier, confirmed single-count summary", async () => {
		const state: FakeState = {
			meterEvents: [],
			summaryValue: CERT_METER_VALUE,
			summaryReads: 0,
		};
		const receipt = await runMeterCertification({
			stripe: fakeStripe(state),
			runKey: "run-1",
			now: fixedNow,
			summaryPoll: { attempts: 1, delayMs: 0 },
		});
		expect(receipt.mode).toBe("certified");
		expect(receipt.firstSendAccepted).toBe(true);
		expect(receipt.duplicateSendAccepted).toBe(true);
		expect(receipt.idempotency).toBe("duplicate_identifier_accepted");
		expect(receipt.summary).toEqual({
			value: CERT_METER_VALUE,
			state: "confirmed",
		});
		expect(state.meterEvents).toHaveLength(2);
		expect(state.meterEvents[0]).toEqual(state.meterEvents[1]);
	});

	it("fails certification when the duplicate double-counts", async () => {
		const state: FakeState = {
			meterEvents: [],
			summaryValue: CERT_METER_VALUE * 2,
			summaryReads: 0,
		};
		const receipt = await runMeterCertification({
			stripe: fakeStripe(state),
			runKey: "run-1",
			now: fixedNow,
			summaryPoll: { attempts: 1, delayMs: 0 },
		});
		expect(receipt.mode).toBe("failed");
		expect(receipt.error).toContain("double-counted");
	});

	it("stays certified with pending_aggregation when Stripe has no summary yet", async () => {
		const state: FakeState = {
			meterEvents: [],
			summaryValue: null,
			summaryReads: 0,
		};
		const receipt = await runMeterCertification({
			stripe: fakeStripe(state),
			runKey: "run-1",
			now: fixedNow,
			summaryPoll: { attempts: 3, delayMs: 5 },
			sleep: () => Promise.resolve(),
		});
		expect(receipt.mode).toBe("certified");
		expect(receipt.summary).toEqual({
			value: null,
			state: "pending_aggregation",
		});
		expect(state.summaryReads).toBe(3);
	});

	it("returns a failed receipt instead of throwing on Stripe errors", async () => {
		const state: FakeState = {
			meterEvents: [],
			summaryValue: null,
			summaryReads: 0,
		};
		const stripe = fakeStripe(state);
		stripe.createMeterEvent = () =>
			Promise.reject(new Error("stripe unavailable"));
		const receipt = await runMeterCertification({
			stripe,
			runKey: "run-1",
			now: fixedNow,
			summaryPoll: { attempts: 1, delayMs: 0 },
		});
		expect(receipt.mode).toBe("failed");
		expect(receipt.error).toBe("stripe unavailable");
	});
});

describe("blockedReceipt", () => {
	it("reports a missing credential as exactly blocked", () => {
		const receipt = blockedReceipt(
			{ ok: false, reason: "missing" },
			new Date("2026-07-29T00:00:00.000Z"),
		);
		expect(receipt.mode).toBe("blocked");
		expect(receipt.keyMode).toBe("missing");
		expect(receipt.blockedReason).toContain("STRIPE_TEST_SECRET_KEY");
	});

	it("reports a live key as rejected, not blocked-on-credential", () => {
		const receipt = blockedReceipt(
			{ ok: false, reason: "not_test_mode" },
			new Date("2026-07-29T00:00:00.000Z"),
		);
		expect(receipt.keyMode).toBe("live_rejected");
		expect(receipt.blockedReason).toContain("sk_test_");
	});

	it("never embeds key material in the receipt", () => {
		const receipt = blockedReceipt(
			{ ok: false, reason: "not_test_mode" },
			new Date(),
		);
		expect(JSON.stringify(receipt)).not.toContain("sk_live");
	});
});

describe("hour alignment for meter event summaries", () => {
	// Regression: the first live certification run failed with
	// "start_time … should be aligned with hourly boundaries" because the window
	// was built from now±60s. Stripe rejects unaligned bounds when
	// value_grouping_window is "hour".
	const noon = 1_785_445_200; // exactly on an hour boundary

	it("leaves an already-aligned timestamp untouched", () => {
		expect(floorToHour(noon)).toBe(noon);
		expect(ceilToHour(noon)).toBe(noon);
	});

	it("widens an unaligned window outward, never inward", () => {
		const start = noon + 2545; // the exact offset that failed live
		const end = noon + 2665;
		expect(floorToHour(start)).toBe(noon);
		expect(ceilToHour(end)).toBe(noon + 3600);
		// The widened window must still contain the original bounds.
		expect(floorToHour(start)).toBeLessThanOrEqual(start);
		expect(ceilToHour(end)).toBeGreaterThanOrEqual(end);
	});

	it("produces bounds divisible by 3600 for arbitrary inputs", () => {
		for (const t of [0, 1, 3599, 3601, 1_785_447_745, 1_999_999_999]) {
			expect(floorToHour(t) % 3600).toBe(0);
			expect(ceilToHour(t) % 3600).toBe(0);
		}
	});
});
