/** Scope-extraction regression tests for single-message tools/call requests. */

import { describe, expect, it } from "vite-plus/test";
import {
	extractRequiredScopes,
	shouldEnforceMcpToolScopes,
} from "./auth-helpers";
import {
	extractCodeModeProviderNamespacesFromCode,
	filterAggregateAppsForCodeNamespaces,
	filterAggregateTedisForCodeNamespaces,
} from "./index";
import {
	PLATFORM_OPERATOR_ADMIN_APP_SLUG,
	PLATFORM_OPERATOR_CODE_MODE_NAMESPACES,
} from "./mcp/platform-operator-aggregation";
import type { AppTool } from "./mcp/server-context";

const URL_OK = "https://test.local/mcp";

function postRpc(body: unknown): Request {
	return new Request(URL_OK, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

const TOOL_SCOPES = {
	read_listings: ["mcp:read"],
	create_app: ["mcp:write", "platform:admin"],
	delete_app: ["platform:admin"],
};

function tool(overrides: Partial<AppTool>): AppTool {
	return {
		id: "tool-row-id",
		toolId: "apps_list",
		title: "Apps list",
		description: null,
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

describe("extractRequiredScopes — D1 toolScopes mode", () => {
	it("enforces resolved tool scopes for OAuth, tedi, and external-agent callers", () => {
		expect(shouldEnforceMcpToolScopes("oauth")).toBe(true);
		expect(shouldEnforceMcpToolScopes("tedi")).toBe(true);
		expect(shouldEnforceMcpToolScopes("external_agent")).toBe(true);
		expect(shouldEnforceMcpToolScopes("service")).toBe(false);
		expect(shouldEnforceMcpToolScopes(null)).toBe(false);
	});

	it("returns scopes for a single tools/call", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_app", arguments: {} },
			}),
			TOOL_SCOPES,
		);
		expect(got?.sort()).toEqual(["mcp:write", "platform:admin"]);
	});

	it("returns undefined when a tool has no D1 scope mapping", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "unmapped_tool", arguments: {} },
			}),
			TOOL_SCOPES,
		);
		expect(got).toBeUndefined();
	});

	it("dedupes duplicate scopes inside one tool mapping", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "duplicated", arguments: {} },
			}),
			{ duplicated: ["platform:admin", "platform:admin", "mcp:write"] },
		);
		expect(got?.sort()).toEqual(["mcp:write", "platform:admin"]);
	});

	// Previously asserted `undefined` on the reasoning that the transport rejects
	// arrays before dispatch. That made the gate fail closed by ORDERING rather
	// than by design: `extractRequiredScopes` itself resolved no scopes for an
	// array, so a single-item batch that ever reached it would skip the gate
	// entirely. Resolve the union across entries instead, matching the sibling
	// policy-mode path (`readJsonRpcEnvelope`), which already unwraps batches.
	it("resolves the scope union across a JSON-RPC batch (fail-closed)", async () => {
		const got = await extractRequiredScopes(
			postRpc([
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "delete_app" },
				},
			]),
			TOOL_SCOPES,
		);
		expect(got).toEqual(["platform:admin"]);
	});

	it("unions scopes across every entry in a multi-item batch", async () => {
		const got = await extractRequiredScopes(
			postRpc([
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "delete_app" },
				},
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "duplicated" },
				},
			]),
			{ ...TOOL_SCOPES, duplicated: ["mcp:write"] },
		);
		expect(got?.sort()).toEqual(["mcp:write", "platform:admin"]);
	});

	it("returns undefined for non-POST", async () => {
		const got = await extractRequiredScopes(
			new Request(URL_OK, { method: "GET" }),
			TOOL_SCOPES,
		);
		expect(got).toBeUndefined();
	});

	it("returns undefined when toolScopes config is absent", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "create_app", arguments: {} },
			}),
			undefined,
		);
		expect(got).toBeUndefined();
	});

	it("uses namespace fallback when a scoped config omits a direct tool", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "apps_list", arguments: {} },
			}),
			{ other_tool: ["mcp:content.write"] },
			[tool({ toolId: "apps_list" })],
			{ toolScopes: { other_tool: ["mcp:content.write"] } },
		);
		expect(got).toEqual(["mcp:apps.read"]);
	});

	it("requires auth for private direct tools even without explicit toolScopes", async () => {
		const got = await extractRequiredScopes(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "memory_search", arguments: {} },
			}),
			undefined,
			[tool({ toolId: "memory_search", visibility: "private" })],
			{ authMode: "hybrid" },
		);
		expect(got).toEqual(["mcp:memory.read"]);
	});

	it("extracts Work write for exact self-lifecycle RPC bindings", async () => {
		for (const [name, endpoint] of [
			["end_external_agent_session", "externalAgentIdentity/endSession"],
			[
				"record_external_agent_knowledge_checkpoint",
				"externalAgentIdentity/recordKnowledgeCheckpoint",
			],
			[
				"record_external_agent_knowledge_disposition",
				"externalAgentIdentity/recordKnowledgeDisposition",
			],
		] as const) {
			const got = await extractRequiredScopes(
				postRpc({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: {} },
				}),
				undefined,
				[
					tool({
						toolId: name,
						config: { endpoint },
						visibility: "private",
						annotations: { destructiveHint: true },
					}),
				],
				{ authMode: "authenticated" },
			);
			expect(got, name).toEqual(["mcp:work.write"]);
		}
	});

	it("gates destructive external-agent governance to mcp:settings, not the broad mcp:observe", async () => {
		for (const name of [
			"end_external_agent_session",
			"retire_abandoned_external_agent_session",
			"revoke_external_agent_mcp_credential",
		]) {
			const got = await extractRequiredScopes(
				postRpc({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: {} },
				}),
				undefined,
				[
					tool({
						toolId: name,
						visibility: "private",
						annotations: { destructiveHint: true },
					}),
				],
				{ authMode: "authenticated" },
			);
			// A tedi holding only the broad mcp:observe (every profile does) can no
			// longer terminate another agent's session or credential.
			expect(got, name).toEqual(["mcp:settings.admin"]);
		}
	});

	it("keeps non-destructive external-agent knowledge tools on mcp:observe", async () => {
		for (const name of [
			"record_external_agent_knowledge_checkpoint",
			"record_external_agent_knowledge_disposition",
			"list_stale_external_agent_knowledge_sessions",
		]) {
			const got = await extractRequiredScopes(
				postRpc({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: {} },
				}),
				undefined,
				[tool({ toolId: name, visibility: "private" })],
				{ authMode: "authenticated" },
			);
			expect(got, name).toEqual([
				name.startsWith("list_") ? "mcp:observe.read" : "mcp:observe.write",
			]);
		}
	});
});

