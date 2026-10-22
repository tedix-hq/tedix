import { describe, expect, it } from "vite-plus/test";
import type { CatalogApp } from "../../schema/catalog";
import {
	catalogAppUsesConnection,
	catalogMcpToolSourceHash,
	catalogMcpToolSourceRef,
	hasAggregateAppOverlay,
	inferCatalogConnectionScope,
	inferExternalToolAnnotations,
	inferExternalToolOutputSchema,
	incomingLogoRepairFailed,
	isExternalCatalogLogoUrl,
	isTedixCatalogAssetUrl,
	isTedixCatalogToolSource,
	isTedixHostedMcpEndpoint,
	jsonEqual,
	mcpToolOutputSchema,
	mergeCatalogRawData,
	mergeRichContent,
	normalizeExecutionTaskSupport,
	normalizeMcpInputSchema,
	normalizeMcpOutputSchema,
	normalizeRichContent,
	normalizeToolAnnotations,
	normalizeToolIcons,
	normalizeToolMeta,
	normalizeToolTitle,
	ownsCatalogMcpTool,
	readAppMcpConfig,
	renderableLogoUrl,
	shouldProjectCatalogToolsFromBaseApp,
	splitToolAnnotations,
	titleFromToolName,
	toISODate,
	UPSTREAM_TOOL_ANNOTATIONS_META_KEY,
	withUpstreamAnnotationsMeta,
} from "./tool-source-policy";

type AppToolRow = Parameters<typeof ownsCatalogMcpTool>[0];
const appToolRow = (row: {
	toolId: string;
	config: Record<string, unknown> | null;
	schemaSourceRef: string | null;
}) => row as AppToolRow;

const catalogApp = (authTypes: string[] | null) =>
	({ authTypes }) as Pick<CatalogApp, "authTypes">;

describe("readAppMcpConfig", () => {
	it("reads every field from a JSON string metadata payload", () => {
		const app = {
			metadata: JSON.stringify({
				mcpConfig: {
					autoSync: true,
					connectionProviderId: "provider-1",
					connectionScope: "user",
					connectionScopes: ["tenant", "user", 7],
					aggregateApps: [{ slug: "base-app" }],
				},
			}),
		};
		expect(readAppMcpConfig(app)).toEqual({
			autoSync: true,
			connectionProviderId: "provider-1",
			connectionScope: "user",
			connectionScopes: ["tenant", "user"],
			aggregateApps: [{ slug: "base-app" }],
		});
	});

	it("reads from an object metadata payload", () => {
		expect(
			readAppMcpConfig({
				metadata: { mcpConfig: { connectionScope: "tenant" } },
			}).connectionScope,
		).toBe("tenant");
	});

	it("returns empty fields for missing, malformed, or non-object metadata", () => {
		const empty = {
			autoSync: undefined,
			connectionProviderId: undefined,
			connectionScope: undefined,
			connectionScopes: undefined,
			aggregateApps: undefined,
		};
		expect(readAppMcpConfig({})).toEqual(empty);
		expect(readAppMcpConfig({ metadata: null })).toEqual(empty);
		expect(readAppMcpConfig({ metadata: "{not json" })).toEqual(empty);
		expect(readAppMcpConfig({ metadata: "[1,2]" })).toEqual(empty);
		expect(readAppMcpConfig({ metadata: "5" })).toEqual(empty);
		expect(readAppMcpConfig({ metadata: { mcpConfig: "x" } })).toEqual(empty);
	});

	it("drops fields with the wrong type", () => {
		expect(
			readAppMcpConfig({
				metadata: {
					mcpConfig: {
						autoSync: "yes",
						connectionProviderId: 9,
						connectionScope: "domain",
						connectionScopes: "tenant",
						aggregateApps: { slug: "x" },
					},
				},
			}),
		).toEqual({
			autoSync: undefined,
			connectionProviderId: undefined,
			connectionScope: undefined,
			connectionScopes: undefined,
			aggregateApps: undefined,
		});
	});
});

