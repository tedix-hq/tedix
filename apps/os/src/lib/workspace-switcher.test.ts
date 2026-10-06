import { describe, expect, it } from "vite-plus/test";
import type { DirectoryWorkspaceRecord } from "@tedix/api-contract/contracts/directory";
import {
	buildSurfaceSwitchUrl,
	selectActiveWorkspace,
} from "./workspace-switcher";

function workspace(
	id: string,
	slug: string,
	tenantId: string | null,
): DirectoryWorkspaceRecord {
	return {
		org: {
			descopeTenantId: tenantId,
			name: slug,
			organizationId: id,
			provisionComplete: tenantId !== null,
			slug,
		},
		surfaces: [
			{
				canonicalUrl: `https://${slug}.os.tedix.dev/`,
				handoffUrl: tenantId
					? `https://${slug}.os.tedix.dev/auth/session-broker/start?tenant_id=${tenantId}&redirect_to=%2F`
					: null,
				provisioned: tenantId !== null,
				surface: "os",
			},
			{
				canonicalUrl: `https://${slug}.cms.tedix.dev/_emdash/admin`,
				handoffUrl: tenantId
					? `https://${slug}.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=${tenantId}&redirect_to=%2F_emdash%2Fadmin`
					: null,
				provisioned: tenantId !== null,
				surface: "cms",
			},
		],
	};
}

describe("workspace switcher", () => {
	it("derives one active workspace without local-storage authority", () => {
		const records = [
			workspace("1", "acme", "T-acme"),
			workspace("2", "beta", "T-beta"),
		];
		expect(
			selectActiveWorkspace(records, { slug: "beta" })?.org.organizationId,
		).toBe("2");
		expect(
			selectActiveWorkspace(records, { tenantId: "T-acme" })?.org.slug,
		).toBe("acme");
	});

	it("brokers OS and CMS destinations so stale product cookies cannot change identity", () => {
		expect(
			buildSurfaceSwitchUrl({
				surface: "os",
				workspace: workspace("1", "acme", "T-acme"),
			}),
		).toBe(
			"https://acme.os.tedix.dev/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
		);
		expect(
			buildSurfaceSwitchUrl({
				surface: "cms",
				workspace: workspace("1", "acme", "T-acme"),
			}),
		).toBe(
			"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F_emdash%2Fadmin",
		);
	});

	it("disables incomplete organizations", () => {
		expect(
			buildSurfaceSwitchUrl({
				surface: "os",
				workspace: workspace("1", "acme", null),
			}),
		).toBeNull();
	});
});
