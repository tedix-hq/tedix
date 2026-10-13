/**
 * A Stripe webhook projects the plan version the subscriber's price was sold
 * under. Publishing a newer catalog row (the EUR v4 launch plans) must not move
 * an existing USD subscriber onto it on their next subscription or invoice
 * event; only a plan the customer picks resolves the newest row, in the
 * currency of the price they pay.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { getBillingEntitlement } from "@tedix/db/queries/billing/plans";
import {
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
} from "@tedix/db/queries/billing/stripe-webhooks";
import { billingAccounts, billingPlanVersions } from "@tedix/db/schema/billing";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { getStripe } from "../lib/stripe";
import { handleStripeWebhook } from "./stripe";

vi.mock("@tedix/db/queries/billing/stripe-webhooks", () => ({
	claimStripeWebhookEvent: vi.fn(),
	hasNewerProcessedStripeWebhookEvent: vi.fn(),
	markStripeWebhookEventFailed: vi.fn(),
	markStripeWebhookEventProcessed: vi.fn(),
}));
vi.mock("../lib/stripe", () => ({ getStripe: vi.fn() }));

const now = "2026-10-13T09:00:00.000Z";

function setup(accountPlanVersionId: string) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, billingPlanVersions, billingAccounts));
	const plan = (
		id: string,
		planKey: string,
		version: number,
		currency: string,
	) =>
		`('${id}','${planKey}',${version},'active','${planKey}','${currency}',1000000,1,10,16,1000000,200,'2026-01-01T00:00:00.000Z','${now}')`;
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES ('org','Fictional','fictional');
 INSERT INTO billing_plan_versions(id,plan_key,version,status,name,currency,included_monthly_tokens,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at) VALUES
 ${plan("starter-v1", "starter", 1, "usd")},
 ${plan("growth-v3", "growth", 3, "usd")},
 ${plan("growth-eur-v4", "growth", 4, "eur")},
 ${plan("business-v3", "business", 3, "usd")},
 ${plan("business-eur-v4", "business", 4, "eur")};
 INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,stripe_environment,stripe_customer_id,stripe_subscription_id,period_start,period_end,created_at,updated_at) VALUES ('org','${accountPlanVersionId}','active','stripe','test','cus_fixture','sub_fixture','2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','${now}','${now}');`);
	return {
		DB: createD1Facade(sqlite),
		TEDIX_FLEET_AUTHORITY_MODE: "co-located",
		TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		TEDIX_STRIPE_MODE: "test",
		STRIPE_TEST_SECRET_KEY: "sk_test_synthetic",
		STRIPE_TEST_WEBHOOK_SECRET: "whsec_synthetic",
		STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_synthetic",
	} as unknown as CloudflareEnv;
}

function subscription(
	lookupKey: string,
	currency: string,
): Stripe.Subscription {
	return {
		id: "sub_fixture",
		customer: "cus_fixture",
		status: "active",
		cancel_at_period_end: false,
		metadata: { organizationId: "org" },
		items: {
			data: [
				{
					id: "si_plan",
					current_period_start: 1_791_000_000,
					current_period_end: 1_793_600_000,
					price: {
						lookup_key: lookupKey,
						currency,
						recurring: { interval: "month" },
					},
				},
			],
		},
	} as unknown as Stripe.Subscription;
}

async function deliver(
	env: CloudflareEnv,
	type: string,
	object: Record<string, unknown>,
	current: Stripe.Subscription,
) {
	vi.mocked(getStripe).mockResolvedValue({
		webhooks: {
			constructEventAsync: vi.fn().mockResolvedValue({
				id: `evt_${type}`,
				type,
				created: 1_791_000_000,
				data: { object },
			}),
		},
		subscriptions: { retrieve: vi.fn().mockResolvedValue(current) },
		invoices: { retrieve: vi.fn().mockResolvedValue(object) },
	} as unknown as Stripe);
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.post("/webhook", (c) => handleStripeWebhook(c, "test"));
	const response = await app.request(
		"/webhook",
		{
			method: "POST",
			headers: { "stripe-signature": "synthetic-signature" },
			body: "{}",
		},
		env,
	);
	expect(response.status).toBe(200);
	const entitlement = await getBillingEntitlement(
		createDbClient(env.DB),
		"org",
	);
	return entitlement?.plan.id;
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(claimStripeWebhookEvent).mockResolvedValue({
		claimed: true,
		event: { status: "processing" },
	} as never);
	vi.mocked(hasNewerProcessedStripeWebhookEvent).mockResolvedValue(false);
});

const invoice = {
	id: "in_renewal",
	customer: "cus_fixture",
	status: "paid",
	attempt_count: 2,
	parent: { subscription_details: { subscription: "sub_fixture" } },
};

describe("Stripe plan version projection", () => {
	it("keeps a USD subscriber on their plan version through renewal events", async () => {
		const env = setup("growth-v3");
		const usd = subscription("tedix_growth_month_v3", "usd");
		expect(await deliver(env, "customer.subscription.updated", usd, usd)).toBe(
			"growth-v3",
		);
		expect(await deliver(env, "invoice.paid", invoice, usd)).toBe("growth-v3");
		expect(
			await deliver(
				env,
				"invoice.payment_failed",
				{ ...invoice, status: "open" },
				{ ...usd, status: "past_due" } as Stripe.Subscription,
			),
		).toBe("growth-v3");
	});

	it("resolves a plan change to the newest version in the price's currency", async () => {
		const env = setup("growth-v3");
		const usdBusiness = subscription("tedix_business_month_v3", "usd");
		expect(
			await deliver(
				env,
				"customer.subscription.updated",
				usdBusiness,
				usdBusiness,
			),
		).toBe("business-v3");
		const eurGrowth = subscription("tedix_growth_month_v4", "eur");
		expect(
			await deliver(env, "customer.subscription.updated", eurGrowth, eurGrowth),
		).toBe("growth-eur-v4");
	});
});