describe("hasAggregateAppOverlay", () => {
	it("is true only when aggregateApps is a non-empty array", () => {
		expect(
			hasAggregateAppOverlay({
				metadata: { mcpConfig: { aggregateApps: [{ slug: "a" }] } },
			}),
		).toBe(true);
		expect(
			hasAggregateAppOverlay({
				metadata: { mcpConfig: { aggregateApps: [] } },
			}),
		).toBe(false);
		expect(
			hasAggregateAppOverlay({
				metadata: { mcpConfig: { aggregateApps: "a" } },
			}),
		).toBe(false);
		expect(hasAggregateAppOverlay({ metadata: null })).toBe(false);
	});
});

describe("inferCatalogConnectionScope", () => {
	it("prefers the explicit scope, then the fallback", () => {
		expect(
			inferCatalogConnectionScope(catalogApp(["OAUTH"]), "user", "tenant"),
		).toBe("user");
		expect(
			inferCatalogConnectionScope(catalogApp(["OAUTH"]), undefined, "hybrid"),
		).toBe("hybrid");
	});

	it("infers hybrid for OAuth apps and tenant otherwise", () => {
		expect(inferCatalogConnectionScope(catalogApp(["OAUTH"]))).toBe("hybrid");
		expect(inferCatalogConnectionScope(catalogApp(["oauth"]))).toBe("hybrid");
		expect(inferCatalogConnectionScope(catalogApp(["API_KEY"]))).toBe("tenant");
		expect(inferCatalogConnectionScope(catalogApp(["NONE"]))).toBe("tenant");
		expect(inferCatalogConnectionScope(catalogApp(null))).toBe("tenant");
	});
});

describe("catalogAppUsesConnection", () => {
	it("is true for OAuth and API key apps, in any case", () => {
		expect(catalogAppUsesConnection(catalogApp(["OAUTH"]))).toBe(true);
		expect(catalogAppUsesConnection(catalogApp(["api_key"]))).toBe(true);
		expect(catalogAppUsesConnection(catalogApp(["NONE", "oauth"]))).toBe(true);
	});

	it("is false without a connection-backed auth type", () => {
		expect(catalogAppUsesConnection(catalogApp(["NONE"]))).toBe(false);
		expect(catalogAppUsesConnection(catalogApp([]))).toBe(false);
		expect(catalogAppUsesConnection(catalogApp(null))).toBe(false);
	});
});

describe("normalizeMcpInputSchema", () => {
	const EMPTY = { type: "object", properties: {}, additionalProperties: false };

	it("passes an object schema through and fills the defaults", () => {
		expect(
			normalizeMcpInputSchema({
				type: "object",
				properties: { q: { type: "string" } },
				required: ["q"],
			}),
		).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});
		expect(normalizeMcpInputSchema({ properties: { q: {} } })).toEqual({
			type: "object",
			properties: { q: {} },
		});
		expect(normalizeMcpInputSchema({ type: "object" })).toEqual({
			type: "object",
			properties: {},
		});
	});

	it("keeps unknown keys from the catchall", () => {
		expect(
			normalizeMcpInputSchema({
				type: "object",
				$schema: "https://json-schema.org/draft/2020-12/schema",
				"x-extra": 1,
			}),
		).toEqual({
			type: "object",
			properties: {},
			$schema: "https://json-schema.org/draft/2020-12/schema",
			"x-extra": 1,
		});
	});

	it("coerces a union type schema with properties into a root object", () => {
		expect(
			normalizeMcpInputSchema({
				type: ["object", "null"],
				properties: { a: { type: "string" } },
			}),
		).toEqual({ type: "object", properties: { a: { type: "string" } } });
	});

	it("returns the documented default for non-object or missing schemas", () => {
		expect(normalizeMcpInputSchema({ type: "array" })).toEqual(EMPTY);
		expect(normalizeMcpInputSchema({})).toEqual(EMPTY);
		expect(normalizeMcpInputSchema(null)).toEqual(EMPTY);
		expect(normalizeMcpInputSchema("schema")).toEqual(EMPTY);
		expect(normalizeMcpInputSchema(42)).toEqual(EMPTY);
		expect(normalizeMcpInputSchema([{ type: "object" }])).toEqual(EMPTY);
	});
});

