#!/usr/bin/env bun
/**
 * Positive Stripe meter certification — TEST MODE ONLY.
 *
 * Usage (requires an explicit test-mode secret; the live STRIPE_SECRET_KEY is
 * deliberately ignored):
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_... bun run scripts/billing/certify-stripe-meter.ts
 *
 * Behavior:
 *   - no key            → prints a `blocked` receipt, exit 2
 *   - non-sk_test_ key  → prints a `blocked` (live_rejected) receipt, exit 3
 *   - sk_test_ key      → runs the namespaced positive certification and
 *                         prints a `certified`/`failed` receipt (exit 0/1)
 *
 * The receipt is machine-readable JSON on stdout and never contains secrets.
 * Test artifacts are uniquely namespaced (`tedix-cert`) and idempotent, so
 * repeated runs adopt the same meter/customer instead of accumulating junk.
 */

import Stripe from "stripe";
import {
	blockedReceipt,
	CERT_NAMESPACE,
	type CertStripeClient,
	ceilToHour,
	floorToHour,
	runMeterCertification,
	verifyTestModeKey,
} from "../../src/lib/stripe-certification";

const verdict = verifyTestModeKey(process.env.STRIPE_TEST_SECRET_KEY);
if (!verdict.ok) {
	console.log(JSON.stringify(blockedReceipt(verdict, new Date()), null, 2));
	process.exit(verdict.reason === "missing" ? 2 : 3);
}

const stripe = new Stripe(verdict.key, {
	httpClient: Stripe.createFetchHttpClient(),
});

const client: CertStripeClient = {
	async retrieveAccountId() {
		return (await stripe.accounts.retrieve()).id;
	},
	async ensureMeter(eventName, idempotencyKey) {
		const meters = await stripe.billing.meters
			.list({ limit: 100 })
			.autoPagingToArray({ limit: 1_000 });
		const existing = meters.find(
			(meter) => meter.event_name === eventName && meter.status === "active",
		);
		if (existing) return existing.id;
		const created = await stripe.billing.meters.create(
			{
				display_name: "Tedix Certification Token Usage",
				event_name: eventName,
				default_aggregation: { formula: "sum" },
				customer_mapping: {
					event_payload_key: "stripe_customer_id",
					type: "by_id",
				},
				value_settings: { event_payload_key: "value" },
			},
			{ idempotencyKey },
		);
		return created.id;
	},
	async ensureCustomer(namespace, idempotencyKey) {
		const found = await stripe.customers.search({
			query: `metadata["tedix_cert_namespace"]:"${namespace}"`,
			limit: 1,
		});
		if (found.data[0]) return found.data[0].id;
		const created = await stripe.customers.create(
			{
				name: "Tedix Meter Certification",
				metadata: { tedix_cert_namespace: namespace, tedix_managed: "true" },
			},
			{ idempotencyKey },
		);
		return created.id;
	},
	async createMeterEvent(event) {
		const created = await stripe.billing.meterEvents.create(
			{
				event_name: event.eventName,
				identifier: event.identifier,
				payload: event.payload,
			},
			{ idempotencyKey: event.idempotencyKey },
		);
		return { identifier: created.identifier };
	},
	async readMeterSummaryValue(input) {
		const summaries = await stripe.billing.meters.listEventSummaries(
			input.meterId,
			{
				customer: input.customerId,
				// Stripe rejects bounds that are not aligned to the grouping window.
				start_time: floorToHour(input.startEpochSeconds),
				end_time: ceilToHour(input.endEpochSeconds),
				value_grouping_window: "hour",
			},
		);
		if (summaries.data.length === 0) return null;
		return summaries.data.reduce(
			(total, row) => total + row.aggregated_value,
			0,
		);
	},
};

// One certification identity per UTC day: reruns the same day exercise the
// duplicate-identifier path end to end instead of minting new events.
const runKey = `${CERT_NAMESPACE}-${new Date().toISOString().slice(0, 10)}`;
const receipt = await runMeterCertification({
	stripe: client,
	runKey,
	now: () => new Date(),
});
console.log(JSON.stringify(receipt, null, 2));
process.exit(receipt.mode === "certified" ? 0 : 1);
