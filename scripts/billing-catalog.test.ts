import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadBillingCatalog,
	StripeBillingCatalogSchema,
} from "../apps/api/scripts/billing/stripe-catalog";

const fixture = () => ({
	version: 1 as const,
	catalogVersion: 9,
	currency: "eur",
	priceLabel: "Example",
	meter: { eventName: "example_usage", displayName: "Example usage" },
	overage: {
		productName: "Example overage",
		unitAmount: 7,
		divideBy: 100,
		nickname: "Example usage price",
	},
	plans: [
		{
			key: "starter",
			name: "Example Starter",
			monthlyAmount: 123,
			annualAmount: 1400,
		},
	],
	inferenceCapacity: {
		lookupVersion: 6,
		packs: [{ key: "small", name: "Example capacity", unitAmount: 456 }],
	},
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