describe("normalizeMcpOutputSchema", () => {
	it("passes non-object schemas through because outputs may be any JSON", () => {
		const schema = { type: "array", items: { type: "string" } };
		expect(normalizeMcpOutputSchema(schema)).toEqual(schema);
	});

	it("keeps unknown keys from the catchall", () => {
		expect(
			normalizeMcpOutputSchema({ type: "string", format: "date-time" }),
		).toEqual({ type: "string", format: "date-time" });
	});

	it("returns null for missing or malformed schemas", () => {
		expect(normalizeMcpOutputSchema(null)).toBeNull();
		expect(normalizeMcpOutputSchema(undefined)).toBeNull();
		expect(normalizeMcpOutputSchema({ type: "bogus" })).toBeNull();
		expect(normalizeMcpOutputSchema({ properties: "nope" })).toBeNull();
		expect(normalizeMcpOutputSchema("schema")).toBeNull();
		expect(normalizeMcpOutputSchema([])).toBeNull();
	});
});

describe("mcpToolOutputSchema", () => {
	const READ_ONLY_DEFAULT = {
		type: "object",
		properties: {},
		additionalProperties: true,
	};

	it("returns a valid upstream schema as-is", () => {
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };
		expect(mcpToolOutputSchema(schema, { readOnlyHint: true })).toEqual(schema);
	});

	it("falls back to the open-object default for read-only tools", () => {
		expect(mcpToolOutputSchema(undefined, { readOnlyHint: true })).toEqual(
			READ_ONLY_DEFAULT,
		);
		expect(
			mcpToolOutputSchema({ type: "bogus" }, { readOnlyHint: true }),
		).toEqual(READ_ONLY_DEFAULT);
	});

	it("returns null when there is no schema and no read-only hint", () => {
		expect(mcpToolOutputSchema(undefined, { readOnlyHint: false })).toBeNull();
		expect(mcpToolOutputSchema(undefined, {})).toBeNull();
		expect(mcpToolOutputSchema(undefined, null)).toBeNull();
	});
});

describe("inferExternalToolOutputSchema", () => {
	const EXTERNAL_DEFAULT = {
		type: "object",
		properties: {},
		additionalProperties: true,
	};

	it("returns the open-object default for external transport tools", () => {
		expect(inferExternalToolOutputSchema({ transport: "external" })).toEqual(
			EXTERNAL_DEFAULT,
		);
		expect(
			inferExternalToolOutputSchema({ transport: "external", method: "post" }),
		).toEqual(EXTERNAL_DEFAULT);
	});

	it("returns null for non-external or malformed configs", () => {
		expect(inferExternalToolOutputSchema({ transport: "mcp" })).toBeNull();
		expect(inferExternalToolOutputSchema({})).toBeNull();
		expect(inferExternalToolOutputSchema(null)).toBeNull();
		expect(inferExternalToolOutputSchema("external")).toBeNull();
		// An empty method string never reaches the "GET" default: it is a
		// string, so it uppercases to "" and falses out of the check.
		expect(
			inferExternalToolOutputSchema({ transport: "external", method: "" }),
		).toBeNull();
	});
});

