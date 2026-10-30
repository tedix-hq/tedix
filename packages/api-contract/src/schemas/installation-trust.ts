import * as z from "zod";

const IdentityListSchema = z
	.array(z.string().trim().min(1).max(200))
	.max(1000)
	.refine(
		(values) => new Set(values).size === values.length,
		"Duplicate identity",
	);

const EndpointSchema = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.hash &&
				url.pathname.replace(/\/+$/, "") === "/mcp"
			);
		} catch {
			return false;
		}
	}, "Expected an exact HTTPS MCP endpoint without credentials or a fragment")
	.transform((value) => new URL(value).href);

export const ManagedCatalogScanEndpointSchema = z
	.object({
		url: EndpointSchema,
		transport: z.enum(["http", "mcp", "cms"]),
		headers: z
			.partialRecord(
				z.enum([
					"X-Tedix-Connection-Label",
					"X-Tedix-Delegated-Scope",
					"X-Tedix-Actor-Type",
					"X-Tedix-Actor-Id",
				]),
				z
					.string()
					.trim()
					.min(1)
					.max(512)
					.regex(/^[^\r\n]+$/),
			)
			.default({}),
	})
	.strict();

export const InstallationTrustPolicySchema = z
	.object({
		version: z.literal(1),
		aggregate: z
			.object({
				sharedSourceOrganizationIds: IdentityListSchema,
				aggregateHostOrganizationIds: IdentityListSchema,
			})
			.strict(),
		catalogScan: z
			.object({
				endpoints: z.array(ManagedCatalogScanEndpointSchema).max(1000),
			})
			.strict()
			.refine(
				({ endpoints }) =>
					new Set(endpoints.map((endpoint) => endpoint.url)).size ===
					endpoints.length,
				"Duplicate managed endpoint",
			),
	})
	.strict();

export const InstallationTrustDefinitionSchema = z
	.object({ installationTrust: InstallationTrustPolicySchema })
	.strict();

export type InstallationTrustPolicy = z.infer<
	typeof InstallationTrustPolicySchema
>;
export type ManagedCatalogScanEndpoint = z.infer<
	typeof ManagedCatalogScanEndpointSchema
>;
