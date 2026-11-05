import { describe, expect, it } from "vite-plus/test";
import {
	CatalogueDescribeInputJsonSchema,
	CatalogueSearchInputJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import {
	isNativeCatalogTool,
	NATIVE_CATALOG_TOOLS,
	servesNativeCatalog,
	withNativeCatalogTools,
} from "./native-catalog-tools";
import { evaluateMcpToolScopeAuthorization } from "./codemode-auth";
import { enforceNativeToolScopeGate } from "./tool-registration-policy";
import type { AppTool, ServerContext } from "./server-context";

const gateway = { mcpConfig: { codeMode: true } };
const stored = {
	...NATIVE_CATALOG_TOOLS[0]!,
	id: "fictional-stored-row",
	description: "Stored description",
} as AppTool;
const work = {
	...NATIVE_CATALOG_TOOLS[0]!,
	id: "fictional-work-row",
	toolId: "list_work",
	config: { transport: "rpc", endpoint: "workItems/list" },
} as AppTool;

describe("built-in native catalog pair", () => {
	it("declares the catalog parser's own input schemas with stable provenance", () => {
		const [search, describe] = NATIVE_CATALOG_TOOLS;
		expect(search).toMatchObject({
			toolId: "search_native_tools",
			config: {
				transport: "catalog",
				endpoint: "catalog/search",
				nativeDirect: true,
			},
			inputSchema: CatalogueSearchInputJsonSchema,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				destructiveHint: false,
				openWorldHint: false,
			},
			schemaSource: "manual",
			schemaSourceRef:
				"@tedix/api-contract/schemas/tools:CatalogueSearchInputJsonSchema",
		});
		expect(describe).toMatchObject({
			toolId: "get_native_tool_schema",
			config: { endpoint: "catalog/describe" },
			inputSchema: CatalogueDescribeInputJsonSchema,
		});
		expect(search!.schemaSourceHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
		expect(search!.schemaSourceHash).not.toBe(describe!.schemaSourceHash);
		expect(Number.isFinite(Date.parse(search!.schemaSyncedAt!))).toBe(true);
	});

	it("adds the pair to a gateway with no stored catalog rows", () => {
		const tools = withNativeCatalogTools([work], "fictional-unified", gateway);
		expect(tools.map((tool) => tool.toolId)).toEqual([
			"list_work",
			"search_native_tools",
			"get_native_tool_schema",
		]);
		expect(tools.filter(isNativeCatalogTool)).toHaveLength(2);
	});

	it("drops stored catalog rows so the pair is never duplicated", () => {
		const tools = withNativeCatalogTools(
			[stored, work],
			"fictional-unified",
			gateway,
		);
		const search = tools.filter(
			(tool) => tool.toolId === "search_native_tools",
		);
		expect(search).toHaveLength(1);
		expect(search[0]!.id).toBe("native-catalog:search");
		expect(isNativeCatalogTool(stored)).toBe(false);
		// Without Code Mode the stored row is still removed and nothing is added.
		expect(withNativeCatalogTools([stored, work], "fictional", {})).toEqual([
			work,
		]);
	});

	it("is served only by single-organization Code Mode gateways outside policy mode", () => {
		expect(servesNativeCatalog("fictional-unified", gateway)).toBe(true);
		expect(servesNativeCatalog("fictional", { mcpConfig: {} })).toBe(false);
		expect(
			servesNativeCatalog("fictional-unified", {
				mcpConfig: { codeMode: true, enforcePolicies: true },
			}),
		).toBe(false);
		expect(
			servesNativeCatalog("connect", {
				mcpConfig: { codeMode: true, multiOrgConsent: true },
			}),
		).toBe(false);
	});

	it("requires mcp:catalog.read whatever the gateway's toolScopes say", () => {
		const [search] = withNativeCatalogTools([], "fictional-unified", gateway);
		const context = (scopes: string[]) =>
			({
				appMetadata: {
					mcpConfig: {
						codeMode: true,
						toolScopes: { "*": [], catalog: ["platform:admin"] },
					},
				},
				callerIdentity: { authType: "oauth", scopes },
			}) as unknown as Pick<ServerContext, "appMetadata" | "callerIdentity">;
		expect(
			evaluateMcpToolScopeAuthorization(
				context(["mcp:catalog.read"]),
				search!,
				"fictional",
			),
		).toEqual({ authorized: true });
		expect(
			evaluateMcpToolScopeAuthorization(
				context(["mcp:work.read"]),
				search!,
				"fictional",
			),
		).toMatchObject({
			authorized: false,
			requiredScopes: ["mcp:catalog.read"],
		});
		// Added after the edge gate, so native dispatch checks it itself.
		expect(
			enforceNativeToolScopeGate(context(["mcp:catalog.read"]), search!),
		).toBeNull();
		expect(
			enforceNativeToolScopeGate(context(["mcp:work.read"]), search!),
		).toMatchObject({
			isError: true,
			structuredContent: {
				error: "insufficient_scope",
				missing_scopes: ["mcp:catalog.read"],
			},
		});
	});
});
