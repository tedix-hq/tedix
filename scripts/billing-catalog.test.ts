import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CREDIT_TOP_UP_PACKS,
	loadBillingCatalog,
	StripeBillingCatalogSchema,
} from "../apps/api/scripts/billing/stripe-catalog";

const fixture = () => ({
	version: 1 as const,
	catalogVersion: 9,
	currency: "eur" as const,
	priceLabel: "Example",
	meter: { displayName: "Example credits" },
	payAsYouGo: {
		productName: "Example pay-as-you-go credits",
		nickname: "Example credit price",
	},
	plans: [
		{
			key: "starter",
			name: "Example Starter",
			monthlyAmount: 123,
			annualAmount: 1400,
		},
	],
	portal: {
		name: "Example portal",
		headline: "Manage Example",
		privacyPolicyUrl: "https://example.com/privacy",
		termsOfServiceUrl: "https://example.com/terms",
	},
});

test("the full commercial projection comes from explicit configuration", () => {
	const dir = mkdtempSync(join(tmpdir(), "billing-catalog-"));
	try {
		const path = join(dir, "catalog.json");
		writeFileSync(path, JSON.stringify(fixture()));
		expect(loadBillingCatalog(["--catalog", path], {})).toEqual(fixture());
		expect(
			loadBillingCatalog([], { STRIPE_BILLING_CATALOG_FILE: path }),
		).toEqual(fixture());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing or ambiguous catalog selection fails without a commercial fallback", () => {
	expect(() => loadBillingCatalog([], {})).toThrow("Missing billing catalog");
	expect(() => loadBillingCatalog(["--catalog", "--apply"], {})).toThrow(
		"requires a JSON file path",
	);
	expect(() =>
		loadBillingCatalog(["--catalog", "a", "--catalog", "b"], {}),
	).toThrow("only once");
});

test("invalid values and unknown keys cannot silently become provider prices", () => {
	for (const patch of [
		{ currency: "EURO" },
		{ currency: "usd" },
		{ catalogVersion: 0 },
		{ surprise: true },
	]) {
		expect(
			StripeBillingCatalogSchema.safeParse({ ...fixture(), ...patch }).success,
		).toBe(false);
	}
	const invalid = fixture();
	invalid.plans[0]!.monthlyAmount = -1;
	expect(StripeBillingCatalogSchema.safeParse(invalid).success).toBe(false);
	invalid.plans[0]!.monthlyAmount = 1.5;
	expect(StripeBillingCatalogSchema.safeParse(invalid).success).toBe(false);
	const insecure = fixture();
	insecure.portal.privacyPolicyUrl = "http://example.com/privacy";
	expect(StripeBillingCatalogSchema.safeParse(insecure).success).toBe(false);
});

test("product key collisions including generated and reserved keys are rejected", () => {
	for (const collision of [
		"starter",
		"token_overage",
		"pay_as_you_go_credits",
		"credit_top_up_1000",
		"inference_capacity_small",
	]) {
		const catalog = fixture();
		catalog.plans.push({ ...catalog.plans[0]!, key: collision });
		expect(StripeBillingCatalogSchema.safeParse(catalog).success).toBe(false);
	}
});

test("the executable rejects missing config before credentials or provider access", async () => {
	const result = Bun.spawn(
		[
			process.execPath,
			"apps/api/scripts/billing/reconcile-stripe.ts",
			"--apply",
		],
		{
			cwd: new URL("../", import.meta.url).pathname,
			env: { PATH: process.env.PATH },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(await result.exited).not.toBe(0);
	const error = await new Response(result.stderr).text();
	expect(error).toContain("Missing billing catalog");
	expect(error).not.toContain("Missing STRIPE");
});

test("top-up packs match the approved credit catalog and D1 lookup keys", () => {
	expect(
		CREDIT_TOP_UP_PACKS.map(({ credits, unitAmount, lookupKey }) => ({
			credits,
			unitAmount,
			lookupKey,
		})),
	).toEqual([
		{ credits: 1000, unitAmount: 1000, lookupKey: "tedix_credits_1000_eur_v1" },
		{ credits: 5000, unitAmount: 5000, lookupKey: "tedix_credits_5000_eur_v1" },
		{
			credits: 10000,
			unitAmount: 10000,
			lookupKey: "tedix_credits_10000_eur_v1",
		},
		{
			credits: 25000,
			unitAmount: 25000,
			lookupKey: "tedix_credits_25000_eur_v1",
		},
		{
			credits: 50000,
			unitAmount: 50000,
			lookupKey: "tedix_credits_50000_eur_v1",
		},
	]);
	expect(CREDIT_TOP_UP_PACKS.every((pack) => pack.validMonths === 12)).toBe(
		true,
	);
});
