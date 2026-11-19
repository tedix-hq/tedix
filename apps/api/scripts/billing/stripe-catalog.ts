import { readFileSync } from "node:fs";
import {
	CREDIT_VALUE_EUR_MICROS,
	TOP_UP_VALID_MONTHS,
} from "@tedix/api-contract/utils/credit-pricing";
import { z } from "zod";

const text = z.string().trim().min(1).max(500);
const key = z
	.string()
	.regex(/^[a-z][a-z0-9_]*$/)
	.max(80);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const httpsUrl = z.url().refine((value) => value.startsWith("https://"), {
	message: "Expected an HTTPS URL",
});

/** Pay-as-you-go credits are metered under this event (see billing/credit-pool). */
export const CREDIT_METER_EVENT_NAME = "tedix_credits";

/** One credit in EUR cents: EUR 0.01. */
export const CREDIT_UNIT_AMOUNT_CENTS = CREDIT_VALUE_EUR_MICROS / 10_000;

/**
 * The approved one-time top-up packs (owner approval 19 Nov 2026). The lookup
 * keys match billing_top_up_pack_versions rows seeded by the credits backfill
 * migration, so checkout resolves the price D1 sells.
 */
export const CREDIT_TOP_UP_PACKS = [1_000, 5_000, 10_000, 25_000, 50_000].map(
	(credits) => ({
		credits,
		productKey: `credit_top_up_${credits}`,
		name: `${credits.toLocaleString("en-US")} Tedix credits`,
		unitAmount: credits * CREDIT_UNIT_AMOUNT_CENTS,
		lookupKey: `tedix_credits_${credits}_eur_v1`,
		validMonths: TOP_UP_VALID_MONTHS,
	}),
);

/** Product keys of the retired daily-boost packs, archived on apply. */
export const RETIRED_PRODUCT_KEY_PREFIX = "inference_capacity_";
/** Product key of the retired token overage product, archived on apply. */
export const RETIRED_TOKEN_OVERAGE_PRODUCT_KEY = "token_overage";

/** Operator configuration for plan prices and presentation. */
export const StripeBillingCatalogSchema = z
	.strictObject({
		version: z.literal(1),
		catalogVersion: z.number().int().positive(),
		currency: z.literal("eur"),
		priceLabel: text,
		meter: z.strictObject({ displayName: text }),
		payAsYouGo: z.strictObject({ productName: text, nickname: text }),
		plans: z
			.array(
				z.strictObject({
					key,
					name: text,
					monthlyAmount: amount,
					annualAmount: amount,
				}),
			)
			.min(1)
			.max(100),
		portal: z.strictObject({
			name: text,
			headline: text,
			privacyPolicyUrl: httpsUrl,
			termsOfServiceUrl: httpsUrl,
		}),
	})
	.superRefine((catalog, ctx) => {
		const keys = [
			"pay_as_you_go_credits",
			RETIRED_TOKEN_OVERAGE_PRODUCT_KEY,
			...catalog.plans.map((plan) => plan.key),
			...CREDIT_TOP_UP_PACKS.map((pack) => pack.productKey),
		];
		if (
			new Set(keys).size !== keys.length ||
			catalog.plans.some((plan) =>
				plan.key.startsWith(RETIRED_PRODUCT_KEY_PREFIX),
			)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Product keys must be unique, including reserved product keys",
			});
		}
	});

export function loadBillingCatalog(
	args: string[],
	env: Record<string, string | undefined>,
) {
	const positions = args.flatMap((arg, index) =>
		arg === "--catalog" ? [index] : [],
	);
	if (positions.length > 1) throw new Error("Pass --catalog only once");
	const argumentPath = positions.length ? args[positions[0]! + 1] : undefined;
	if (positions.length && (!argumentPath || argumentPath.startsWith("--"))) {
		throw new Error("--catalog requires a JSON file path");
	}
	const path = argumentPath ?? env.STRIPE_BILLING_CATALOG_FILE?.trim();
	if (!path)
		throw new Error(
			"Missing billing catalog: pass --catalog <private JSON file> or STRIPE_BILLING_CATALOG_FILE",
		);
	return StripeBillingCatalogSchema.parse(
		JSON.parse(readFileSync(path, "utf8")),
	);
}