describe("targeted Code Mode surface extraction", () => {
	it("extracts explicit provider calls without treating built-ins as namespaces", () => {
		const namespaces = extractCodeModeProviderNamespacesFromCode(
			`async () => {
				const run = await home.read_home_run({ homeRunId: "run_1" });
				const status = await cpo.exec({ command: "git status" });
				return { keys: Object.keys(run), status: JSON.stringify(status) };
			}`,
		);

		expect(namespaces).toEqual(new Set(["home", "cpo"]));
	});

	it("extracts static bracket calls emitted by workflow Code Mode recovery", () => {
		const namespaces = extractCodeModeProviderNamespacesFromCode(
			`async () => {
				const products = await acme_official_tedix["search_products"]({ query: "monitor" });
				const research = await firecrawl_tedix['firecrawl_agent']({ prompt: "research" });
				return { products, research };
			}`,
		);

		expect(namespaces).toEqual(
			new Set(["acme_official_tedix", "firecrawl_tedix"]),
		);
	});

	it("falls back to the full aggregate surface when code uses discovery", () => {
		expect(
			extractCodeModeProviderNamespacesFromCode(
				`async () => await discover.search("home run")`,
			),
		).toBeNull();
	});
	it.each([
		'async () => await discover.search({"namespace":"tedix_unified","query":"run","limit":3})',
		'async () => discover.describe("tedix_unified.read_run");',
		'async () => await discover.describe({"callable":"tedix_unified.read_run"})',
	])("bounds complete literal discovery: %s", (code) => {
		const namespaces = extractCodeModeProviderNamespacesFromCode(code);
		expect(namespaces).toEqual(new Set(["tedix_unified"]));
		expect(
			filterAggregateAppsForCodeNamespaces(
				[
					{ slug: "tedix-unified" },
					{ slug: "acme-unified" },
					{ slug: "gmail" },
				],
				namespaces,
			).map((entry) => entry.slug),
		).toEqual(["tedix-unified"]);
	});
	it.each([
		'async () => await discover.search({"namespace":""})',
		'async () => await discover.search({"namespace":"tedix_unified" + suffix})',
		'async () => { const q = {namespace:"tedix_unified"}; return await discover.search(q); }',
		'async () => await discover.search({"namespace":"tedix_unified"}); await gmail.list_messages({})',
		'async () => await discover.describe({"callable":"dynamic"})',
		"async () => await discover.list_namespaces()",
		'async () => await discover.search({"namespace":"tedix_unified", "query": other.call()})',
	])(
		"retains complete catalog for dynamic or invalid discovery: %s",
		(code) => {
			expect(extractCodeModeProviderNamespacesFromCode(code)).toBeNull();
		},
	);

	it("filters aggregate apps and tedis to only namespaces used by code", () => {
		const apps = filterAggregateAppsForCodeNamespaces(
			[
				{ slug: "google-gmail-tedix" },
				{ slug: "promptwatch-tedix", prefix: "promptwatch_tedix" },
				{ slug: "todoist-tedix" },
			],
			new Set(["gmail", "cpo"]),
			{ google_gmail_tedix: "gmail" },
		);
		const tedis = filterAggregateTedisForCodeNamespaces(
			[{ slug: "cto" }, { slug: "cpo" }, { slug: "content", namespace: "cms" }],
			new Set(["gmail", "cpo"]),
		);

		expect(apps.map((entry) => entry.slug)).toEqual(["google-gmail-tedix"]);
		expect(tedis?.map((entry) => entry.slug)).toEqual(["cpo"]);
	});

	it("hydrates the configured workforce for flow default resolution", () => {
		const tedis = filterAggregateTedisForCodeNamespaces(
			[{ slug: "acme-operator", namespace: "operator" }, { slug: "reviewer" }],
			new Set(["flow", "skills", "cto"]),
		);

		expect(tedis?.map((entry) => entry.slug)).toEqual([
			"acme-operator",
			"reviewer",
		]);
	});

	it("includes the platform-operator admin app when code calls a platform namespace (tedis / workflows / cognitive)", () => {
		// The "tedix" admin app holds tools whose Code Mode namespaces come from
		// endpoint path prefixes ("tedis/list" → "tedis", "workflows/listRuns" →
		// "workflows"). These do not match the entry slug "tedix", so the standard
		// candidate check would filter them out. The fix recognises the admin slug
		// and matches against PLATFORM_OPERATOR_CODE_MODE_NAMESPACES instead.
		const apps = filterAggregateAppsForCodeNamespaces(
			[
				{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG },
				{ slug: "gmail" },
				{ slug: "todoist" },
			],
			new Set(["tedis", "workflows", "cognitive"]),
		);

		// Only "tedix" matches (its platform namespaces include "tedis" and "workflows")
		expect(apps.map((entry) => entry.slug)).toEqual([
			PLATFORM_OPERATOR_ADMIN_APP_SLUG,
		]);
	});

	it("includes the platform-operator admin app when a configured aggregate prefix is tedix", () => {
		const apps = filterAggregateAppsForCodeNamespaces(
			[{ slug: "tedix-platform", prefix: PLATFORM_OPERATOR_ADMIN_APP_SLUG }],
			new Set(["cognitive"]),
		);

		expect(apps.map((entry) => entry.slug)).toEqual(["tedix-platform"]);
	});

	it("fails open into the admin app for D1-synced namespaces missing from the static platform set", () => {
		// "skills" tools are D1-synced platform-operator tools whose namespace is
		// not derivable from PLATFORM_OPERATOR_TOOL_DEFINITIONS. A direct
		// `skills.list_skills_by_org(...)` snippet must still hydrate the admin
		// entry instead of mounting nothing ("skills is not defined").
		const apps = filterAggregateAppsForCodeNamespaces(
			[{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }, { slug: "gmail" }],
			new Set(["skills"]),
		);

		expect(apps.map((entry) => entry.slug)).toEqual([
			PLATFORM_OPERATOR_ADMIN_APP_SLUG,
		]);
	});

	it("pins external-agent tools to the admin app hydration set", () => {
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("external");
		const apps = filterAggregateAppsForCodeNamespaces(
			[{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }, { slug: "gmail" }],
			new Set(["external"]),
		);
		expect(apps.map((entry) => entry.slug)).toEqual([
			PLATFORM_OPERATOR_ADMIN_APP_SLUG,
		]);
	});

	it("does not include the platform-operator admin app when code calls unrelated namespaces", () => {
		const apps = filterAggregateAppsForCodeNamespaces(
			[{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }, { slug: "gmail" }],
			new Set(["gmail"]),
		);

		// "gmail" matches its own slug; "tedix" does not match (gmail ∉ platform namespaces)
		expect(apps.map((entry) => entry.slug)).toEqual(["gmail"]);
	});

	it("flow.* hydrates its dispatch dependencies the scan cannot see", () => {
		// flow.status({ runId }) names no tedi at all — without this, the lazy
		// hydrator mounts nothing and the flow provider fails with "not
		// mounted".
		const bare = extractCodeModeProviderNamespacesFromCode(
			'async () => await flow.status({ runId: "r1" })',
		);
		expect(bare).toContain("flow");
		expect(bare).toContain("skills");
		expect(bare).toContain("cto");

		// A literal tediSlug hydrates that tedi too, JS-safe form.
		const slugged = extractCodeModeProviderNamespacesFromCode(
			'async () => await flow.run({ source: "...", tediSlug: "acme-tedi" })',
		);
		expect(slugged).toContain("acme_tedi");

		// Non-flow snippets are untouched — no blanket hydration cost.
		const other = extractCodeModeProviderNamespacesFromCode(
			"async () => await memory.search({ query: 'x' })",
		);
		expect(other).not.toContain("skills");
		expect(other).not.toContain("cto");
	});

	it("PLATFORM_OPERATOR_CODE_MODE_NAMESPACES contains the expected endpoint-derived namespaces", () => {
		// Core platform namespaces must be present so the auto-hydration is triggered
		// for the most common tedi Code Mode calls.
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("tedis");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("workflows");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("apps");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("catalog");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("seo");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("os");
		// D1-synced platform-operator namespaces must also trigger lazy hydration.
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("analytics");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("cognitive");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("organizations");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("projects");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("skills");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("work");
		// Peer alias peers must also be present (SEAM C).
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("tedi");
		expect(PLATFORM_OPERATOR_CODE_MODE_NAMESPACES).toContain("app");
	});
});
