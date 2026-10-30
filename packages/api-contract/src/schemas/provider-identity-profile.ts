import * as z from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeSegment = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
	.refine((value) => value !== "constructor" && value !== "prototype");
const selectorPaths = z
	.array(z.array(safeSegment).min(1).max(4))
	.min(1)
	.max(4)
	.refine(
		(paths) =>
			new Set(paths.map((path) => JSON.stringify(path))).size === paths.length,
	);
export const ProviderIdentityProbeProfileSchema = z
	.object({
		version: z.literal(1),
		operation: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		selectors: selectorPaths,
	})
	.strict();
export const ProviderIdentityMountSchema = z
	.object({
		version: z.literal(1),
		organizationId: z.string().min(1),
		rootAppId: z.string().min(1),
		mountAppIds: z.array(z.string().min(1)).min(1).max(16),
		sourceAppId: z.string().min(1),
		sourceToolRowId: z.string().min(1),
		sourceToolId: z.string().min(1),
		mountedToolId: z.string().min(1),
		transport: z.literal("mcp"),
		upstreamOperation: z.string().min(1),
		endpointDigest: digest,
		effectiveToolDigest: digest,
		authBindingDigest: digest,
		acceptsEmptyArguments: z.boolean(),
		providerId: z.string().min(1),
		connectionScope: z.enum(["tenant", "user", "hybrid"]),
		credentialPreference: z.enum(["user-first", "tenant-first"]).optional(),
		connectionInstanceId: z.string().optional(),
		requestedScopes: z.array(z.string()),
	})
	.strict();
export const ProviderIdentityProfileSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	mount: ProviderIdentityMountSchema,
	probeMount: ProviderIdentityMountSchema,
	profile: ProviderIdentityProbeProfileSchema,
	safetyAttestation: z.literal("safe_empty_probe"),
	profileDigest: digest,
	resourceGenerationDigest: digest,
	createdBy: z.string(),
	createdAt: z.string(),
	revokedAt: z.string().nullable(),
});
export const PrepareProviderIdentityProfileInputSchema = z
	.object({
		rootAppId: z.string().min(1),
		mountedToolId: z.string().min(1),
		probeMountedToolId: z.string().min(1),
		selectors: selectorPaths,
	})
	.strict();
export const PrepareProviderIdentityProfileResponseSchema = z.object({
	preparationId: z.uuid(),
	mount: ProviderIdentityMountSchema,
	probeMount: ProviderIdentityMountSchema,
	profile: ProviderIdentityProbeProfileSchema,
	profileDigest: digest,
	expiresAt: z.string(),
});
export const CreateProviderIdentityProfileInputSchema = z
	.object({
		preparationId: z.uuid(),
		expectedProfileDigest: digest,
		safetyAttestation: z.literal("safe_empty_probe"),
	})
	.strict();
export type ProviderIdentityMount = z.infer<typeof ProviderIdentityMountSchema>;
