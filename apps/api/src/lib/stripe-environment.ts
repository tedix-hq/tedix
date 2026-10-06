import type { StripeEnvironment } from "@tedix/api-contract/schemas/billing";

export type { StripeEnvironment } from "@tedix/api-contract/schemas/billing";

type StripeEnvironmentBindings = {
	TEDIX_STRIPE_MODE?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_TEST_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_TEST_WEBHOOK_SECRET?: string;
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
	STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID?: string;
};

export interface StripeEnvironmentConfig {
	environment: StripeEnvironment;
	secretKey: string;
	webhookSecret: string;
	portalConfigurationId: string;
}

function requireValue(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing ${name}`);
	return value.trim();
}

function assertKeyMode(
	secretKey: string,
	environment: StripeEnvironment,
): void {
	if (environment === "test" && !secretKey.startsWith("sk_test_")) {
		throw new Error("STRIPE_TEST_SECRET_KEY is not a Stripe test-mode key");
	}
	if (
		environment === "live" &&
		!secretKey.startsWith("sk_live_") &&
		!secretKey.startsWith("rk_live_")
	) {
		throw new Error("STRIPE_SECRET_KEY is not a Stripe live-mode key");
	}
}

/**
 * Resolve the only Stripe environment an API invocation may use.
 *
 * `TEDIX_STRIPE_MODE=live` is the single live-payments switch, deployed beside
 * `TEDIX_BILLING_SETTLEMENT_MODE`. Any other value, including a missing one,
 * selects test mode, so a configuration regression cannot charge a live
 * payment method.
 */
export function resolveStripeEnvironment(
	env: Pick<StripeEnvironmentBindings, "TEDIX_STRIPE_MODE">,
): StripeEnvironment {
	return env.TEDIX_STRIPE_MODE === "live" ? "live" : "test";
}

export function getStripeEnvironmentConfig(
	env: StripeEnvironmentBindings,
	environment: StripeEnvironment,
): StripeEnvironmentConfig {
	const config =
		environment === "test"
			? {
					secretKey: requireValue(
						env.STRIPE_TEST_SECRET_KEY,
						"STRIPE_TEST_SECRET_KEY",
					),
					webhookSecret: requireValue(
						env.STRIPE_TEST_WEBHOOK_SECRET,
						"STRIPE_TEST_WEBHOOK_SECRET",
					),
					portalConfigurationId: requireValue(
						env.STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID,
						"STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID",
					),
				}
			: {
					secretKey: requireValue(env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"),
					webhookSecret: requireValue(
						env.STRIPE_WEBHOOK_SECRET,
						"STRIPE_WEBHOOK_SECRET",
					),
					portalConfigurationId: requireValue(
						env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
						"STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
					),
				};
	assertKeyMode(config.secretKey, environment);
	return { environment, ...config };
}