describe("inferExternalToolAnnotations", () => {
	it("treats a missing method as GET", () => {
		expect(inferExternalToolAnnotations({ transport: "external" })).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("maps each HTTP method to its hint set, case-insensitively", () => {
		expect(
			inferExternalToolAnnotations({ transport: "external", method: "get" }),
		).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(
			inferExternalToolAnnotations({ transport: "external", method: "POST" }),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(
			inferExternalToolAnnotations({ transport: "external", method: "put" }),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(
			inferExternalToolAnnotations({
				transport: "external",
				method: "delete",
			}),
		).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("returns null when the config is not an external tool", () => {
		expect(inferExternalToolAnnotations({ transport: "mcp" })).toBeNull();
		expect(inferExternalToolAnnotations(null)).toBeNull();
		expect(
			inferExternalToolAnnotations({ transport: "external", method: "" }),
		).toBeNull();
	});
});

describe("jsonEqual", () => {
	it("ignores object key order at every depth", () => {
		expect(
			jsonEqual({ a: 1, b: { c: 2, d: [3] } }, { b: { d: [3], c: 2 }, a: 1 }),
		).toBe(true);
	});

	it("keeps array order significant", () => {
		expect(jsonEqual([1, 2], [2, 1])).toBe(false);
	});

	it("treats missing and undefined as null", () => {
		expect(jsonEqual(undefined, null)).toBe(true);
		expect(jsonEqual({ a: undefined }, { a: null })).toBe(true);
	});

	it("distinguishes different values", () => {
		expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonEqual("x", "y")).toBe(false);
	});
});

describe("catalogMcpToolSourceRef", () => {
	it("joins the catalog app id and tool name with a colon", () => {
		expect(catalogMcpToolSourceRef("app-1", "list_things")).toBe(
			"app-1:list_things",
		);
	});
});

describe("ownsCatalogMcpTool", () => {
	it("owns a tool whose mcp transport points at the app", () => {
		expect(
			ownsCatalogMcpTool(
				appToolRow({
					toolId: "list_things",
					config: { transport: "mcp", mcpServerId: "app-1" },
					schemaSourceRef: null,
				}),
				"app-1",
			),
		).toBe(true);
	});

	it("owns a tool whose persisted source ref matches the app", () => {
		expect(
			ownsCatalogMcpTool(
				appToolRow({
					toolId: "list_things",
					config: { transport: "mcp", mcpServerId: "other-app" },
					schemaSourceRef: "app-1:list_things",
				}),
				"app-1",
			),
		).toBe(true);
	});

	it("rejects mcp tools owned by another app and non-mcp transports", () => {
		expect(
			ownsCatalogMcpTool(
				appToolRow({
					toolId: "list_things",
					config: { transport: "mcp", mcpServerId: "other-app" },
					schemaSourceRef: "other-app:list_things",
				}),
				"app-1",
			),
		).toBe(false);
		expect(
			ownsCatalogMcpTool(
				appToolRow({
					toolId: "list_things",
					config: { transport: "external", mcpServerId: "app-1" },
					schemaSourceRef: "app-1:list_things",
				}),
				"app-1",
			),
		).toBe(false);
		expect(
			ownsCatalogMcpTool(
				appToolRow({
					toolId: "list_things",
					config: null,
					schemaSourceRef: "app-1:list_things",
				}),
				"app-1",
			),
		).toBe(false);
	});
});

describe("catalogMcpToolSourceHash", () => {
	const input: Parameters<typeof catalogMcpToolSourceHash>[0] = {
		toolName: "list_things",
		title: "List Things",
		description: "Lists things",
		inputSchema: {
			type: "object",
			properties: { q: { type: "string" } },
			additionalProperties: false,
		},
		outputSchema: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
	};

	it("returns a stable sha-256 hex digest", async () => {
		const hash = await catalogMcpToolSourceHash(input);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await catalogMcpToolSourceHash(input)).toBe(hash);
	});

	it("ignores object key order in the hashed payload", async () => {
		const reordered = {
			...input,
			meta: { a: 1, b: 2 },
		};
		const same = {
			...input,
			meta: { b: 2, a: 1 },
		};
		expect(await catalogMcpToolSourceHash(reordered)).toBe(
			await catalogMcpToolSourceHash(same),
		);
	});

	it("changes when any snapshot field changes", async () => {
		expect(
			await catalogMcpToolSourceHash({ ...input, toolName: "get_thing" }),
		).not.toBe(await catalogMcpToolSourceHash(input));
	});
});

describe("titleFromToolName", () => {
	it("title-cases underscore-separated names", () => {
		expect(titleFromToolName("list_skills")).toBe("List Skills");
		expect(titleFromToolName("search")).toBe("Search");
		expect(titleFromToolName("get2_foo")).toBe("Get2 Foo");
	});
});

describe("normalizeToolTitle", () => {
	it("keeps a non-empty string and rejects everything else", () => {
		expect(normalizeToolTitle("Render deck")).toBe("Render deck");
		expect(normalizeToolTitle("")).toBeNull();
		expect(normalizeToolTitle(42)).toBeNull();
		expect(normalizeToolTitle(null)).toBeNull();
	});
});

describe("normalizeToolIcons", () => {
	it("returns an array unchanged and rejects non-arrays", () => {
		const icons = [{ src: "https://cdn.example.com/icon.png" }];
		expect(normalizeToolIcons(icons)).toBe(icons);
		expect(normalizeToolIcons([])).toEqual([]);
		expect(normalizeToolIcons("icon")).toBeNull();
		expect(normalizeToolIcons({ src: "x" })).toBeNull();
		expect(normalizeToolIcons(null)).toBeNull();
	});
});

describe("normalizeToolMeta", () => {
	it("serializes a record to its persisted JSON form", () => {
		expect(normalizeToolMeta({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
		expect(normalizeToolMeta({ u: undefined })).toEqual({});
	});

	it("returns null for non-records", () => {
		expect(normalizeToolMeta(null)).toBeNull();
		expect(normalizeToolMeta("meta")).toBeNull();
		expect(normalizeToolMeta([1])).toBeNull();
	});
});

describe("normalizeExecutionTaskSupport", () => {
	it("accepts the three task-support values", () => {
		expect(normalizeExecutionTaskSupport({ taskSupport: "required" })).toBe(
			"required",
		);
		expect(normalizeExecutionTaskSupport({ taskSupport: "optional" })).toBe(
			"optional",
		);
		expect(normalizeExecutionTaskSupport({ taskSupport: "forbidden" })).toBe(
			"forbidden",
		);
	});

	it("returns null for anything else", () => {
		expect(normalizeExecutionTaskSupport({ taskSupport: "yes" })).toBeNull();
		expect(normalizeExecutionTaskSupport({})).toBeNull();
		expect(normalizeExecutionTaskSupport(null)).toBeNull();
		expect(normalizeExecutionTaskSupport("required")).toBeNull();
	});
});

describe("isTedixCatalogToolSource", () => {
	it("accepts the first-party tool sources", () => {
		expect(isTedixCatalogToolSource("tedix_app")).toBe(true);
		expect(isTedixCatalogToolSource("openapi")).toBe(true);
		expect(isTedixCatalogToolSource("google-discovery")).toBe(true);
	});

	it("rejects upstream and missing sources", () => {
		expect(isTedixCatalogToolSource("upstream_mcp")).toBe(false);
		expect(isTedixCatalogToolSource(null)).toBe(false);
		expect(isTedixCatalogToolSource(undefined)).toBe(false);
	});
});

describe("isTedixHostedMcpEndpoint", () => {
	it("accepts subdomains of the tedix MCP hostnames", () => {
		expect(isTedixHostedMcpEndpoint("https://docs.mcp.tedix.dev/mcp")).toBe(
			true,
		);
		expect(isTedixHostedMcpEndpoint("https://X.MCP.TEDIX.TECH/mcp")).toBe(true);
		expect(isTedixHostedMcpEndpoint("https://a.b.mcp.tedix.dev/")).toBe(true);
	});

	it("rejects apex, lookalike, external, and malformed endpoints", () => {
		// The suffix match requires a leading dot, so the apex host fails.
		expect(isTedixHostedMcpEndpoint("https://mcp.tedix.dev")).toBe(false);
		expect(isTedixHostedMcpEndpoint("https://mcp.tedix.dev.evil.example")).toBe(
			false,
		);
		expect(isTedixHostedMcpEndpoint("https://notmcp.tedix.dev")).toBe(false);
		expect(isTedixHostedMcpEndpoint("https://example.com/mcp")).toBe(false);
		expect(isTedixHostedMcpEndpoint("not a url")).toBe(false);
		expect(isTedixHostedMcpEndpoint("")).toBe(false);
		expect(isTedixHostedMcpEndpoint(null)).toBe(false);
		expect(isTedixHostedMcpEndpoint(undefined)).toBe(false);
	});
});

describe("shouldProjectCatalogToolsFromBaseApp", () => {
	const base = {
		mcpEndpointNormalized: null as string | null,
		baseUrl: null as string | null,
	};

	it("projects for first-party tool sources regardless of endpoint", () => {
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				...base,
				toolSource: "tedix_app",
			}),
		).toBe(true);
		expect(
			shouldProjectCatalogToolsFromBaseApp({ ...base, toolSource: "openapi" }),
		).toBe(true);
	});

	it("projects upstream_mcp apps hosted on tedix MCP endpoints", () => {
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				toolSource: "upstream_mcp",
				mcpEndpointNormalized: "https://x.mcp.tedix.dev/mcp",
				baseUrl: null,
			}),
		).toBe(true);
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				toolSource: "upstream_mcp",
				mcpEndpointNormalized: null,
				baseUrl: "https://x.mcp.tedix.dev/mcp",
			}),
		).toBe(true);
	});

	it("does not project externally hosted or endpoint-less upstream apps", () => {
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				toolSource: "upstream_mcp",
				mcpEndpointNormalized: "https://example.com/mcp",
				baseUrl: "https://x.mcp.tedix.dev/mcp",
			}),
		).toBe(false);
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				...base,
				toolSource: "upstream_mcp",
			}),
		).toBe(false);
		expect(
			shouldProjectCatalogToolsFromBaseApp({
				...base,
				toolSource: null as unknown as CatalogApp["toolSource"],
			}),
		).toBe(false);
	});
});

