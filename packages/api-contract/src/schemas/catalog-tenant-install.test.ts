import { describe, expect, it } from "vite-plus/test";
import {
	InstallTenantMcpAppInputSchema,
	InstallTenantMcpAppsInputSchema,
} from "./catalog";

describe("InstallTenantMcpAppInputSchema", () => {
	it("defaults to dry-run and content-scoped installs", () => {
		const parsed = InstallTenantMcpAppInputSchema.parse({
			catalogAppSlug: "firecrawl",
			targetAggregatorSlug: "acme-unified",
		});

		expect(parsed).toMatchObject({
			catalogAppSlug: "firecrawl",
			targetAggregatorSlug: "acme-unified",
			dryRun: true,
			toolScopes: ["mcp:content.write"],
			visibility: "private",
		});
	});

	it("requires exactly one catalog app selector", () => {
		expect(() =>
			InstallTenantMcpAppInputSchema.parse({
				targetAggregatorSlug: "acme-unified",
			}),
		).toThrow(/exactly one/);

		expect(() =>
			InstallTenantMcpAppInputSchema.parse({
				catalogAppId: "5eed0025-0000-4000-8000-000000000025",
				catalogAppSlug: "firecrawl",
				targetAggregatorSlug: "acme-unified",
			}),
		).toThrow(/exactly one/);
	});

	it("rejects platform-admin scope for tenant installs", () => {
		expect(() =>
			InstallTenantMcpAppInputSchema.parse({
				catalogAppSlug: "firecrawl",
				targetAggregatorSlug: "acme-unified",
				toolScopes: ["platform:admin"],
			}),
		).toThrow();
	});

	it("accepts only a query-param name while keeping the organization value server-owned", () => {
		const parsed = InstallTenantMcpAppInputSchema.parse({
			catalogAppSlug: "tedix-docs",
			targetAggregatorSlug: "globex-unified",
			organizationQueryParam: "org",
		});

		expect(parsed.organizationQueryParam).toBe("org");
		expect(() =>
			InstallTenantMcpAppInputSchema.parse({
				catalogAppSlug: "tedix-docs",
				targetAggregatorSlug: "globex-unified",
				organizationQueryParam: "org=another-tenant",
			}),
		).toThrow();
	});
});

describe("InstallTenantMcpAppsInputSchema", () => {
	it("accepts product names and defaults an explicit install to real execution", () => {
		expect(
			InstallTenantMcpAppsInputSchema.parse({
				catalogAppQueries: ["Google Calendar", "Outlook"],
				targetAggregatorSlug: "acme-unified",
			}),
		).toEqual({
			catalogAppQueries: ["Google Calendar", "Outlook"],
			targetAggregatorSlug: "acme-unified",
			dryRun: false,
		});
	});

	it("keeps the batch bounded", () => {
		expect(() =>
			InstallTenantMcpAppsInputSchema.parse({
				catalogAppQueries: [],
				targetAggregatorSlug: "acme-unified",
			}),
		).toThrow();
	});
});
