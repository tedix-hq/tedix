import { describe, expect, it, vi } from "vite-plus/test";
import { reconcileOrganizationSites } from "./site-reconciliation";

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	listCmsSitesByOrganization: vi.fn(),
	listDocsSites: vi.fn(),
	getAppsByOrganization: vi.fn(),
	getTenantBundleSummary: vi.fn(),
	recordSiteReconciliation: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
}));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	listCmsSitesByOrganization: mocks.listCmsSitesByOrganization,
}));
vi.mock("@tedix/db/queries/docs-sites/sites", () => ({
	listDocsSites: mocks.listDocsSites,
}));
vi.mock("@tedix/db/queries/docs-sites/builds", () => ({
	listDocsBuilds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: mocks.getAppsByOrganization,
}));
vi.mock("@tedix/db/queries/tenant-bundles", () => ({
	getTenantBundleSummary: mocks.getTenantBundleSummary,
}));
vi.mock("@tedix/db/queries/site-reconciliation", () => ({
	recordSiteReconciliation: mocks.recordSiteReconciliation,
}));

describe("site reconciliation media resources", () => {
	it("records a missing CMS media bucket as an error", async () => {
		mocks.getOrganizationById.mockResolvedValue({ id: "org-1", slug: "acme" });
		mocks.listCmsSitesByOrganization.mockResolvedValue([
			{
				id: "11111111-1111-4111-8111-111111111111",
				slug: "acme",
				authoringAppId: "app-1",
				canonicalUrl: "https://acme.cms.tedix.dev",
			},
		]);
		mocks.listDocsSites.mockResolvedValue([]);
		mocks.getAppsByOrganization.mockResolvedValue([{ id: "app-1" }]);
		mocks.getTenantBundleSummary.mockResolvedValue({ activeVersion: 1 });

		const result = await reconcileOrganizationSites({
			db: {} as never,
			organizationId: "org-1",
			source: "manual",
			inspectCmsMedia: async () => "missing",
		});

		expect(result?.issues).toContainEqual(
			expect.objectContaining({
				code: "missing_media_bucket",
				severity: "error",
			}),
		);
		expect(mocks.recordSiteReconciliation).toHaveBeenCalledOnce();
	});
});
