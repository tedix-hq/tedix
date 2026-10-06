/**
 * `generateScopeManifest` must describe the scopes the MCP edge enforces.
 *
 * It used to map every tool through `toolToScope`, which is only the resolver's
 * `enforcePolicies: true` branch — so a coarse-mode app's manifest named scopes
 * nothing ever demanded, while the scopes the edge DOES demand went unlisted.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	collectAdvertisedScopes,
	collectDescopeResourceScopes,
	generateScopeManifest,
} from "./scope-sync";

const BASE = {
	serverUrl: "https://acme.mcp.tedix.dev",
	descopeResourceId: "res-1",
};

describe("generateScopeManifest", () => {
	it("registers platform scopes on the Descope Resource beside tool scopes", () => {
		const scopes = collectDescopeResourceScopes({
			mcpConfig: {
				toolScopes: { apps: ["mcp:apps.read"] },
				scopeDescriptions: {
					"mcp:apps.read": "Manage apps",
					"connections.execute": "Read connected provider tokens",
				},
			},
		});

		expect(scopes).toContainEqual({
			name: "mcp:apps.read",
			description: "Manage apps",
		});
		expect(scopes).toContainEqual({
			name: "connections.execute",
			description: "Read connected provider tokens",
		});
		expect(scopes.map((scope) => scope.name)).toEqual(
			expect.arrayContaining(["connections.execute", "profile", "email"]),
		);
	});

	it("keeps the declared granular Resource scope catalog", () => {
		expect(
			collectAdvertisedScopes({
				mcpConfig: {
					toolScopes: { apps: ["mcp:apps.read"] },
					scopeDescriptions: {
						"mcp:apps.read": "View apps",
						"mcp:apps.write": "Change apps",
					},
				},
			}),
		).toEqual([
			{ name: "mcp:apps.read", description: "View apps" },
			{ name: "mcp:apps.write", description: "Change apps" },
		]);
	});

	it("uses the app's toolScopes override instead of the per-tool policy scope", () => {
		const manifest = generateScopeManifest({
			...BASE,
			tools: [{ name: "list_invoices" }],
			mcpConfig: { toolScopes: { list_invoices: ["mcp:content.write"] } },
		});

		// A configured LEGACY parent scope is granularized to the tool's access
		// level (`list_*` → read) — the same rewrite the edge resolver applies
		// since the legacy capability parents were retired.
		expect(manifest.toolScopes.map((entry) => entry.scope)).toEqual([
			"mcp:content.write",
		]);
		expect(manifest.complete).toBe(true);
		expect(manifest.unclassifiedTools).toEqual([]);
	});

	it("returns an explicit incomplete manifest when a configured tool has no edge mapping", () => {
		const manifest = generateScopeManifest({
			...BASE,
			tools: [
				{
					name: "list_posts",
					toolTypeId: "rpc",
					config: { endpoint: "content/listPosts" },
					authRequired: true,
				},
				{
					name: "resolve_mcp_credentials",
					toolTypeId: "rpc",
					config: { endpoint: "mcpCredentials/resolve" },
					authRequired: true,
				},
			],
		});

		expect(manifest.complete).toBe(false);
		expect(manifest.unclassifiedTools).toEqual(["resolve_mcp_credentials"]);
		expect(manifest.toolScopes.map((entry) => entry.toolName)).toEqual([
			"list_posts",
		]);
	});

	it("keeps per-tool policy scopes when the app enforces policies", () => {
		const manifest = generateScopeManifest({
			...BASE,
			tools: [{ name: "list_invoices" }],
			mcpConfig: { enforcePolicies: true },
		});

		expect(manifest.toolScopes.map((entry) => entry.scope)).toEqual([
			"mcp:list.invoices",
		]);
	});

	it("promotes a declared-destructive tool to its domain admin scope", () => {
		const manifest = generateScopeManifest({
			...BASE,
			tools: [
				// Reads as ordinary content work by name; only the declared
				// capability marks it destructive.
				{
					name: "sync_ledger",
					toolTypeId: "rpc",
					config: { endpoint: "content/syncLedger" },
					writeCapability: "destructive",
				},
				// The `app` namespace has a fallback scope, so a safe public tool in
				// a no-config app is enforced at nothing — and contributes nothing
				// for an operator to configure.
				{
					name: "app_create",
					toolTypeId: "rpc",
					config: { endpoint: "app/create" },
				},
			],
		});

		expect(manifest.toolScopes).toEqual([
			{
				scope: "mcp:content.admin",
				description: "Access to sync_ledger",
				toolName: "sync_ledger",
				requiresConsent: true,
			},
		]);
	});

	it("emits one entry per scope when a tool is pinned to several", () => {
		const manifest = generateScopeManifest({
			...BASE,
			tools: [{ name: "list_invoices" }],
			mcpConfig: {
				toolScopes: {
					list_invoices: ["mcp:content.write", "mcp:observe.read"],
				},
			},
		});

		expect(
			manifest.toolScopes.map((entry) => [entry.toolName, entry.scope]),
		).toEqual([
			["list_invoices", "mcp:content.write"],
			["list_invoices", "mcp:observe.read"],
		]);
	});
});
