import { describe, expect, it } from "vite-plus/test";
import { hasPlatformMcpScope, resolveRpcOrganizationId } from "./handler";

describe("hasPlatformMcpScope", () => {
	it("permits explicit cross-tenant targets only for a verified platform scope", () => {
		expect(hasPlatformMcpScope({ scopes: ["platform:admin"] })).toBe(true);
		expect(hasPlatformMcpScope({ scopes: ["*"] })).toBe(true);
		expect(hasPlatformMcpScope({ scopes: ["mcp:settings.admin"] })).toBe(false);
		expect(hasPlatformMcpScope(undefined)).toBe(false);
	});

	it("forwards an explicit tenant target only for a platform caller", () => {
		const targetOrganizationId = "acme-org";
		expect(
			resolveRpcOrganizationId(
				{ organizationId: "tedix-org", scopes: ["platform:admin"] },
				"served-org",
				{ organizationId: targetOrganizationId },
			),
		).toBe(targetOrganizationId);
		expect(
			resolveRpcOrganizationId(
				{ organizationId: "tedix-org", scopes: ["mcp:settings"] },
				"served-org",
				{ organizationId: targetOrganizationId },
			),
		).toBe("tedix-org");
	});
});
