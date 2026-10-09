/**
 * Checkout resolves every Stripe price by lookup key in both Stripe modes, so
 * an installation needs no stored Stripe price ids.
 */

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const stripe = vi.hoisted(() => ({
	prices: { list: vi.fn() },
	checkout: { sessions: { create: vi.fn() } },
}));
vi.mock("../../lib/stripe", () => ({ getStripe: async () => stripe }));

const storage = vi.hoisted(() => ({
	entitlement: vi.fn(),
	plan: vi.fn(),
	pack: vi.fn(),
	balance: vi.fn(),
}));
vi.mock("@tedix/db/queries/billing/plans", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/billing/plans")>()),
	getBillingEntitlement: storage.entitlement,
	getActiveBillingPlanByKey: storage.plan,
}));
vi.mock("@tedix/db/queries/billing/capacity-packs", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/billing/capacity-packs")
	>()),
	getActiveInferenceCapacityPackByKey: storage.pack,
}));
vi.mock("@tedix/db/queries/billing/credits", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/billing/credits")
	>()),
	getBillingBalanceSnapshot: storage.balance,
}));

import { billingContractRouter } from "./billing";

const organizationId = "5eed0026-0000-4000-8000-000000000026";

function context(mode: "test" | "live"): BaseContext {
	return {
		authType: "user",
		organizationId,
		userRole: "owner",
		db: {},
		env: {
			ENVIRONMENT: "test",
			OS_URL: "https://os.example.test",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			TEDIX_STRIPE_MODE: mode,
			DB: {},
			STRIPE_SECRET_KEY: "sk_live_example",
			STRIPE_WEBHOOK_SECRET: "whsec_live",
			STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_live",
			STRIPE_TEST_SECRET_KEY: "sk_test_example",
			STRIPE_TEST_WEBHOOK_SECRET: "whsec_test",
			STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_test",
		},
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc/billing"),
		user: {
			sub: "owner",
			permissions: ["billing:read", "billing:manage"],
			roles: [],
		},
	} as unknown as BaseContext;
}

function planRow(planKey: string, sellsOverage: boolean) {
	return {
		id: `${planKey}-v3`,
		planKey,
		name: planKey,
		allowOverage: true,
		overageUnitPriceMicros: sellsOverage ? 50_000 : 0,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	stripe.prices.list.mockImplementation(
		async ({ lookup_keys }: { lookup_keys: string[] }) => ({
			data: [{ id: `price_for_${lookup_keys[0]}` }],
		}),
	);
	stripe.checkout.sessions.create.mockResolvedValue({
		id: "cs_1",
		url: "https://checkout.stripe.com/c/cs_1",
	});
	storage.entitlement.mockResolvedValue({
		account: {
			status: "active",
			billingMode: "trial",
			stripeEnvironment: null,
			stripeCustomerId: null,
			stripeSubscriptionId: null,
		},
		plan: { allowOverage: false },
	});
	storage.balance.mockResolvedValue({ isSponsoredCustomer: false });
});

describe("subscription checkout", () => {
	for (const mode of ["test", "live"] as const) {
		it(`resolves plan and overage prices by lookup key (${mode})`, async () => {
			storage.plan.mockResolvedValue(planRow("growth", true));
			const client = createRouterClient(billingContractRouter, {
				context: context(mode),
			});

			const result = await client.createCheckout({
				tier: "growth",
				interval: "year",
			});

			expect(result.stripeEnvironment).toBe(mode);
			expect(
				stripe.prices.list.mock.calls.map(([params]) => params.lookup_keys),
			).toEqual([["tedix_growth_year_v3"], ["tedix_token_overage_v3"]]);
			const [params] = stripe.checkout.sessions.create.mock.calls[0];
			expect(params.line_items).toEqual([
				{ price: "price_for_tedix_growth_year_v3", quantity: 1 },
				{ price: "price_for_tedix_token_overage_v3" },
			]);
		});
	}

	it("collects the business declaration, address and tax ID at checkout", async () => {
		storage.plan.mockResolvedValue(planRow("growth", true));
		const client = createRouterClient(billingContractRouter, {
			context: context("live"),
		});

		await client.createCheckout({ tier: "growth", interval: "month" });

		const [params] = stripe.checkout.sessions.create.mock.calls[0];
		expect(params.billing_address_collection).toBe("required");
		expect(params.tax_id_collection).toEqual({ enabled: true });
		expect(params.custom_text.submit.message).toContain("§ 14 BGB");
		expect(params.custom_text.submit.message).toContain("§ 19 UStG");
		expect(params.consent_collection).toBeUndefined();
	});

	it("omits overage for a plan that does not price it (live)", async () => {
		storage.plan.mockResolvedValue(planRow("enterprise", false));
		const client = createRouterClient(billingContractRouter, {
			context: context("live"),
		});

		await client.createCheckout({ tier: "enterprise", interval: "month" });

		expect(
			stripe.prices.list.mock.calls.map(([params]) => params.lookup_keys),
		).toEqual([["tedix_enterprise_month_v3"]]);
		const [params] = stripe.checkout.sessions.create.mock.calls[0];
		expect(params.line_items).toEqual([
			{ price: "price_for_tedix_enterprise_month_v3", quantity: 1 },
		]);
	});

	it("fails when the Stripe account has no price for the lookup key", async () => {
		storage.plan.mockResolvedValue(planRow("business", true));
		stripe.prices.list.mockResolvedValue({ data: [] });
		const client = createRouterClient(billingContractRouter, {
			context: context("live"),
		});

		await expect(
			client.createCheckout({ tier: "business", interval: "month" }),
		).rejects.toThrow(
			"Stripe has no active price with lookup key tedix_business_month_v3",
		);
		expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});
});

describe("inference capacity checkout", () => {
	it("resolves the pack price by lookup key in live mode", async () => {
		storage.pack.mockResolvedValue({
			id: "inference-capacity-daily-1m-live-v1",
			packKey: "daily_1m",
			stripeLookupKey: "tedix_inference_capacity_daily_1m_v1",
		});
		const client = createRouterClient(billingContractRouter, {
			context: context("live"),
		});

		await client.createInferenceCapacityCheckout({ packKey: "daily_1m" });

		const [params] = stripe.checkout.sessions.create.mock.calls[0];
		expect(params.line_items).toEqual([
			{ price: "price_for_tedix_inference_capacity_daily_1m_v1", quantity: 1 },
		]);
	});
});
