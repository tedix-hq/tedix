import { describe, expect, it } from "vite-plus/test";
import { AppMetadataSchema, AppToolSchema, UpdateAppInputSchema } from "./app";

describe("AppMetadataSchema", () => {
	it("accepts stored aggregate tedi surface revisions", () => {
		const result = AppMetadataSchema.safeParse({
			mcpConfig: {
				aggregateTedis: [
					{
						slug: "acme",
						surfaceRev: "2026-07-06-artifact-tools",
					},
				],
			},
		});

		expect(result.success).toBe(true);
	});

	it("preserves generated OpenAPI credential profiles", () => {
		const credentialProfile = {
			inputFields: [
				{ name: "username", label: "API username", type: "text" as const },
				{ name: "password", label: "API password", type: "password" as const },
			],
			tokenTemplate: "{username}:{password}",
			authHeader: "Authorization",
			authTemplate: "Basic {token}",
			authEncoding: "base64" as const,
		};
		const result = AppMetadataSchema.safeParse({
			mcpConfig: {
				credentialProfile,
				openApiSync: {
					enabled: true,
					connectionProviderId: "facturama-api-key",
					credentialProfile,
				},
			},
		});

		expect(result.success).toBe(true);
		expect(
			result.success && result.data.mcpConfig?.openApiSync?.credentialProfile,
		).toEqual({
			...credentialProfile,
			inputFields: [
				{ ...credentialProfile.inputFields[0], required: true },
				{ ...credentialProfile.inputFields[1], required: true },
			],
		});
	});
});

describe("UpdateAppInputSchema", () => {
	it("preserves explicit OpenAI challenge updates without defaulting omitted values", () => {
		expect(
			UpdateAppInputSchema.parse({ openaiChallengeToken: "a_token-123" }),
		).toEqual({ openaiChallengeToken: "a_token-123" });
		expect(UpdateAppInputSchema.parse({ openaiChallengeToken: null })).toEqual({
			openaiChallengeToken: null,
		});
		expect(UpdateAppInputSchema.parse({})).not.toHaveProperty(
			"openaiChallengeToken",
		);
	});
	it.each(["", "with space", "line\nbreak", "\u0000", "x".repeat(4097)])(
		"rejects malformed OpenAI challenge token %j",
		(openaiChallengeToken) => {
			expect(
				UpdateAppInputSchema.safeParse({ openaiChallengeToken }).success,
			).toBe(false);
		},
	);
	it("accepts null only as an explicit app-level Connection removal patch", () => {
		expect(
			UpdateAppInputSchema.parse({
				metadata: { mcpConfig: { connectionProviderId: null } },
			}),
		).toMatchObject({
			metadata: { mcpConfig: { connectionProviderId: null } },
		});
		expect(() =>
			AppMetadataSchema.parse({
				mcpConfig: { connectionProviderId: null },
			}),
		).toThrow();
	});
});

/**
 * These enums read free-text SQLite columns, so any writer can leave a value the
 * enum does not know. On a READ path that must degrade the field, never the tool:
 * apps/mcp resolves every aggregate app through getBySlugWithTools, one failed
 * resolve marks the whole aggregate surface `degraded`, and a degraded surface is
 * never cached at L1/L2/L3 — so the cache stays permanently cold.
 */
describe("AppToolSchema enum tolerance", () => {
	const row = {
		id: "t1",
		toolId: "search_listings",
		toolTypeId: "rpc",
		title: "Search Listings",
		description: null,
		inputSchema: { type: "object" },
		outputSchema: null,
		adapterScope: "all",
		resultStrategy: "merge",
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		authRequired: false,
		visibility: "public",
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		config: null,
		schemaDialect: "json-schema-2020-12",
		schemaSource: "orpc",
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: 0,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	};

	it("keeps the tool when schemaSource is a value the enum does not know", () => {
		const result = AppToolSchema.safeParse({
			...row,
			schemaSource: "tedix_rpc",
		});
		expect(result.success).toBe(true);
		expect(result.success && result.data.schemaSource).toBeNull();
		// The rest of the tool must survive intact — degrading the field, not the tool.
		expect(result.success && result.data.toolId).toBe("search_listings");
	});

	it("keeps the tool when schemaDialect is unknown", () => {
		const result = AppToolSchema.safeParse({
			...row,
			schemaDialect: "json-schema-draft-07",
		});
		expect(result.success).toBe(true);
		expect(result.success && result.data.schemaDialect).toBeNull();
	});

	it("keeps the tool when executionTaskSupport is unknown", () => {
		const result = AppToolSchema.safeParse({
			...row,
			executionTaskSupport: "someday",
		});
		expect(result.success).toBe(true);
		expect(result.success && result.data.executionTaskSupport).toBeNull();
	});

	it("still preserves values the enum DOES know", () => {
		const result = AppToolSchema.safeParse(row);
		expect(result.success && result.data.schemaSource).toBe("orpc");
		expect(result.success && result.data.schemaDialect).toBe(
			"json-schema-2020-12",
		);
	});

	it("represents a missing scope mapping without inventing an empty grant", () => {
		const result = AppToolSchema.parse({
			...row,
			scopeMappingMissing: true,
		});
		expect(result.scopeMappingMissing).toBe(true);
		expect(result).not.toHaveProperty("requiredScopes");
		expect(
			AppToolSchema.safeParse({ ...row, scopeMappingMissing: false }).success,
		).toBe(false);
	});

	it("still rejects a row missing a genuinely required field", () => {
		// Tolerance is scoped to unknown enum values, not to malformed rows.
		const { toolId: _dropped, ...missingToolId } = row;
		expect(AppToolSchema.safeParse(missingToolId).success).toBe(false);
	});
});

describe("Code Mode execution budget", () => {
	it.each([90000, 300000, 330000])(
		"preserves a supported explicit timeout %s",
		(timeout) => {
			expect(
				AppMetadataSchema.parse({ mcpConfig: { codeModeTimeout: timeout } })
					.mcpConfig?.codeModeTimeout,
			).toBe(timeout);
		},
	);
	it.each([330001, 0, 330000.5])(
		"rejects unsupported timeout %s",
		(timeout) => {
			expect(
				AppMetadataSchema.safeParse({ mcpConfig: { codeModeTimeout: timeout } })
					.success,
			).toBe(false);
		},
	);
});
