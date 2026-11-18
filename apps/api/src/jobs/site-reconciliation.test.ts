import { beforeEach, expect, it, vi } from "vite-plus/test";
import { runSiteReconciliationTick } from "./site-reconciliation";
import { runCmsThemeReleaseMigrationTick } from "./cms-theme-release-migration";

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
vi.mock("./cms-theme-release-migration", () => ({
	runCmsThemeReleaseMigrationTick: vi.fn(),
}));
beforeEach(() => {
	vi.clearAllMocks();
});
it("runs migration from the existing maintenance path", async () => {
	vi.mocked(runCmsThemeReleaseMigrationTick).mockResolvedValue({
		checked: 2,
		present: 1,
		running: 1,
		failed: 0,
	});
	const env = {} as CloudflareEnv;
	await expect(runSiteReconciliationTick(env)).resolves.toEqual({
		organizations: 1,
		sites: 3,
		findings: 0,
		checked: 2,
		present: 1,
		running: 1,
		failed: 0,
	});
	expect(runCmsThemeReleaseMigrationTick).toHaveBeenCalledWith(env);
});
it("fails the maintenance receipt when a site migration failed", async () => {
	vi.mocked(runCmsThemeReleaseMigrationTick).mockResolvedValue({
		checked: 2,
		present: 1,
		running: 0,
		failed: 1,
	});
	await expect(runSiteReconciliationTick({} as CloudflareEnv)).rejects.toThrow(
		"CMS theme release migration failed",
	);
});
