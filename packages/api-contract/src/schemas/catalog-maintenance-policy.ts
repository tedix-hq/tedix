import * as z from "zod";

export const CATALOG_MAINTENANCE_POLICY_SLUG = "catalog-maintenance";

export const CatalogRegistrySourceSchema = z.strictObject({
	source: z.literal("claude"),
	adapter: z.literal("claude-registry"),
	endpoint: z.url().refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" && !url.username && !url.password && !url.hash
		);
	}, "Registry endpoints require HTTPS without credentials or fragments"),
	r2Prefix: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
});
export type CatalogRegistrySource = z.infer<typeof CatalogRegistrySourceSchema>;

/** Published system policy; callers cannot choose arbitrary registry URLs. */
export const CatalogMaintenancePolicySchema = z
	.strictObject({
		version: z.literal(1),
		frequentProviderSlugs: z.array(z.string().min(1).max(100)).max(200),
		sources: z.array(CatalogRegistrySourceSchema).max(20),
	})
	.superRefine((policy, context) => {
		if (
			new Set(policy.frequentProviderSlugs).size !==
			policy.frequentProviderSlugs.length
		)
			context.addIssue({
				code: "custom",
				message: "Provider slugs must be unique",
				path: ["frequentProviderSlugs"],
			});
		if (
			new Set(policy.sources.map((source) => source.source)).size !==
			policy.sources.length
		)
			context.addIssue({
				code: "custom",
				message: "Registry sources must be unique",
				path: ["sources"],
			});
	});
export type CatalogMaintenancePolicy = z.infer<
	typeof CatalogMaintenancePolicySchema
>;
