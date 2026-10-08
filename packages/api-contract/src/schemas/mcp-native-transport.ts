import * as z from "zod";

const boundedIdentity = z.string().min(1).max(256);

/** Authenticated request context, never a token or an authorization grant. */
export const McpNativeContextSchema = z
	.object({
		version: z.literal(1),
		surface: z.literal("mcp-gateway"),
		appId: boundedIdentity,
		appSlug: boundedIdentity,
		organizationId: boundedIdentity,
		actor: z
			.object({
				authType: z.enum([
					"user",
					"m2m",
					"tedi",
					"service",
					"apiKey",
					"oauth",
					"external_agent",
				]),
			})
			.strict(),
		nativeTransportAvailable: z.boolean(),
	})
	.strict();

export const McpNativeDescriptorSchema = z
	.object({
		name: boundedIdentity,
		toolRowId: boundedIdentity,
		endpoint: boundedIdentity,
		eligible: z.boolean(),
		authorized: z.boolean(),
		schemaFreshness: z
			.object({
				source: z.string().max(256).nullable(),
				sourceRef: z.string().max(2048).nullable(),
				sourceHash: z.string().max(256).nullable(),
				syncedAt: z.string().max(128).nullable(),
			})
			.strict(),
	})
	.strict();

export const McpNativeBootstrapSchema = z
	.object({
		nativeContext: McpNativeContextSchema.nullable(),
		nativeCatalog: z
			.object({
				status: z.enum(["usable", "unavailable"]),
				search: McpNativeDescriptorSchema.nullable(),
				describe: McpNativeDescriptorSchema.nullable(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.nativeCatalog.status === "usable" &&
			(!value.nativeContext ||
				!value.nativeContext.nativeTransportAvailable ||
				!value.nativeCatalog.search?.eligible ||
				!value.nativeCatalog.search.authorized ||
				!value.nativeCatalog.describe?.eligible ||
				!value.nativeCatalog.describe.authorized ||
				value.nativeCatalog.search.name === value.nativeCatalog.describe.name)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Usable native catalog requires two distinct authorized eligible descriptors and authenticated context.",
			});
		}
	});