describe("toISODate", () => {
	it("normalizes parseable dates to ISO 8601", () => {
		expect(toISODate("2024-03-05T10:00:00Z")).toBe("2024-03-05T10:00:00.000Z");
		expect(toISODate("2024-03-05")).toBe("2024-03-05T00:00:00.000Z");
	});

	it("returns null for missing or unparseable dates", () => {
		expect(toISODate(null)).toBeNull();
		expect(toISODate(undefined)).toBeNull();
		expect(toISODate("")).toBeNull();
		expect(toISODate("garbage")).toBeNull();
	});
});

describe("isTedixCatalogAssetUrl", () => {
	it("accepts catalog asset paths on r2.dev or tedix hosts", () => {
		expect(
			isTedixCatalogAssetUrl("https://pub-x.r2.dev/app_catalog/logo.png"),
		).toBe(true);
		expect(
			isTedixCatalogAssetUrl("https://cdn.tedix.dev/app_catalog/logo.png"),
		).toBe(true);
	});

	it("rejects non-catalog paths and non-tedix hosts", () => {
		expect(
			isTedixCatalogAssetUrl("https://example.com/app_catalog/logo.png"),
		).toBe(false);
		expect(isTedixCatalogAssetUrl("https://pub-x.r2.dev/other.png")).toBe(
			false,
		);
		expect(isTedixCatalogAssetUrl(42)).toBe(false);
	});
});

