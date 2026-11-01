import { readFileSync } from "node:fs";
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

/** Operator configuration, not a built-in commercial catalog. */
export const StripeBillingCatalogSchema = z
	.strictObject({
		version: z.literal(1),
		catalogVersion: z.number().int().positive(),
		currency: z.string().regex(/^[a-z]{3}$/),
		priceLabel: text,
		meter: z.strictObject({ eventName: key, displayName: text }),
		overage: z.strictObject({
			productName: text,
			unitAmount: amount,
			divideBy: z.number().int().positive(),
			nickname: text,
		}),
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
		inferenceCapacity: z.strictObject({
			lookupVersion: z.number().int().positive(),
			packs: z
				.array(z.strictObject({ key, name: text, unitAmount: amount }))
				.max(100),
		}),
		portal: z.strictObject({
			name: text,
			headline: text,
			privacyPolicyUrl: httpsUrl,
			termsOfServiceUrl: httpsUrl,
		}),
	})
	.superRefine((catalog, ctx) => {
		const keys = [
			"token_overage",
			...catalog.plans.map((plan) => plan.key),
			...catalog.inferenceCapacity.packs.map(
				(pack) => `inference_capacity_${pack.key}`,
			),
		];
		if (new Set(keys).size !== keys.length) {
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
