/**
 * Reviewed RPC endpoints resolve inside aggregate namespaces (`tedix_unified`)
 * instead of failing closed, while unreviewed endpoints still fail closed.
 */

import { describe, expect, it } from "vite-plus/test";
import { REVIEWED_RPC_ENDPOINT_SCOPES } from "./reviewed-rpc-endpoint-scopes";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

const VALID =
	/^(platform:admin|mcp:(tedis|apps|memory|skills|content|catalog|observe|messaging|settings|work)\.(read|write|admin))$/;

function resolve(
	endpoint: string,
	annotations: Record<string, boolean> = { readOnlyHint: true },
): string[] {
	return resolveMcpToolRequiredScopes(
		{
			toolId: "tedix_unified__reviewed_tool",
			toolTypeId: "rpc",
			authRequired: true,
			config: { endpoint },
			annotations,
		},
		"tedix_unified",
		{ enforcePolicies: false, authMode: "authenticated" },
		{ fallbackOnAuthenticatedAuthMode: true },
	);
}

describe("reviewed RPC endpoint scopes", () => {
	it("holds only valid tiered scopes", () => {
		for (const scope of Object.values(REVIEWED_RPC_ENDPOINT_SCOPES)) {
			expect(scope).toMatch(VALID);
		}
	});

	it("resolves every reviewed endpoint in the aggregate namespace", () => {
		for (const [endpoint, scope] of Object.entries(
			REVIEWED_RPC_ENDPOINT_SCOPES,
		)) {
			expect(resolve(endpoint)).toEqual([scope]);
		}
	});

	it("keeps service-only and platform endpoints on platform authority", () => {
		for (const endpoint of [
			"tediApprovals/create",
			"kernelRuntime/proposeRepoCommit",
			"tedis/authorizeOsPortableCall",
			"tediEmail/provisionAddress",
			"organizations/cancel",
			"billing/grantCredit",
			// Decrypted secret reads.
			"secrets/get",
			"appSecrets/get",
		]) {
			expect(resolve(endpoint, {})).toEqual(["platform:admin"]);
		}
	});

	it("keeps tenant mailbox self-serve on the messaging family", () => {
		expect(resolve("tediEmail/listAddresses")).toEqual(["mcp:messaging.read"]);
		for (const endpoint of [
			"tediEmail/createAddress",
			"tediEmail/updateAddress",
		]) {
			expect(resolve(endpoint, { readOnlyHint: false })).toEqual([
				"mcp:messaging.write",
			]);
		}
	});

	it("locks decrypted secret reads to platform admins in every namespace", () => {
		for (const [toolId, endpoint, namespace] of [
			["get_secrets", "secrets/get", "secrets"],
			["get_app_secrets", "appSecrets/get", "app"],
			["tedix_unified__get_secrets", "secrets/get", "tedix_unified"],
		] as const) {
			expect(
				resolveMcpToolRequiredScopes(
					{
						toolId,
						toolTypeId: "rpc",
						authRequired: true,
						config: { endpoint },
						annotations: { readOnlyHint: true },
					},
					namespace,
					{ enforcePolicies: false, authMode: "authenticated" },
					{ fallbackOnAuthenticatedAuthMode: true },
				),
			).toEqual(["platform:admin"]);
		}
	});

	it("raises destructive calls to the admin tier", () => {
		expect(resolve("tedis/list")).toEqual(["mcp:tedis.read"]);
		expect(resolve("tedis/delete", { destructiveHint: true })).toEqual([
			"mcp:tedis.admin",
		]);
	});

	it("shows a reviewed read only to callers holding its family", () => {
		const tool = {
			toolId: "tedix_unified__list_tedis",
			toolTypeId: "rpc",
			authRequired: true,
			config: { endpoint: "tedis/list" },
			annotations: { readOnlyHint: true },
		};
		for (const [scope, allowed] of [
			["mcp:tedis.read", true],
			["mcp:apps.read", false],
		] as const) {
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"tedix_unified",
					{},
					{
						authType: "oauth",
						scopes: [scope],
					},
				),
			).toBe(allowed);
		}
	});

	it("still fails closed for unreviewed endpoints", () => {
		expect(() => resolve("tedis/unreviewedOperation")).toThrow(
			/Missing MCP capability mapping/,
		);
	});
});
