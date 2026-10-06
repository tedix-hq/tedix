import { describe, expect, it } from "vite-plus/test";
import { resolveMcpToolRequiredScopes } from "./tool-scopes";

const tenantAggregateConfig = {
	enforcePolicies: false,
	authMode: "authenticated",
	toolScopes: { tedis: ["mcp:tedis.read"] },
};

function resolve(
	toolId: string,
	annotations: { readOnlyHint?: boolean; destructiveHint?: boolean },
): string[] {
	return resolveMcpToolRequiredScopes(
		{
			toolId: `tedix__${toolId}`,
			authRequired: false,
			visibility: "public",
			annotations,
		},
		"billing",
		tenantAggregateConfig,
		{ fallbackOnAuthenticatedAuthMode: true },
	);
}

describe("provider capacity sponsorship scope resolution", () => {
	it("lets a tenant inspect its own funding without platform authority", () => {
		expect(resolve("get_billing_overview", { readOnlyHint: true })).toEqual([
			"mcp:settings.read",
		]);
	});
	it("keeps own-org sponsorship reads and writes off platform authority", () => {
		expect(
			resolve("list_provider_capacity_sponsorships", { readOnlyHint: true }),
		).toEqual(["mcp:settings.read"]);
		expect(
			resolve("set_provider_capacity_sponsorship", {
				readOnlyHint: false,
				destructiveHint: false,
			}),
		).toEqual(["mcp:settings.write"]);
	});

	it("keeps unrelated billing tools on the platform-admin fallback", () => {
		expect(
			resolve("grant_inference_capacity", { readOnlyHint: false }),
		).toEqual(["platform:admin"]);
	});
});
