import * as z from "zod";

export const catalogSearchSchema = z.object({
	search: z.string().optional().catch(undefined),
	category: z.string().optional().catch(undefined),
	connectorType: z
		.enum(["MCP", "SERVICE", "FIRST_PARTY_ECOSYSTEM", "NATIVE"])
		.optional()
		.catch(undefined),
	sortBy: z
		.enum(["sourceCreatedAt", "updatedAt", "lastSyncedAt", "name"])
		.optional()
		.catch(undefined),
	healthStatus: z
		.enum([
			"healthy",
			"degraded",
			"unhealthy",
			"requires_auth",
			"blocked",
			"unsupported",
			"unknown",
		])
		.optional()
		.catch(undefined),
	offset: z.coerce.number().int().min(0).catch(0),
});
