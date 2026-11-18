import { expect, it, vi } from "vite-plus/test";
import { runSiteReconciliationTick } from "./site-reconciliation";

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/site-reconciliation", () => ({
	listSiteReconciliationOrganizations: async () => [{ id: "org-one" }],
}));
vi.mock("../services/site-reconciliation", () => ({
	reconcileOrganizationSites: async () => ({ sitesChecked: 3, issues: [] }),
}));
vi.mock("../services/cms-media-resources", () => ({
	inspectCmsMediaResource: vi.fn(),
}));
it("reconciles sites from the existing maintenance path", async () => {
	const env = {} as CloudflareEnv;
	await expect(runSiteReconciliationTick(env)).resolves.toEqual({
		organizations: 1,
		sites: 3,
		findings: 0,
	});
});
