import { beforeEach, expect, it, vi } from "vite-plus/test";
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
const claims = vi.hoisted(() => ({
	listUnclaimedCmsCustomDomains: vi.fn(),
	reserveCmsDomainClaim: vi.fn(),
	adoptLegacyCmsDomainClaim: vi.fn(),
}));
vi.mock("@tedix/db/queries/cms-domain-claims", () => claims);
const hostnames = vi.hoisted(() => ({
	createCmsDomainVerificationToken: () => "token",
	findCmsCustomHostname: vi.fn(),
	isCmsCustomHostnameReady: (hostname: { status: string }) =>
		hostname.status === "active",
}));
vi.mock("../services/cms-custom-hostnames", () => hostnames);
beforeEach(() => {
	vi.clearAllMocks();
});
it("reconciles sites from the existing maintenance path", async () => {
	const env = {} as CloudflareEnv;
	await expect(runSiteReconciliationTick(env)).resolves.toEqual({
		organizations: 1,
		sites: 3,
		findings: 0,
		domainsAdopted: 0,
		domainsUnclaimed: 0,
	});
});
it("adopts a routed custom domain that a ready hostname already serves", async () => {
	claims.listUnclaimedCmsCustomDomains.mockResolvedValue([
		{ siteId: "site-a", organizationId: "org-a", hostname: "blog.example.com" },
		{ siteId: "site-b", organizationId: "org-b", hostname: "example.org" },
	]);
	hostnames.findCmsCustomHostname.mockImplementation(async (_env, hostname) =>
		hostname === "blog.example.com"
			? { id: "provider-a", hostname, status: "active" }
			: null,
	);
	claims.reserveCmsDomainClaim.mockImplementation(async (_db, input) => input);
	claims.adoptLegacyCmsDomainClaim.mockImplementation(async (_db, input) => ({
		...input,
		status: "active",
	}));
	const env = {
		CF_CMS_SAAS_ZONE_ID: "zone",
		CF_CMS_HOSTNAMES_TOKEN: "token",
	} as CloudflareEnv;
	await expect(runSiteReconciliationTick(env)).resolves.toMatchObject({
		domainsAdopted: 1,
		domainsUnclaimed: 1,
	});
	expect(claims.reserveCmsDomainClaim).toHaveBeenCalledTimes(1);
	expect(claims.adoptLegacyCmsDomainClaim).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			organizationId: "org-a",
			siteId: "site-a",
			providerHostnameId: "provider-a",
		}),
	);
});