describe("isExternalCatalogLogoUrl", () => {
	it("accepts http(s) urls that are not tedix catalog assets", () => {
		expect(isExternalCatalogLogoUrl("https://example.com/logo.png")).toBe(true);
		expect(isExternalCatalogLogoUrl(" http://example.com/logo.png ")).toBe(
			true,
		);
	});

	it("rejects tedix assets and non-http(s) values", () => {
		expect(
			isExternalCatalogLogoUrl("https://pub-x.r2.dev/app_catalog/logo.png"),
		).toBe(false);
		expect(isExternalCatalogLogoUrl("example.com/logo.png")).toBe(false);
		expect(isExternalCatalogLogoUrl("ftp://example.com/logo.png")).toBe(false);
		expect(isExternalCatalogLogoUrl("data:image/png;base64,AAAA")).toBe(false);
		expect(isExternalCatalogLogoUrl(42)).toBe(false);
	});
});

describe("incomingLogoRepairFailed", () => {
	it("flags the three failure statuses", () => {
		for (const logoStatus of ["fetch_failed", "missing", "invalid"]) {
			expect(incomingLogoRepairFailed({ quality: { logoStatus } })).toBe(true);
		}
	});

	it("ignores healthy or missing quality records", () => {
		expect(incomingLogoRepairFailed({ quality: { logoStatus: "ok" } })).toBe(
			false,
		);
		expect(incomingLogoRepairFailed({ quality: "x" })).toBe(false);
		expect(incomingLogoRepairFailed({})).toBe(false);
		expect(incomingLogoRepairFailed(null)).toBe(false);
		expect(incomingLogoRepairFailed(undefined)).toBe(false);
	});
});

