import { describe, expect, it } from "vite-plus/test";
import { authorizeTediCredentialExchange } from "./mcp-credential-policy";

const tedi = {
	id: "tedi-1",
	organizationId: "org-1",
	descopeUserId: "descope-user-1",
};

describe("MCP credential exchange policy", () => {
	it("allows a current tedi identity inside the target organization", () => {
		expect(
			authorizeTediCredentialExchange({
				requestedTediId: "tedi-1",
				authenticatedTediId: "tedi-1",
				authenticatedDescopeUserId: "descope-user-1",
				authenticatedOrganizationId: "org-1",
				targetOrganizationId: "org-1",
				tedi,
			}),
		).toMatchObject({
			ok: true,
			descopeUserId: "descope-user-1",
			organizationId: "org-1",
		});
	});

	it("allows service-binding callers only after resolving the tedi record", () => {
		expect(
			authorizeTediCredentialExchange({
				requestedTediId: "tedi-1",
				targetOrganizationId: "org-1",
				tedi,
			}),
		).toMatchObject({ ok: true });
	});

	it("denies stale or cross-tenant target organizations", () => {
		expect(
			authorizeTediCredentialExchange({
				requestedTediId: "tedi-1",
				targetOrganizationId: "org-2",
				tedi,
			}),
		).toEqual({ ok: false, reason: "target_org_mismatch" });
	});

	it("denies a JWT that does not belong to the requested tedi", () => {
		expect(
			authorizeTediCredentialExchange({
				requestedTediId: "tedi-1",
				authenticatedTediId: "tedi-2",
				authenticatedDescopeUserId: "descope-user-1",
				tedi,
			}),
		).toEqual({ ok: false, reason: "authenticated_tedi_mismatch" });
	});
});
