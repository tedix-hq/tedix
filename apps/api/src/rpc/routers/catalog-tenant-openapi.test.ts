import {
	CreateTenantOpenApiMcpAppInputSchema,
	UninstallTenantMcpAppInputSchema,
} from "@tedix/api-contract/schemas/catalog";
import { describe, expect, it } from "vite-plus/test";
import { catalogRouterTestInternals } from "./catalog";

const baseInput = {
	appSlug: "acme-api",
	name: "acme API",
	targetAggregatorSlug: "acme-unified",
	baseUrl: "https://api.acme.example",
	specText: `
openapi: 3.0.0
info:
  title: acme API
  version: "7"
paths:
  /units:
    get:
      operationId: listUnits
      responses:
        "200":
          description: OK
`,
};

describe("tenant OpenAPI MCP app schema", () => {
	it("accepts inline YAML specs and applies tenant-safe defaults", () => {
		const parsed = CreateTenantOpenApiMcpAppInputSchema.parse(baseInput);

		expect(parsed.visibility).toBe("private");
		expect(parsed.toolScopes).toEqual(["mcp:content.write"]);
		expect(parsed.catalogDiscoverable).toBe(false);
		expect(parsed.dryRun).toBe(true);
	});

	it("accepts dedicated connection-provider provisioning config", () => {
		const parsed = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			authHeader: "Authorization",
			connectionProvider: {
				type: "api_key",
				name: "Acme API Key",
			},
		});

		expect(parsed.connectionProvider).toMatchObject({
			type: "api_key",
			name: "Acme API Key",
		});
	});

	it("does not allow provider provisioning and provider reuse together", () => {
		expect(() =>
			CreateTenantOpenApiMcpAppInputSchema.parse({
				...baseInput,
				connectionProviderId: "acme-api-key",
				connectionProvider: {
					type: "api_key",
				},
			}),
		).toThrow(
			/Use connectionProvider to provision or connectionProviderId to reuse/,
		);
	});

	it("requires a spec source", () => {
		expect(() =>
			CreateTenantOpenApiMcpAppInputSchema.parse({
				appSlug: "acme-api",
				name: "acme API",
				targetAggregatorSlug: "acme-unified",
				baseUrl: "https://api.acme.example",
			}),
		).toThrow(/Provide one of specUrl, spec, or specText/);
	});
});

describe("tenant MCP app uninstall schema", () => {
	it("requires a proxy slug or namespace prefix and defaults to a dry run", () => {
		const parsed = UninstallTenantMcpAppInputSchema.parse({
			targetAggregatorSlug: "acme-unified",
			slug: "acme-api-acme",
		});

		expect(parsed).toMatchObject({
			targetAggregatorSlug: "acme-unified",
			slug: "acme-api-acme",
			removeToolScopes: true,
			dryRun: true,
		});
	});

	it("rejects empty detach selectors", () => {
		expect(() =>
			UninstallTenantMcpAppInputSchema.parse({
				targetAggregatorSlug: "acme-unified",
			}),
		).toThrow(/Provide slug or prefix/);
	});
});

describe("tenant OpenAPI MCP app import helpers", () => {
	it("parses YAML specText before queueing the OpenAPI workflow", () => {
		const input = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			prefix: "acme_api",
		});

		const importInput = catalogRouterTestInternals.tenantOpenApiImportInput(
			input,
			"9c787c38-7605-46a6-9f89-091238ec444d",
			"fallback_namespace",
		);

		expect(importInput.namespace).toBe("acme_api");
		expect(importInput.connectionScope).toBe("tenant");
		expect(importInput.spec).toMatchObject({
			openapi: "3.0.0",
			info: { title: "acme API", version: "7" },
			paths: { "/units": expect.any(Object) },
		});
	});

	it("stores durable OpenAPI sync config without legacy connection labels", () => {
		const credentialProfile = {
			inputFields: [
				{
					name: "apiKey",
					label: "acme API key",
					type: "password" as const,
					required: true,
				},
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Token {token}",
		};
		const metadata = catalogRouterTestInternals.openApiSyncMetadataFromInput(
			{
				appId: "9c787c38-7605-46a6-9f89-091238ec444d",
				specUrl: "https://example.com/acme-api.yaml",
				baseUrl: "https://api.acme.example",
				namespace: "acme_api",
				connectionProviderId: "acme-api-key",
				authHeader: "X-API-Key",
				authTemplate: "{token}",
			},
			{ mcpConfig: { connectionLabel: "legacy", authMode: "authenticated" } },
			credentialProfile,
		);

		expect(metadata).toMatchObject({
			mcpConfig: {
				authMode: "authenticated",
				credentialProfile,
				openApiSync: {
					enabled: true,
					specUrl: "https://example.com/acme-api.yaml",
					baseUrl: "https://api.acme.example",
					namespace: "acme_api",
					connectionProviderId: "acme-api-key",
					connectionScope: "tenant",
					authHeader: "X-API-Key",
					authTemplate: "{token}",
					credentialProfile,
				},
			},
		});
		expect(
			(metadata.mcpConfig as Record<string, unknown>).connectionLabel,
		).toBeUndefined();
	});

	it("plans a tenant-scoped Descope provider for authenticated imports", () => {
		const input = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			authHeader: "Authorization",
			authTemplate: "Token {token}",
			connectionProvider: {
				name: "Acme API Key",
			},
		});

		const plan = catalogRouterTestInternals.tenantOpenApiConnectionProviderPlan(
			input,
			"acme-api",
			"acme",
		);

		expect(plan).toMatchObject({
			id: "acme-api-key",
			name: "Acme API Key",
			type: "api_key",
			config: {
				type: "api_key",
				credentialProfile: {
					inputFields: [
						{
							name: "apiKey",
							label: "acme API key",
							type: "password",
							required: true,
						},
					],
					tokenTemplate: "{apiKey}",
					authHeader: "Authorization",
					authTemplate: "Token {token}",
				},
			},
		});
	});

	it("keeps generated provider ids inside Descope outbound app limits", () => {
		const input = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			appSlug: "obsidian-local-rest-api",
			name: "Obsidian Local REST API",
			connectionProvider: {
				name: "Obsidian Local REST API",
			},
		});

		const plan = catalogRouterTestInternals.tenantOpenApiConnectionProviderPlan(
			input,
			"obsidian-local-rest-api",
			"acme",
		);

		expect(plan?.id).toBe("obsidian-local-rest-api-key");
		expect(plan?.id).toHaveLength(27);
	});

	it("reuses an existing provider without planning tenant provider provisioning", () => {
		const input = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			connectionProviderId: "acme-api-key",
		});

		const plan = catalogRouterTestInternals.tenantOpenApiConnectionProviderPlan(
			input,
			"acme-api",
			"acme",
		);

		expect(plan).toBeNull();
	});

	it("feeds the complete Acme provider into generated tool auth config", () => {
		const input = CreateTenantOpenApiMcpAppInputSchema.parse({
			...baseInput,
			connectionProviderId: "acme-api-key",
			authHeader: "Authorization",
			authTemplate: "Token {token}",
		});

		const importInput = catalogRouterTestInternals.tenantOpenApiImportInput(
			input,
			"9c787c38-7605-46a6-9f89-091238ec444d",
			"fallback_namespace",
		);

		expect(importInput).toMatchObject({
			connectionProviderId: "acme-api-key",
			authHeader: "Authorization",
			authTemplate: "Token {token}",
		});
	});
});
