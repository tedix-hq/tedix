import { describe, expect, it } from "vite-plus/test";
import {
	resolveBillingSettlementMode,
	resolveInstallationEntitlementGrants,
} from "./billing-settlement-mode";

describe("billing settlement deployment policy", () => {
	it("fails closed when mode is missing or invalid", () => {
		expect(() => resolveBillingSettlementMode({})).toThrow(
			/TEDIX_BILLING_SETTLEMENT_MODE/,
		);
		expect(() =>
			resolveBillingSettlementMode({ TEDIX_BILLING_SETTLEMENT_MODE: "" }),
		).toThrow(/explicitly set/);
		expect(() =>
			resolveBillingSettlementMode({ TEDIX_BILLING_SETTLEMENT_MODE: "stripe" }),
		).toThrow(/explicitly set/);
	});

	it("does not infer settlement mode from Stripe credentials", () => {
		expect(() =>
			resolveBillingSettlementMode({
				STRIPE_SECRET_KEY: "sk_live_ignored",
			} as { TEDIX_BILLING_SETTLEMENT_MODE?: string }),
		).toThrow(/explicitly set/);
		expect(
			resolveBillingSettlementMode({
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
			}),
		).toBe("disabled");
	});

	it("parses non-secret installation grants", () => {
		expect(
			resolveInstallationEntitlementGrants({
				TEDIX_RUNTIME_ENTITLEMENT_GRANTS:
					'[{"key":"browser-runtime","status":"active","source":"operator"}]',
			}),
		).toEqual([
			{ key: "browser-runtime", status: "active", source: "operator" },
		]);
	});
});
