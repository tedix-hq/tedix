import { Hono } from "hono";
import type Stripe from "stripe";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
	markStripeWebhookEventFailed,
	markStripeWebhookEventProcessed,
} from "@tedix/db/queries/billing/stripe-webhooks";
import { getStripe } from "../lib/stripe";
import { handleStripeWebhook } from "./stripe";

vi.mock("@tedix/db/client", () => ({ createDbClient: vi.fn(() => ({})) }));
vi.mock("@tedix/db/queries/billing/stripe-webhooks", () => ({
	claimStripeWebhookEvent: vi.fn(),
	hasNewerProcessedStripeWebhookEvent: vi.fn(),
	markStripeWebhookEventFailed: vi.fn(),
	markStripeWebhookEventProcessed: vi.fn(),
}));
vi.mock("../lib/stripe", () => ({ getStripe: vi.fn() }));

const env = {
	DB: {} as D1Database,
	TEDIX_FLEET_AUTHORITY_MODE: "co-located",
	TEDIX_BILLING_SETTLEMENT_MODE: "managed",
	TEDIX_STRIPE_MODE: "test",
	STRIPE_TEST_SECRET_KEY: "sk_test_synthetic",
	STRIPE_TEST_WEBHOOK_SECRET: "whsec_synthetic",
	STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_synthetic",
} as CloudflareEnv;

const event = (type: string, object: Record<string, unknown>): Stripe.Event =>
	({
		id: "evt_synthetic",
		type,
		created: 1_753_750_000,
		data: { object },
	}) as Stripe.Event;

async function send(stripeEvent?: Stripe.Event, signatureError?: Error) {
	vi.mocked(getStripe).mockResolvedValue({
		webhooks: {
			constructEventAsync: signatureError
				? vi.fn().mockRejectedValue(signatureError)
				: vi.fn().mockResolvedValue(stripeEvent),
		},
	} as unknown as Stripe);
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.post("/webhook", (c) => handleStripeWebhook(c, "test"));
	return app.request(
		"/webhook",
		{
			method: "POST",
			headers: { "stripe-signature": "synthetic-signature" },
			body: JSON.stringify({ privateValue: "request-content" }),
		},
		env,
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(claimStripeWebhookEvent).mockResolvedValue({
		claimed: true,
		event: {
			eventId: "test:evt_synthetic",
			entityKey: "test:evt_synthetic",
			status: "processing",
		},
	} as never);
	vi.mocked(hasNewerProcessedStripeWebhookEvent).mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("Stripe webhook diagnostics", () => {
	it("redacts signature errors while preserving the 400 response", async () => {
		const marker = "private-signature-content";
		const response = await send(
			undefined,
			new Error(marker, { cause: new Error(marker) }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid signature" });
		const logs = vi.mocked(console.error).mock.calls.flat().join(" ");
		expect(logs).toContain("stripe.webhook.signature_failed");
		expect(logs).toContain('"causeChain"');
		expect(logs).not.toContain(marker);
		expect(claimStripeWebhookEvent).not.toHaveBeenCalled();
	});

	it("stores a redacted failure fingerprint and preserves retry state", async () => {
		const marker = "private-customer-and-query-content";
		vi.mocked(hasNewerProcessedStripeWebhookEvent).mockRejectedValueOnce(
			new Error(marker, { cause: new Error(marker) }),
		);
		const response = await send(
			event("customer.subscription.updated", { id: "sub_1" }),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Webhook processing failed",
		});
		expect(markStripeWebhookEventFailed).toHaveBeenCalledOnce();
		expect(markStripeWebhookEventProcessed).not.toHaveBeenCalled();
		const failure = vi.mocked(markStripeWebhookEventFailed).mock.calls[0]?.[1];
		expect(failure?.eventId).toBe("test:evt_synthetic");
		expect(failure?.error).not.toContain(marker);
		expect(JSON.parse(failure?.error ?? "{}")).toMatchObject({
			name: "Error",
			message: { sha256: expect.any(String) },
		});
		const logs = vi.mocked(console.error).mock.calls.flat().join(" ");
		expect(logs).toContain("stripe.webhook.processing_failed");
		expect(logs).toContain('"causeChain"');
		expect(logs).not.toContain(marker);
	});

	it("records a meter error outcome without logging the provider payload", async () => {
		const marker = "private-meter-report-content";
		const response = await send(
			event("billing_meter.error_report_triggered", {
				id: "bmr_1",
				providerPayload: marker,
			}),
		);
		expect(response.status).toBe(200);
		expect(markStripeWebhookEventProcessed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outcome: "observed_meter_error" }),
		);
		const logs = vi.mocked(console.error).mock.calls.flat().join(" ");
		expect(logs).toContain("stripe.webhook.billing_meter_error_report");
		expect(logs).not.toContain(marker);
	});
});