describe("renderableLogoUrl", () => {
	it("returns trimmed http(s) and data image urls", () => {
		expect(renderableLogoUrl(" https://example.com/l.png ")).toBe(
			"https://example.com/l.png",
		);
		expect(renderableLogoUrl("http://example.com/l.png")).toBe(
			"http://example.com/l.png",
		);
		expect(renderableLogoUrl("data:image/png;base64,AAAA")).toBe(
			"data:image/png;base64,AAAA",
		);
	});

	it("rejects empty, non-string, and non-renderable values", () => {
		expect(renderableLogoUrl("")).toBeNull();
		expect(renderableLogoUrl("   ")).toBeNull();
		expect(renderableLogoUrl("data:text/plain;base64,AAAA")).toBeNull();
		expect(renderableLogoUrl("javascript:alert(1)")).toBeNull();
		expect(renderableLogoUrl(42)).toBeNull();
		expect(renderableLogoUrl(null)).toBeNull();
	});
});

describe("normalizeRichContent", () => {
	it("normalizes date fields and drops unparseable ones", () => {
		expect(
			normalizeRichContent({
				htmlDescription: "<p>Hi</p>",
				publishedAt: "2024-03-05T10:00:00Z",
				sourceUpdatedAt: "garbage",
				enrichedAt: null,
				enrichmentFailedAt: "2024-01-01",
			}),
		).toEqual({
			htmlDescription: "<p>Hi</p>",
			publishedAt: "2024-03-05T10:00:00.000Z",
			sourceUpdatedAt: null,
			enrichedAt: null,
			enrichmentFailedAt: "2024-01-01T00:00:00.000Z",
		});
	});

	it("returns null for missing content", () => {
		expect(normalizeRichContent(null)).toBeNull();
		expect(normalizeRichContent(undefined)).toBeNull();
	});
});

describe("mergeRichContent", () => {
	it("returns null when both sides are empty", () => {
		expect(mergeRichContent(null, null)).toBeNull();
		expect(mergeRichContent(undefined, undefined)).toBeNull();
	});

	it("returns the existing record untouched when there is no incoming", () => {
		const existing = { publishedAt: "not-a-date" };
		expect(mergeRichContent(existing, null)).toBe(existing);
	});

	it("normalizes an incoming-only record", () => {
		expect(
			mergeRichContent(null, { publishedAt: "2024-03-05T10:00:00Z" }),
		).toEqual({
			publishedAt: "2024-03-05T10:00:00.000Z",
			sourceUpdatedAt: null,
			enrichedAt: null,
			enrichmentFailedAt: null,
		});
	});

	it("lets incoming values fill gaps and win when present", () => {
		expect(
			mergeRichContent(
				{ serverLabel: "old", installCommand: "keep" },
				{ serverLabel: "new" },
			),
		).toMatchObject({ serverLabel: "new", installCommand: "keep" });
	});

	it("prefers a tedix catalog asset screenshot over an external one", () => {
		const tedixShot = "https://pub-x.r2.dev/app_catalog/shot.png";
		expect(
			mergeRichContent(
				{ screenshotUrl: "https://example.com/shot.png" },
				{ screenshotUrl: tedixShot },
			)?.screenshotUrl,
		).toBe(tedixShot);
		expect(
			mergeRichContent(
				{ screenshotUrl: tedixShot },
				{ screenshotUrl: "https://pub-y.r2.dev/app_catalog/other.png" },
			)?.screenshotUrl,
		).toBe(tedixShot);
		expect(
			mergeRichContent(
				{ screenshotUrl: null },
				{ screenshotUrl: "https://example.com/shot.png" },
			)?.screenshotUrl,
		).toBe("https://example.com/shot.png");
	});

	it("keeps the existing publishedAt when the incoming one is invalid", () => {
		expect(
			mergeRichContent(
				{ publishedAt: "2024-01-01T00:00:00.000Z" },
				{ publishedAt: "garbage" },
			)?.publishedAt,
		).toBe("2024-01-01T00:00:00.000Z");
	});

	it("applies incoming enrichmentError and enrichmentFailedAt only when defined", () => {
		const merged = mergeRichContent(
			{
				enrichmentError: "boom",
				enrichmentFailedAt: "2024-01-01T00:00:00.000Z",
			},
			{ enrichmentError: null, enrichmentFailedAt: "garbage" },
		);
		expect(merged?.enrichmentError).toBeNull();
		// Unlike publishedAt, an unparseable incoming failure date clears the
		// stored value rather than falling back to it.
		expect(merged?.enrichmentFailedAt).toBeNull();

		const kept = mergeRichContent(
			{
				enrichmentError: "boom",
				enrichmentFailedAt: "2024-01-01T00:00:00.000Z",
			},
			{ serverLabel: "new" },
		);
		expect(kept?.enrichmentError).toBe("boom");
		expect(kept?.enrichmentFailedAt).toBe("2024-01-01T00:00:00.000Z");
	});
});

