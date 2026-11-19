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

describe("own-organization billing scope resolution", () => {
	it("lets a tenant inspect its own funding without platform authority", () => {
		expect(resolve("get_billing_overview", { readOnlyHint: true })).toEqual([
			"mcp:settings.read",
		]);
	});
	it("keeps own-org credit caps and pay-as-you-go off platform authority", () => {
		expect(resolve("list_top_up_packs", { readOnlyHint: true })).toEqual([
			"mcp:settings.read",
		]);
		for (const tool of ["set_credit_caps", "set_pay_as_you_go"])
			expect(
				resolve(tool, { readOnlyHint: false, destructiveHint: false }),
			).toEqual(["mcp:settings.write"]);
	});

	it("keeps credit grants and overrides on the platform-admin fallback", () => {
		for (const tool of ["grant_top_up_credits", "set_account_credits"])
			expect(resolve(tool, { readOnlyHint: false })).toEqual([
				"platform:admin",
			]);
	});
	it("permits only the reviewed own-org spending read without platform authority", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					toolId: "tedix_unified__get_inference_spending",
					toolTypeId: "rpc",
					authRequired: true,
					config: { endpoint: "billing/getInferenceSpending" },
					annotations: { readOnlyHint: true },
				},
				"tedix_unified",
				tenantAggregateConfig,
			),
		).toEqual(["mcp:settings.read"]);
	});
	it("requires platform authority for reviewed provider estimates, even with read hints", () => {
		for (const readOnlyHint of [true, false])
			expect(
				resolveMcpToolRequiredScopes(
					{
						toolId: "tedix_unified__record_provider_cost_evidence",
						toolTypeId: "rpc",
						authRequired: true,
						config: { endpoint: "billing/recordProviderCostEvidence" },
						annotations: { readOnlyHint },
					},
					"tedix_unified",
					tenantAggregateConfig,
				),
			).toEqual(["platform:admin"]);
	});
});
