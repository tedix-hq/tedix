import { describe, expect, it } from "vite-plus/test";
import { matchesTenantPolicyCredential } from "./tenant-policy-credential";

const tenant = {
	organizationId: "org",
	providerId: "provider",
	scope: "tenant",
	connectionInstanceId: "00000000-0000-4000-8000-000000000001",
	accountRevisionDigest: "a".repeat(64),
};
const revision = "a".repeat(64);

describe("tenant policy credential identity", () => {
	it("requires the same verified organization, provider, scope and named account", () => {
		expect(matchesTenantPolicyCredential(tenant, tenant, revision)).toBe(true);
		expect(
			matchesTenantPolicyCredential(
				tenant,
				{ ...tenant, accountRevisionDigest: "b".repeat(64) },
				revision,
			),
		).toBe(false);
		expect(matchesTenantPolicyCredential(tenant, tenant, "")).toBe(false);
		for (const changed of [
			{ ...tenant, organizationId: "other" },
			{ ...tenant, providerId: "other" },
			{
				...tenant,
				connectionInstanceId: "00000000-0000-4000-8000-000000000002",
			},
			{ organizationId: "org", providerId: "provider", scope: "tenant" },
		]) {
			expect(matchesTenantPolicyCredential(tenant, changed, revision)).toBe(
				false,
			);
		}
	});

	it("also binds a personal account to its verified owner", () => {
		const personal = { ...tenant, scope: "user", userId: "one" };
		expect(matchesTenantPolicyCredential(personal, personal, revision)).toBe(
			true,
		);
		expect(
			matchesTenantPolicyCredential(
				personal,
				{ ...personal, userId: "two" },
				revision,
			),
		).toBe(false);
		expect(matchesTenantPolicyCredential(personal, tenant, revision)).toBe(
			false,
		);
	});
});