describe("mergeCatalogRawData", () => {
	it("returns null when both sides are empty", () => {
		expect(mergeCatalogRawData(null, null)).toBeNull();
		expect(mergeCatalogRawData(undefined, undefined)).toBeNull();
		expect(mergeCatalogRawData(undefined, {})).toBeNull();
	});

	it("serializes the existing record when incoming is absent or malformed", () => {
		expect(mergeCatalogRawData({ a: 1 }, null)).toEqual({ a: 1 });
		expect(mergeCatalogRawData({ a: 1 }, "junk")).toEqual({ a: 1 });
		expect(mergeCatalogRawData(null, "junk")).toBeNull();
	});

	it("merges incoming keys, skipping null and undefined values", () => {
		expect(
			mergeCatalogRawData({ a: 1 }, { b: 2, a: null, c: undefined }),
		).toEqual({ a: 1, b: 2 });
	});

	it("shallow-merges the quality record instead of replacing it", () => {
		expect(
			mergeCatalogRawData(
				{ quality: { logoStatus: "ok", score: 5 } },
				{ quality: { logoStatus: "invalid" } },
			),
		).toEqual({ quality: { logoStatus: "invalid", score: 5 } });
	});
});

describe("normalizeToolAnnotations", () => {
	it("keeps title and the four boolean hints only", () => {
		expect(
			normalizeToolAnnotations({
				title: "Render deck",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
				cost: { usd: 0.02 },
				progressHint: true,
				returnDirect: true,
				"x-openai-isConsequential": false,
			}),
		).toEqual({
			title: "Render deck",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("drops known keys with the wrong type", () => {
		expect(
			normalizeToolAnnotations({
				title: 42,
				readOnlyHint: "true",
				destructiveHint: 1,
				openWorldHint: true,
			}),
		).toEqual({ openWorldHint: true });
	});

	it("returns null when nothing valid remains", () => {
		expect(normalizeToolAnnotations({ cost: { usd: 1 } })).toBeNull();
		expect(normalizeToolAnnotations({})).toBeNull();
		expect(normalizeToolAnnotations(null)).toBeNull();
		expect(normalizeToolAnnotations(["readOnlyHint"])).toBeNull();
		expect(normalizeToolAnnotations("readOnly")).toBeNull();
	});
});

describe("splitToolAnnotations", () => {
	it("returns every dropped key as extras", () => {
		expect(
			splitToolAnnotations({
				readOnlyHint: "yes",
				idempotentHint: true,
				"x-openai-isConsequential": true,
			}),
		).toEqual({
			annotations: { idempotentHint: true },
			extras: { readOnlyHint: "yes", "x-openai-isConsequential": true },
		});
		expect(splitToolAnnotations({ title: "Clean" }).extras).toBeNull();
	});

	it("moves schema hints outside the kept set into extras", () => {
		// untrustedContentHint is part of ToolAnnotationsSchema but not one of
		// the four MCP hint keys this splitter keeps, so it lands in extras.
		expect(splitToolAnnotations({ untrustedContentHint: true })).toEqual({
			annotations: null,
			extras: { untrustedContentHint: true },
		});
	});

	it("returns nulls for non-record input", () => {
		expect(splitToolAnnotations(null)).toEqual({
			annotations: null,
			extras: null,
		});
	});
});

describe("withUpstreamAnnotationsMeta", () => {
	it("merges extras under the namespaced key and leaves meta alone without them", () => {
		const meta = { audience: ["user"] };
		expect(withUpstreamAnnotationsMeta(meta, null)).toBe(meta);
		expect(withUpstreamAnnotationsMeta(null, null)).toBeNull();
		expect(withUpstreamAnnotationsMeta(meta, { cost: 1 })).toEqual({
			audience: ["user"],
			[UPSTREAM_TOOL_ANNOTATIONS_META_KEY]: { cost: 1 },
		});
	});
});
