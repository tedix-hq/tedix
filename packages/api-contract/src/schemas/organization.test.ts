import { describe, expect, it } from "vite-plus/test";
import { organizationsContract } from "../contracts/organizations";
import {
	ApiKeySchema,
	ApiKeyScopeSchema,
	CreateApiKeyInputSchema,
	OrganizationMetadataSchema,
} from "./organization";

describe("dedicated API key scopes", () => {
	it("admits MCP administration without granting an API wildcard", () => {
		expect(ApiKeyScopeSchema.parse("platform:admin")).toBe("platform:admin");
		expect(
			CreateApiKeyInputSchema.parse({
				name: "External agent",
				scopes: ["platform:admin"],
				environment: "live",
			}),
		).toEqual({
			name: "External agent",
			scopes: ["platform:admin"],
			environment: "live",
		});
	});

	it("admits earned-delegation governance without granting an API wildcard", () => {
		expect(ApiKeyScopeSchema.parse("earned-delegation:govern")).toBe(
			"earned-delegation:govern",
		);
		expect(
			CreateApiKeyInputSchema.parse({
				name: "Evidence reviewer",
				scopes: ["earned-delegation:govern"],
				environment: "live",
			}),
		).toEqual({
			name: "Evidence reviewer",
			scopes: ["earned-delegation:govern"],
			environment: "live",
		});
	});

	it("admits scoped tedi evidence writes without granting an API wildcard", () => {
		expect(ApiKeyScopeSchema.parse("tedis:read")).toBe("tedis:read");
		expect(ApiKeyScopeSchema.parse("tedis:write")).toBe("tedis:write");
		expect(
			CreateApiKeyInputSchema.parse({
				name: "Evidence recorder",
				scopes: ["earned-delegation:govern", "tedis:write"],
				environment: "live",
			}),
		).toMatchObject({
			scopes: ["earned-delegation:govern", "tedis:write"],
		});
	});

	it("admits separate team read and write scopes", () => {
		expect(ApiKeyScopeSchema.parse("team:read")).toBe("team:read");
		expect(ApiKeyScopeSchema.parse("team:write")).toBe("team:write");
	});

	it("admits the narrow embedded session exchange scope", () => {
		expect(ApiKeyScopeSchema.parse("embedded:session")).toBe(
			"embedded:session",
		);
	});
});

describe("API key creation and public metadata", () => {
	const organizationId = "00000000-0000-4000-8000-000000000001";
	const supported = {
		name: "Automation",
		description: "Read-only integration",
		scopes: ["apps:read"],
		environment: "live",
		ipAllowlist: ["192.0.2.1/32"],
		expiresAt: "2027-01-01T00:00:00.000Z",
		rotationScheduleDays: 30,
	};
	const rpcInput = organizationsContract.createApiKey["~orpc"].inputSchemas[0]!;
	it("preserves every supported restriction through the actual RPC input", () => {
		expect(CreateApiKeyInputSchema.parse(supported)).toEqual(supported);
		expect(rpcInput.parse({ ...supported, organizationId })).toEqual({
			...supported,
			organizationId,
		});
		expect(
			rpcInput.safeParse({ ...supported, organizationId: "invalid" }).success,
		).toBe(false);
	});
	it.each([{ rateLimit: 100 }, { unsupportedOption: true }])(
		"rejects unsupported creation properties at both boundaries: %j",
		(extra) => {
			expect(
				CreateApiKeyInputSchema.safeParse({ ...supported, ...extra }).success,
			).toBe(false);
			expect(
				rpcInput.safeParse({ ...supported, organizationId, ...extra }).success,
			).toBe(false);
		},
	);
	it("projects public metadata without exposing stored private or historical configuration", () => {
		const publicKey = {
			id: "00000000-0000-4000-8000-000000000002",
			organizationId,
			name: "Automation",
			description: null,
			keyPreview: "...12345678",
			scopes: ["apps:read"],
			descopeClientId: null,
			environment: "live",
			lastUsedAt: null,
			requestsThisMonth: 0,
			totalRequests: 0,
			ipAllowlist: ["192.0.2.1/32"],
			expiresAt: supported.expiresAt,
			status: "active",
			rotatedAt: null,
			rotationScheduleDays: 30,
			previousKeyExpiresAt: null,
			revokedAt: null,
			revokedBy: null,
			revokeReason: null,
			metadata: null,
			createdBy: null,
			createdAt: null,
			updatedAt: null,
		};
		expect(
			ApiKeySchema.parse({
				...publicKey,
				rateLimit: 100,
				keyHash: "private-hash",
				previousKeyHash: "previous-private-hash",
			}),
		).toEqual(publicKey);
	});
});

describe("API key bootstrap purpose contract", () => {
	it("preserves bootstrap purpose through the RPC input", () => {
		const input = {
			organizationId: "00000000-0000-4000-8000-000000000001",
			name: "Cloud bootstrap",
			purpose: "external_agent_bootstrap",
			scopes: [],
			expiresAt: "2099-01-01T00:00:00.000Z",
		};
		expect(
			organizationsContract.createApiKey["~orpc"].inputSchemas[0]!.parse(input),
		).toEqual(input);
	});
	it("refuses unknown credential purposes", () => {
		expect(
			CreateApiKeyInputSchema.safeParse({
				name: "Unknown",
				purpose: "unrestricted",
			}).success,
		).toBe(false);
	});
});

describe("organization metadata writes", () => {
	const organizationId = "00000000-0000-4000-8000-000000000001";
	const create = organizationsContract.create["~orpc"].inputSchemas[0]!;
	const update = organizationsContract.update["~orpc"].inputSchemas[0]!;
	it("validates session prefix bindings as organization settings", () => {
		const input = {
			organizationId,
			metadata: {
				sessionProjectBindings: [{ prefix: "ACME", projectId: organizationId }],
			},
		};
		expect(update.parse(input)).toEqual(input);
		for (const binding of [
			{ prefix: "", projectId: organizationId },
			{ prefix: "OPS", projectId: "wrong" },
		])
			expect(
				update.safeParse({
					...input,
					metadata: { sessionProjectBindings: [binding] },
				}).success,
			).toBe(false);
	});

	it.each([create, update])(
		"rejects unknown top-level settings and names every key",
		(schema) => {
			const parsed = schema.safeParse({
				name: "Example",
				organizationId,
				metadata: {
					website: "https://example.com",
					unsupportedSetting: true,
					webSerch: { enabled: true },
				},
			});
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				expect(parsed.error.issues).toContainEqual(
					expect.objectContaining({
						code: "unrecognized_keys",
						path: ["metadata"],
						keys: ["unsupportedSetting", "webSerch"],
					}),
				);
				expect(parsed.error.message).toContain("unsupportedSetting");
				expect(parsed.error.message).toContain("webSerch");
			}
		},
	);

	it("preserves supported web search settings", () => {
		const input = {
			organizationId,
			metadata: { webSearch: { enabled: true, maxResults: 3 } },
		};
		expect(update.parse(input)).toEqual(input);
	});
});

it("keeps organization metadata reads tolerant of historical stored keys", () => {
	expect(
		OrganizationMetadataSchema.parse({
			website: "https://example.com",
			historicalSetting: true,
		}),
	).toEqual({ website: "https://example.com" });
});
