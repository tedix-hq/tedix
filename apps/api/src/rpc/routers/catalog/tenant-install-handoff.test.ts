import { describe, expect, it } from "vite-plus/test";
import { tenantConnectionHandoffUrl } from "./tenant-install-handoff";

describe("tenantConnectionHandoffUrl", () => {
	it("lands on the org's own Tedix OS host with the auto-connect param", () => {
		const url = new URL(
			tenantConnectionHandoffUrl({
				environment: "production",
				organizationSlug: "acme",
				providerId: "github",
			}),
		);

		// The hostname carries tenancy; there is no slug path segment and no
		// /login?organization_id wrapper — an unauthenticated visit routes
		// through the session broker and returns here.
		expect(url.origin).toBe("https://acme.os.tedix.dev");
		expect(url.pathname).toBe("/admin/connections");
		expect(url.searchParams.get("connect")).toBe("github");
		expect(url.searchParams.has("organization_id")).toBe(false);
	});

	it("uses the non-production platform domain outside production", () => {
		expect(
			tenantConnectionHandoffUrl({
				environment: "development",
				organizationSlug: "acme",
				providerId: "github/custom",
			}),
		).toBe(
			"https://acme.os.tedix.tech/admin/connections?connect=github%2Fcustom",
		);
	});
});
