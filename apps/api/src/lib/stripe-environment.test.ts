import { describe, expect, it } from "vite-plus/test";
import {
	getStripeEnvironmentConfig,
	resolveStripeEnvironment,
} from "./stripe-environment";

const config = {
	STRIPE_TEST_SECRET_KEY: "sk_test_disposable",
	STRIPE_TEST_WEBHOOK_SECRET: "whsec_test",
	STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_test",
	STRIPE_SECRET_KEY: "sk_live_disposable",
	STRIPE_WEBHOOK_SECRET: "whsec_live",
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_live",
};

describe("Stripe environment gate", () => {
	it("selects live only when TEDIX_STRIPE_MODE is exactly live", () => {
		expect(resolveStripeEnvironment({ TEDIX_STRIPE_MODE: "live" })).toBe(
			"live",
		);
	});

	it("fails safe to test mode for a missing or unexpected setting", () => {
		for (const TEDIX_STRIPE_MODE of [undefined, "", "test", "LIVE", "true"]) {
			expect(resolveStripeEnvironment({ TEDIX_STRIPE_MODE })).toBe("test");
		}
	});

	it("rejects credentials from the wrong Stripe mode", () => {
		expect(() =>
			getStripeEnvironmentConfig(
				{ ...config, STRIPE_TEST_SECRET_KEY: "sk_live_wrong" },
				"test",
			),
		).toThrow("not a Stripe test-mode key");
		expect(() =>
			getStripeEnvironmentConfig(
				{ ...config, STRIPE_SECRET_KEY: "sk_test_wrong" },
				"live",
			),
		).toThrow("not a Stripe live-mode key");
	});

	it("returns an internally consistent configuration bundle", () => {
		expect(getStripeEnvironmentConfig(config, "test")).toEqual({
			environment: "test",
			secretKey: "sk_test_disposable",
			webhookSecret: "whsec_test",
			portalConfigurationId: "bpc_test",
		});
	});
});
