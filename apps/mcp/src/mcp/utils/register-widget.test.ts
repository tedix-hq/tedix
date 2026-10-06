/**
 * MCP Apps `ui/` dialect completeness guard (SEP-1865)
 *
 * `register-widget.ts` hand-rolls the MCP Apps `_meta.ui` payloads the server
 * emits for the MCP-App host profile (tool `_meta.ui` + resource `_meta.ui`).
 * These bytes go on the wire to hosts that decode them against the
 * `@modelcontextprotocol/ext-apps` contract, so the builders must stay in
 * lock-step with that SDK's `McpUiToolMeta` / `McpUiResourceMeta` shapes and
 * with its canonical MCP-App MIME type.
 *
 * Pin our hand-rolled literals to the SDK exports so an upstream rename or
 * version bump surfaces as a loud test failure instead of silent protocol
 * drift.
 */
import {
	type McpUiResourceCsp,
	McpUiResourceCspSchema,
	type McpUiResourceMeta,
	McpUiResourceMetaSchema,
	type McpUiToolMeta,
	McpUiToolMetaSchema,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps";
import type { AppTool } from "@tedix/api-contract/schemas/app";
import { describe, expect, it } from "vite-plus/test";
import type { OpenAiWidgetCSP } from "../types";
import {
	buildMcpAppResourceMeta,
	buildResourceUris,
	buildToolMeta,
	WIDGET_MIME_TYPES,
	WIDGET_RESOURCE_CACHE_HINT,
} from "./register-widget";

// =============================================================================
// SAMPLE FIXTURES
// =============================================================================

const WIDGET_DOMAIN = "https://demo-widgets.tedix.dev";

/** A representative widget-bearing tool row as loaded from D1. */
const sampleTool: AppTool = {
	id: "00000000-0000-0000-0000-000000000001",
	toolId: "search_listings",
	toolTypeId: "widget",
	title: "Search Listings",
	description: "Search vehicle listings",
	inputSchema: { type: "object", properties: {} },
	outputSchema: null,
	adapterScope: null,
	resultStrategy: null,
	outputTemplate: null,
	widgetKey: "search-listings",
	widgetRoute: "/search-listings",
	widgetAccessible: true,
	authRequired: false,
	visibility: "public",
	icons: null,
	executionTaskSupport: null,
	annotations: null,
	meta: null,
	invocationStatus: { invoking: "Searching…", invoked: "Found results" },
	fileParams: null,
	widgetDescription: "Interactive listing search widget",
	widgetPrefersBorder: true,
	widgetDomain: WIDGET_DOMAIN,
	config: null,
	schemaDialect: null,
	schemaSource: null,
	schemaSourceRef: null,
	schemaSourceHash: null,
	schemaSyncedAt: null,
	sortOrder: 0,
	enabled: true,
	createdAt: null,
	updatedAt: null,
};

const sampleCsp: OpenAiWidgetCSP = {
	connect_domains: ["https://api.demo.tedix.dev"],
	resource_domains: ["https://cdn.demo.tedix.dev"],
	frame_domains: ["https://embed.demo.tedix.dev"],
	redirect_domains: ["https://demo.tedix.dev"],
};

// =============================================================================
// COMPILE-TIME CONTRACT (erased at runtime)
//
// These `satisfies` checks pin the exact `_meta.ui` field names the builders
// emit to the ext-apps SDK types. If the SDK renames a field (e.g.
// `connectDomains` -> `connect_domains`, or drops `resourceUri`), the
// excess-property check fails the type build. Underscore-prefixed so lint
// treats them as intentionally unused.
// =============================================================================

const _toolUiContract = {
	resourceUri: "ui://widgets/mcp-app/demo/search-listings.html",
	visibility: ["model", "app"],
} satisfies McpUiToolMeta;

const _resourceCspContract = {
	connectDomains: ["https://api.demo.tedix.dev"],
	resourceDomains: ["https://cdn.demo.tedix.dev"],
	frameDomains: ["https://embed.demo.tedix.dev"],
	baseUriDomains: [WIDGET_DOMAIN],
} satisfies McpUiResourceCsp;

const _resourceUiContract = {
	csp: _resourceCspContract,
	permissions: {},
	domain: WIDGET_DOMAIN,
	prefersBorder: true,
} satisfies McpUiResourceMeta;

// =============================================================================
// TESTS
// =============================================================================

describe("register-widget MCP Apps ui/ dialect parity", () => {
	it("pins WIDGET_MIME_TYPES.MCP_APP to the ext-apps RESOURCE_MIME_TYPE export", () => {
		// If the SDK renames the MCP-App profile MIME, this fails loudly instead
		// of the server silently emitting an unrecognized mimeType.
		expect(WIDGET_MIME_TYPES.MCP_APP).toBe(RESOURCE_MIME_TYPE);
		expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
	});

	it("pins the SEP-2549 ui:// template hint: 1 hour, public (deploy-versioned static HTML)", () => {
		expect(WIDGET_RESOURCE_CACHE_HINT).toEqual({
			ttlMs: 3_600_000,
			cacheScope: "public",
		});
	});

	it("buildToolMeta().ui satisfies the ext-apps McpUiToolMeta contract", () => {
		const uris = buildResourceUris(
			"demo",
			sampleTool.widgetRoute ?? "/search-listings",
			"deadbeef",
		);
		const meta = buildToolMeta(sampleTool, uris);

		// Runtime parity: the emitted ui payload must decode cleanly against the
		// SDK schema. A renamed/dropped field would fail the parse.
		const parsed = McpUiToolMetaSchema.parse(meta.ui);

		expect(parsed.resourceUri).toBe(uris.mcpApp);
		expect(parsed.visibility).toEqual(["model", "app"]);

		// Apps-SDK sibling fields still ride alongside on the same _meta object.
		expect(meta["openai/outputTemplate"]).toBe(uris.appsSdk);
		expect(meta["openai/resultCanProduceWidget"]).toBe(true);
	});

	it("buildMcpAppResourceMeta().ui satisfies the ext-apps McpUiResourceMeta contract", () => {
		const resourceMeta = buildMcpAppResourceMeta(
			sampleTool,
			sampleCsp,
			WIDGET_DOMAIN,
		);

		// Runtime parity: the resource ui payload decodes against the SDK schema.
		const parsed = McpUiResourceMetaSchema.parse(resourceMeta.ui);

		// csp: camelCase keys, mapped from the snake_case OpenAiWidgetCSP source.
		expect(parsed.csp).toEqual({
			baseUriDomains: [WIDGET_DOMAIN],
			connectDomains: sampleCsp.connect_domains,
			frameDomains: sampleCsp.frame_domains,
			resourceDomains: sampleCsp.resource_domains,
		});
		expect(parsed.domain).toBe(WIDGET_DOMAIN);
		expect(parsed.prefersBorder).toBe(true);
		expect(parsed.permissions).toEqual({});
	});

	it("emits only valid per-tool MCP Apps sandbox permissions", () => {
		const resourceMeta = buildMcpAppResourceMeta(
			{
				...sampleTool,
				config: {
					mcpAppPermissions: {
						camera: {},
						clipboardWrite: {},
					},
				},
			},
			sampleCsp,
			WIDGET_DOMAIN,
		);
		const parsed = McpUiResourceMetaSchema.parse(resourceMeta.ui);

		expect(parsed.permissions).toEqual({
			camera: {},
			clipboardWrite: {},
		});
	});

	it("fails closed when per-tool MCP Apps permissions are malformed", () => {
		const resourceMeta = buildMcpAppResourceMeta(
			{
				...sampleTool,
				config: {
					mcpAppPermissions: {
						camera: true,
						unknownCapability: {},
					},
				},
			},
			sampleCsp,
			WIDGET_DOMAIN,
		);
		const parsed = McpUiResourceMetaSchema.parse(resourceMeta.ui);

		expect(parsed.permissions).toEqual({});
	});

	it("emits csp keys the ext-apps McpUiResourceCsp schema recognizes (camelCase round-trip)", () => {
		const resourceMeta = buildMcpAppResourceMeta(
			sampleTool,
			sampleCsp,
			WIDGET_DOMAIN,
		);
		const ui = resourceMeta.ui as { csp: Record<string, unknown> };

		// The SDK csp schema strips unrecognized keys, so a snake_case regression
		// would parse to a value that no longer round-trips.
		const parsedCsp = McpUiResourceCspSchema.parse(ui.csp);
		expect(parsedCsp).toEqual(ui.csp);

		// Explicit key pins — the four MCP Apps csp domain buckets.
		expect(ui.csp).toHaveProperty("connectDomains");
		expect(ui.csp).toHaveProperty("resourceDomains");
		expect(ui.csp).toHaveProperty("frameDomains");
		expect(ui.csp).toHaveProperty("baseUriDomains");
	});

	it("falls back to the passed widget domain when the tool omits one", () => {
		const toolWithoutDomain: AppTool = {
			...sampleTool,
			widgetDomain: null,
			widgetPrefersBorder: null,
		};
		const resourceMeta = buildMcpAppResourceMeta(
			toolWithoutDomain,
			sampleCsp,
			WIDGET_DOMAIN,
		);
		const parsed = McpUiResourceMetaSchema.parse(resourceMeta.ui);

		expect(parsed.domain).toBe(WIDGET_DOMAIN);
		expect(parsed.csp?.baseUriDomains).toEqual([WIDGET_DOMAIN]);
		// widgetPrefersBorder defaults to true when the column is null.
		expect(parsed.prefersBorder).toBe(true);
	});
});
