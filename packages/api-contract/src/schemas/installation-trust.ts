import * as z from "zod";

const IdentityListSchema = z
	.array(z.string().trim().min(1).max(200))
	.max(1000)
	.refine(
		(values) => new Set(values).size === values.length,
		"Duplicate identity",
	);

// Ignore retired top-level fields in published revisions. Only the aggregate
// object below supplies authority, and its contents are still validated strictly.
export const InstallationTrustPolicySchema = z.object({
	version: z.literal(1),
	aggregate: z
		.object({
			sharedSourceOrganizationIds: IdentityListSchema,
			aggregateHostOrganizationIds: IdentityListSchema,
		})
		.strict(),
});

export const InstallationTrustDefinitionSchema = z
	.object({ installationTrust: InstallationTrustPolicySchema })
	.strict();

export type InstallationTrustPolicy = z.infer<
	typeof InstallationTrustPolicySchema
>;
