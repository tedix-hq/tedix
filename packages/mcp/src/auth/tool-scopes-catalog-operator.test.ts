/**
 * Verb-first catalog operator tools (`list_catalog_apps`, `trigger_catalog_sync`)
 * miss the `catalog_` prefix rule. Without an exact rule they hit the
 * unclassified-tool error and fail closed for every caller, platform admins
 * included. The API keeps requireCatalogOperatorAccess on catalog mutations.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

const config = { enforcePolicies: false, authMode: "authenticated" };

function resolve(
	name: string,
	endpoint: string,
	annotations: Record<string, boolean> = {},
): string[] {
	return resolveMcpToolRequiredScopes(
		{
			toolId: `tedix_unified__${name}`,
			toolTypeId: "rpc",
			authRequired: true,
			config: { endpoint },
			annotations,
		},
		"tedix_unified",
		config,
		{ fallbackOnAuthenticatedAuthMode: true },
	);
}

describe("catalog operator scope resolution", () => {
	it("maps reads to catalog read", () => {
		for (const [name, endpoint] of [
			["list_catalog_apps", "catalog/list"],
			["get_catalog_app", "catalog/getBySlug"],
			["get_catalog_sync_logs", "catalog/getSyncLogs"],
			["get_catalog_stats", "catalog/getStats"],
		] as const) {
			expect(resolve(name, endpoint, { readOnlyHint: true })).toEqual([
				"mcp:catalog.read",
			]);
		}
	});

	it("keeps mutations above read", () => {
		expect(resolve("trigger_catalog_sync", "catalog/triggerSync")).toEqual([
			"mcp:catalog.write",
		]);
		expect(
			resolve("delete_catalog_app", "catalog/deleteApp", {
				destructiveHint: true,
			}),
		).toEqual(["mcp:catalog.admin"]);
		expect(
			resolve("install_catalog_app", "catalog/installFromCatalog"),
		).toEqual(["mcp:apps.write"]);
	});

	it("hides catalog reads from callers without the catalog grant", () => {
		const tool = {
			toolId: "tedix_unified__list_catalog_apps",
			toolTypeId: "rpc",
			authRequired: true,
			config: { endpoint: "catalog/list" },
			annotations: { readOnlyHint: true },
		};
		for (const [scope, allowed] of [
			["mcp:catalog.read", true],
			["mcp:apps.read", false],
			["mcp:observe.read", false],
		] as const) {
			expect(
				isMcpToolVisibleToCaller(tool, "tedix_unified", config, {
					authType: "oauth",
					scopes: [scope],
				}),
			).toBe(allowed);
		}
	});

	it("still fails closed for unknown catalog-shaped names", () => {
		expect(() =>
			resolve("list_catalog_apps_unreviewed", "catalog/list"),
		).toThrow(/Missing MCP capability mapping/);
	});

	it("maps verb-first skills-router tools to their reviewed tiers", () => {
		for (const [name, endpoint, annotations, scope] of [
			["get_skills", "skills/get", { readOnlyHint: true }, "mcp:skills.read"],
			["usage_skills", "skills/usage", {}, "mcp:skills.read"],
			["improve_skills", "skills/improve", {}, "mcp:skills.write"],
			["move_skills", "skills/move", {}, "mcp:skills.write"],
			["apply_workshop", "skills/applyWorkshop", {}, "mcp:skills.write"],
			["promote_skills", "skills/promote", {}, "mcp:skills.admin"],
			[
				"quarantine_workshop",
				"skills/quarantineWorkshop",
				{},
				"mcp:skills.admin",
			],
			["merge_catalog_apps", "catalog/mergeApps", {}, "mcp:catalog.admin"],
		] as const) {
			expect(resolve(name, endpoint, annotations)).toEqual([scope]);
		}
	});
});
