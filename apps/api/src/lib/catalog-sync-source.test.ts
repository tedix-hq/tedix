import { describe, expect, it, vi } from "vite-plus/test";
import { CatalogMaintenancePolicySchema } from "@tedix/api-contract/schemas/catalog-maintenance-policy";
import { getActiveSystemPolicyDefinition } from "@tedix/db/queries/control-plane/system-policy";
import {
	isSupportedCatalogR2Path,
	loadCatalogMaintenancePolicy,
} from "./catalog-sync-source";
vi.mock("@tedix/db/queries/control-plane/system-policy", () => ({
	getActiveSystemPolicyDefinition: vi.fn(),
}));
const policy = {
	version: 1 as const,
	frequentProviderSlugs: ["example"],
	sources: [
		{
			source: "claude" as const,
			adapter: "claude-registry" as const,
			endpoint: "https://registry.example/servers",
			r2Prefix: "catalog/approved",
		},
	],
};
describe("published catalog source policy", () => {
	it("admits the configured namespace without accepting old or adjacent prefixes", () => {
		expect(isSupportedCatalogR2Path("catalog/approved", policy)).toBe(true);
		expect(
			isSupportedCatalogR2Path(
				"catalog/approved/registry_servers.json",
				policy,
			),
		).toBe(true);
		for (const path of [
			"catalog/claude/registry_servers.json",
			"catalog/approved-old/apps.json",
			"catalog/approved/../other/servers.json",
		])
			expect(isSupportedCatalogR2Path(path, policy)).toBe(false);
	});
	it("fails closed without a published policy and validates the configured source", async () => {
		vi.mocked(getActiveSystemPolicyDefinition).mockResolvedValue(null);
		await expect(loadCatalogMaintenancePolicy({} as never)).rejects.toThrow(
			"not configured",
		);
		vi.mocked(getActiveSystemPolicyDefinition).mockResolvedValue({
			catalogPolicy: policy,
		});
		expect(await loadCatalogMaintenancePolicy({} as never)).toEqual(policy);
		expect(() =>
			CatalogMaintenancePolicySchema.parse({
				...policy,
				sources: [
					{ ...policy.sources[0], endpoint: "http://registry.example/servers" },
				],
			}),
		).toThrow();
		expect(() =>
			CatalogMaintenancePolicySchema.parse({
				...policy,
				sources: [{ ...policy.sources[0], r2Prefix: "catalog/../escape" }],
			}),
		).toThrow();
	});
});
