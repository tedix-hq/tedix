import { createRouterClient } from "@orpc/server";
import { CmsDeprovisionReservationConflictError } from "@tedix/db/queries/cms-deprovision-operations";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { sitesContractRouter } from "./sites";

const mocks = vi.hoisted(() => ({
	getCmsSiteByIdForOrganization: vi.fn(),
	getCmsSiteById: vi.fn(),
	loadEditorial: vi.fn(),
	propose: vi.fn(),
	audit: vi.fn(),
	getCmsSiteBySlug: vi.fn(),
	getCmsSiteByHostname: vi.fn(),
	registerCmsSiteIfAbsent: vi.fn(),
	registerCmsSiteWithinQuota: vi.fn(),
	activateCmsSiteAfterMedia: vi.fn(),
	getAppBySlug: vi.fn(),
	createApp: vi.fn(),
	updateCmsSiteDomain: vi.fn(),
	listCmsSitesByOrganization: vi.fn(),
	pauseCmsSiteUnlessRestoring: vi.fn(),
	restoreCmsSiteUnlessDeprovisioning: vi.fn(),
	deleteCmsSite: vi.fn(),
	getDocsSiteById: vi.fn(),
	listDocsSites: vi.fn(),
	listDocsBuilds: vi.fn(),
	getAppsByOrganization: vi.fn(),
	getOrganizationById: vi.fn(),
	getOrganizationFeatures: vi.fn(),
	getTenantBundleSummary: vi.fn(),
	listTenantBundleRecoveryPoints: vi.fn(),
	getLatestSiteReconciliation: vi.fn(),
	reconcileOrganizationSites: vi.fn(),
	getCmsDeprovisionOperationForOrganization: vi.fn(),
	reserveCmsDeprovisionOperation: vi.fn(),
	updateCmsDeprovisionOperation: vi.fn(),
	inspectCmsProviderResources: vi.fn(),
	reserveCmsDomainClaim: vi.fn(),
	getCmsDomainClaimForSite: vi.fn(),
	listCmsDomainClaimsForSite: vi.fn(),
	beginCmsDomainProvisioning: vi.fn(),
	finishCmsDomainProvisioning: vi.fn(),
	adoptLegacyCmsDomainClaim: vi.fn(),
	activateCmsDomainClaim: vi.fn(),
	activateCmsWwwAliasClaim: vi.fn(),
	beginRemovingCmsDomainClaim: vi.fn(),
	beginRemovingReplacedCmsDomainClaim: vi.fn(),
	removeCmsDomainClaim: vi.fn(),
	createCmsCustomHostname: vi.fn(),
	getCmsCustomHostname: vi.fn(),
	findCmsCustomHostname: vi.fn(),
	deleteCmsCustomHostname: vi.fn(),
	verifyCmsDnsChallenge: vi.fn(),
	verifyCmsDnsTarget: vi.fn(),
	verifyCmsDnsZoneApex: vi.fn(),
	startCmsRecoveryCapture: vi.fn(),
	getCmsRecoveryCapture: vi.fn(),
	purgeCmsRecoveryCapture: vi.fn(),
	inspectLatestCmsRecoveryCapture: vi.fn(),
	startCmsSiteRestore: vi.fn(),
	getCmsSiteRestore: vi.fn(),
}));
vi.mock("../../services/cms-recovery-resources", () => ({
	startCmsRecoveryCapture: mocks.startCmsRecoveryCapture,
	getCmsRecoveryCapture: mocks.getCmsRecoveryCapture,
	purgeCmsRecoveryCapture: mocks.purgeCmsRecoveryCapture,
	inspectLatestCmsRecoveryCapture: mocks.inspectLatestCmsRecoveryCapture,
	startCmsSiteRestore: mocks.startCmsSiteRestore,
	getCmsSiteRestore: mocks.getCmsSiteRestore,
}));
vi.mock("@tedix/db/queries/cms-domain-claims", () => ({
	reserveCmsDomainClaim: mocks.reserveCmsDomainClaim,
	getCmsDomainClaimForSite: mocks.getCmsDomainClaimForSite,
	listCmsDomainClaimsForSite: mocks.listCmsDomainClaimsForSite,
	beginCmsDomainProvisioning: mocks.beginCmsDomainProvisioning,
	finishCmsDomainProvisioning: mocks.finishCmsDomainProvisioning,
	adoptLegacyCmsDomainClaim: mocks.adoptLegacyCmsDomainClaim,
	activateCmsDomainClaim: mocks.activateCmsDomainClaim,
	activateCmsWwwAliasClaim: mocks.activateCmsWwwAliasClaim,
	beginRemovingCmsDomainClaim: mocks.beginRemovingCmsDomainClaim,
	beginRemovingReplacedCmsDomainClaim:
		mocks.beginRemovingReplacedCmsDomainClaim,
	removeCmsDomainClaim: mocks.removeCmsDomainClaim,
}));
vi.mock("../../services/cms-custom-hostnames", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../services/cms-custom-hostnames")
	>()),
	createCmsCustomHostname: mocks.createCmsCustomHostname,
	getCmsCustomHostname: mocks.getCmsCustomHostname,
	findCmsCustomHostname: mocks.findCmsCustomHostname,
	deleteCmsCustomHostname: mocks.deleteCmsCustomHostname,
	verifyCmsDnsChallenge: mocks.verifyCmsDnsChallenge,
	verifyCmsDnsTarget: mocks.verifyCmsDnsTarget,
	verifyCmsDnsZoneApex: mocks.verifyCmsDnsZoneApex,
}));
vi.mock(
	"@tedix/db/queries/cms-deprovision-operations",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/cms-deprovision-operations")
		>()),
		getCmsDeprovisionOperationForOrganization:
			mocks.getCmsDeprovisionOperationForOrganization,
		reserveCmsDeprovisionOperation: mocks.reserveCmsDeprovisionOperation,
		updateCmsDeprovisionOperation: mocks.updateCmsDeprovisionOperation,
	}),
);
vi.mock("../../services/cms-provider-resources", () => ({
	inspectCmsProviderResources: mocks.inspectCmsProviderResources,
}));

vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteByIdForOrganization: mocks.getCmsSiteByIdForOrganization,
	getCmsSiteById: mocks.getCmsSiteById,
	getCmsSiteBySlug: mocks.getCmsSiteBySlug,
	getCmsSiteByHostname: mocks.getCmsSiteByHostname,
	registerCmsSiteIfAbsent: mocks.registerCmsSiteIfAbsent,
	registerCmsSiteWithinQuota: mocks.registerCmsSiteWithinQuota,
	activateCmsSiteAfterMedia: mocks.activateCmsSiteAfterMedia,
	updateCmsSiteDomain: mocks.updateCmsSiteDomain,
	listCmsSitesByOrganization: mocks.listCmsSitesByOrganization,
	deleteCmsSite: mocks.deleteCmsSite,
	pauseCmsSiteUnlessRestoring: mocks.pauseCmsSiteUnlessRestoring,
	restoreCmsSiteUnlessDeprovisioning: mocks.restoreCmsSiteUnlessDeprovisioning,
}));
vi.mock("@tedix/db/queries/app-records", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/app-records")>()),
	getAppBySlug: mocks.getAppBySlug,
	createApp: mocks.createApp,
}));
vi.mock("@tedix/db/queries/docs-sites/sites", () => ({
	getDocsSiteById: mocks.getDocsSiteById,
	listDocsSites: mocks.listDocsSites,
	setDocsSiteStatus: vi.fn(),
}));
vi.mock("@tedix/db/queries/docs-sites/builds", () => ({
	listDocsBuilds: mocks.listDocsBuilds,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: mocks.getAppsByOrganization,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
	getOrganizationFeatures: mocks.getOrganizationFeatures,
}));
vi.mock("@tedix/db/queries/tenant-bundles", () => ({
	getTenantBundleSummary: mocks.getTenantBundleSummary,
	listTenantBundleRecoveryPoints: mocks.listTenantBundleRecoveryPoints,
}));
vi.mock("@tedix/db/queries/site-reconciliation", () => ({
	getLatestSiteReconciliation: mocks.getLatestSiteReconciliation,
}));
vi.mock("../../services/site-reconciliation", () => ({
	reconcileOrganizationSites: mocks.reconcileOrganizationSites,
}));

vi.mock("@tedix/auth/descope", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/descope")>()),
	loadUserTenantEditorialIdentity: mocks.loadEditorial,
}));
vi.mock("../../services/cms-editor-proposals", () => ({
	proposeCmsEditorDraft: mocks.propose,
}));

vi.mock("../audit-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../audit-helpers")>()),
	emitAuditEvent: mocks.audit,
}));

const organization = { id: "org-1", slug: "acme" };
const cmsSite = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "org-1",
	slug: "acme",
	name: "Acme",
	description: null,
	status: "active" as const,
	canonicalUrl: "https://www.acme.test",
	customDomain: "www.acme.test",
	publicPathPrefix: null,
	templateSlug: "tedix",
	config: null,
	mcpAppId: null,
	authoringAppId: "22222222-2222-4222-8222-222222222222",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function cmsResourceEnv(exists = true, created = false): CloudflareEnv {
	return {
		CMS: {
			fetch: vi.fn().mockImplementation(async (request: Request) =>
				Response.json({
					success: true,
					bucketName: "tedix-cms-media-acme",
					exists: request.method === "GET" ? exists : true,
					created: request.method === "POST" ? created : undefined,
				}),
			),
		},
		PLATFORM_SERVICE_TOKEN: "test",
		CF_CMS_HOSTNAMES_TOKEN: "scoped-test-token",
		CF_CMS_SAAS_ZONE_ID: "00000000000000000000000000000001",
		CF_CMS_SAAS_TARGET_DOMAIN: "cms.tedix.dev",
	} as unknown as CloudflareEnv;
}

function client(
	platform = false,
	env = cmsResourceEnv(),
	permissions = ["apps:read", "settings:manage"],
	authType: BaseContext["authType"] = "user",
	organizationId: string | null = organization.id,
	machineScopes: string[] = [],
) {
	const context = {
		authType,
		apiKey:
			authType === "apikey"
				? { id: "test-api-key", name: "Machine", scopes: machineScopes }
				: undefined,
		db: {} as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: organizationId ?? undefined,
		url: new URL("https://api.tedix.test/rpc/sites"),
		user: {
			aud: "test",
			dct: "tenant",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			scope: platform ? "platform:admin" : "",
			sub: "owner-1",
		},
	} as BaseContext;
	return createRouterClient(sitesContractRouter, { context });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCmsSiteBySlug.mockReset();
	mocks.getAppBySlug.mockReset();
	mocks.registerCmsSiteIfAbsent.mockReset();
	mocks.registerCmsSiteWithinQuota.mockReset();
	mocks.activateCmsSiteAfterMedia.mockReset();
	mocks.inspectLatestCmsRecoveryCapture.mockResolvedValue({ verified: false });
	mocks.getOrganizationById.mockResolvedValue(organization);
	mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 5 });
	mocks.getCmsSiteBySlug.mockResolvedValue(cmsSite);
	mocks.getAppBySlug.mockResolvedValue(null);
	mocks.getCmsSiteByIdForOrganization.mockResolvedValue(cmsSite);
	mocks.pauseCmsSiteUnlessRestoring.mockResolvedValue(true);
	mocks.restoreCmsSiteUnlessDeprovisioning.mockResolvedValue(true);
	mocks.getDocsSiteById.mockResolvedValue(null);
	mocks.listCmsSitesByOrganization.mockResolvedValue([cmsSite]);
	mocks.listDocsSites.mockResolvedValue([]);
	mocks.getAppsByOrganization.mockResolvedValue([
		{ id: cmsSite.authoringAppId, slug: "cms-acme" },
	]);
	mocks.getTenantBundleSummary.mockResolvedValue({
		activeVersion: 7,
		lastDeployedAt: "2026-01-02T00:00:00.000Z",
	});
	mocks.listTenantBundleRecoveryPoints.mockResolvedValue([
		{
			version: 7,
			deployedAt: "2026-01-02T00:00:00.000Z",
			active: true,
		},
	]);
	mocks.getLatestSiteReconciliation.mockResolvedValue(null);
	mocks.getCmsDeprovisionOperationForOrganization.mockResolvedValue(null);
	mocks.inspectCmsProviderResources.mockResolvedValue({
		durableObject: { identifier: `EmDashDB:${cmsSite.slug}`, state: "present" },
	});
	mocks.reconcileOrganizationSites.mockResolvedValue({
		runId: "33333333-3333-4333-8333-333333333333",
		source: "manual",
		checkedAt: "2026-01-03T00:00:00.000Z",
		sitesChecked: 1,
		issues: [],
	});
});

describe("site lifecycle confirmation", () => {
	it("does not claim provider resources are present from a retained site record", async () => {
		mocks.inspectCmsProviderResources.mockResolvedValue({
			durableObject: {
				identifier: `EmDashDB:${cmsSite.slug}`,
				state: "unknown",
			},
		});
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			status: "paused",
		});
		mocks.getAppsByOrganization.mockResolvedValue([]);
		const plan = await client().getDeprovisionPlan({ siteId: cmsSite.id });
		expect(plan.dependencies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "durable_object", status: "unknown" }),
			]),
		);
	});

	it("lets an authorized owner archive without step-up after exact slug confirmation", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			authoringAppId: null,
		});
		await expect(
			client().setLifecycle({
				siteId: cmsSite.id,
				action: "archive",
				confirmation: cmsSite.slug,
			}),
		).resolves.toMatchObject({ status: "paused", slug: cmsSite.slug });
		expect(mocks.pauseCmsSiteUnlessRestoring).toHaveBeenCalledWith(
			expect.anything(),
			{
				id: cmsSite.id,
				organizationId: organization.id,
				authoringAppId: null,
			},
		);
	});

	it("rejects archive when a restore closes the site before the conditional pause", async () => {
		mocks.pauseCmsSiteUnlessRestoring.mockResolvedValue(false);
		await expect(
			client().setLifecycle({
				siteId: cmsSite.id,
				action: "archive",
				confirmation: cmsSite.slug,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects unarchive while a restore fence remains closed", async () => {
		mocks.restoreCmsSiteUnlessDeprovisioning.mockResolvedValue(false);
		await expect(
			client().setLifecycle({
				siteId: cmsSite.id,
				action: "restore",
				confirmation: cmsSite.slug,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects a wrong slug and a site outside the owner's organization", async () => {
		await expect(
			client().setLifecycle({
				siteId: cmsSite.id,
				action: "archive",
				confirmation: "other",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		mocks.getCmsSiteByIdForOrganization.mockResolvedValueOnce(null);
		await expect(
			client().setLifecycle({
				siteId: cmsSite.id,
				action: "archive",
				confirmation: cmsSite.slug,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.pauseCmsSiteUnlessRestoring).not.toHaveBeenCalled();
	});

	it("lets an authorized owner deprovision without step-up only after exact slug confirmation", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			authoringAppId: null,
		});
		mocks.getAppsByOrganization.mockResolvedValue([]);
		const create = vi.fn().mockResolvedValue({ id: cmsSite.id });
		const get = vi.fn().mockRejectedValue(new Error("not found"));
		const env = {
			CMS_DEPROVISION_WORKFLOW: { create, get },
		} as unknown as CloudflareEnv;
		const receipt = {
			id: cmsSite.id,
			organizationId: organization.id,
			slug: cmsSite.slug,
			authoringAppId: null,
			status: "queued",
			stage: "queued",
			deleted: [],
			errors: [],
		};
		mocks.reserveCmsDeprovisionOperation.mockResolvedValue(receipt);
		await expect(
			client(false, env).deprovision({
				siteId: cmsSite.id,
				confirmation: "wrong",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(create).not.toHaveBeenCalled();
		await expect(
			client(false, env).deprovision({
				siteId: cmsSite.id,
				confirmation: cmsSite.slug,
			}),
		).resolves.toMatchObject({
			status: "queued",
			slug: cmsSite.slug,
			operationId: cmsSite.id,
		});
		expect(create).toHaveBeenCalledOnce();
		expect(mocks.deleteCmsSite).not.toHaveBeenCalled();
	});

	it("reports an atomic reservation conflict without starting cleanup", async () => {
		mocks.reserveCmsDeprovisionOperation.mockRejectedValue(
			new CmsDeprovisionReservationConflictError("restore_fenced"),
		);
		const create = vi.fn();
		const env = {
			CMS_DEPROVISION_WORKFLOW: { create, get: vi.fn() },
		} as unknown as CloudflareEnv;
		await expect(
			client(false, env).deprovision({
				siteId: cmsSite.id,
				confirmation: cmsSite.slug,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(create).not.toHaveBeenCalled();
	});

	it("keeps the final cleanup receipt readable after the site row is deleted", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue(null);
		mocks.getCmsDeprovisionOperationForOrganization.mockResolvedValue({
			id: cmsSite.id,
			organizationId: organization.id,
			slug: cmsSite.slug,
			status: "succeeded",
			stage: "Complete",
			deleted: ["durable_object", "site"],
			errors: [],
		});
		await expect(
			client().getDeprovisionStatus({ siteId: cmsSite.id }),
		).resolves.toMatchObject({
			status: "succeeded",
			deleted: ["durable_object", "site"],
		});
	});

	it("reuses a running cleanup without dispatching a second Workflow", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue(null);
		mocks.getCmsDeprovisionOperationForOrganization.mockResolvedValue({
			id: cmsSite.id,
			organizationId: organization.id,
			slug: cmsSite.slug,
			status: "running",
			stage: "Removing CMS resources",
			deleted: [],
			errors: [],
		});
		const create = vi.fn();
		const env = {
			CMS_DEPROVISION_WORKFLOW: {
				get: vi.fn().mockResolvedValue({
					status: vi.fn().mockResolvedValue({ status: "running" }),
				}),
				create,
			},
		} as unknown as CloudflareEnv;
		await expect(
			client(false, env).deprovision({
				siteId: cmsSite.id,
				confirmation: cmsSite.slug,
			}),
		).resolves.toMatchObject({ status: "running", operationId: cmsSite.id });
		expect(create).not.toHaveBeenCalled();
		expect(mocks.reserveCmsDeprovisionOperation).not.toHaveBeenCalled();
	});
});

describe("site recovery and reconciliation", () => {
	it("requires active owner authority and exact slug confirmation to start a restore", async () => {
		const captureId = "33333333-3333-4333-8333-333333333333";
		const generation = "44444444-4444-4444-8444-444444444444";
		mocks.startCmsSiteRestore.mockResolvedValue({
			siteId: cmsSite.id,
			captureId,
			generation,
			phase: "claimed",
			createdAt: "2026-09-29T00:00:00.000Z",
			updatedAt: "2026-09-29T00:00:00.000Z",
		});
		await expect(
			client().startCmsSiteRestore({
				siteId: cmsSite.id,
				captureId,
				confirmation: "wrong",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.startCmsSiteRestore).not.toHaveBeenCalled();
		const result = await client().startCmsSiteRestore({
			siteId: cmsSite.id,
			captureId,
			confirmation: cmsSite.slug,
			mode: "roundtrip",
		});
		expect(result.generation).toBe(generation);
		expect(mocks.startCmsSiteRestore).toHaveBeenCalledWith(expect.anything(), {
			slug: cmsSite.slug,
			siteId: cmsSite.id,
			captureId,
			mode: "roundtrip",
		});
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			status: "paused",
		});
		await expect(
			client().startCmsSiteRestore({
				siteId: cmsSite.id,
				captureId,
				confirmation: cmsSite.slug,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("accepts only a verified capture in the recovery manifest", async () => {
		mocks.inspectLatestCmsRecoveryCapture.mockResolvedValue({
			verified: true,
			captureId: "33333333-3333-4333-8333-333333333333",
		});
		const manifest = await client().getRecoveryManifest({ siteId: cmsSite.id });
		expect(manifest.recoverable).toBe(false);
		expect(manifest.blockers).toEqual([
			"No tested database and media restore procedure is available",
		]);
	});

	it("requires exact site ownership and confirmation to purge", async () => {
		const captureId = "33333333-3333-4333-8333-333333333333";
		mocks.purgeCmsRecoveryCapture.mockResolvedValue({
			siteId: cmsSite.id,
			captureId,
			status: "purged",
		});
		await expect(
			client().purgeCmsRecoveryCapture({
				siteId: cmsSite.id,
				captureId,
				confirmation: "wrong",
			}),
		).rejects.toThrow();
		expect(mocks.purgeCmsRecoveryCapture).not.toHaveBeenCalled();
		const result = await client().purgeCmsRecoveryCapture({
			siteId: cmsSite.id,
			captureId,
			confirmation: cmsSite.slug,
		});
		expect(result.status).toBe("purged");
		expect(mocks.purgeCmsRecoveryCapture).toHaveBeenCalledWith(
			expect.anything(),
			cmsSite.slug,
			cmsSite.id,
			captureId,
		);
	});
	it("retains owner status and purge after CMS deprovision", async () => {
		const captureId = "33333333-3333-4333-8333-333333333333";
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue(null);
		mocks.getCmsDeprovisionOperationForOrganization.mockResolvedValue({
			id: cmsSite.id,
			organizationId: organization.id,
			slug: cmsSite.slug,
			status: "succeeded",
		});
		mocks.getCmsRecoveryCapture.mockResolvedValue({
			siteId: cmsSite.id,
			captureId,
			status: "verified",
		});
		mocks.purgeCmsRecoveryCapture.mockResolvedValue({
			siteId: cmsSite.id,
			captureId,
			status: "purged",
		});
		const status = await client().getCmsRecoveryCapture({
			siteId: cmsSite.id,
			captureId,
		});
		expect(status.status).toBe("verified");
		const purged = await client().purgeCmsRecoveryCapture({
			siteId: cmsSite.id,
			captureId,
			confirmation: cmsSite.slug,
		});
		expect(purged.status).toBe("purged");
		expect(
			mocks.getCmsDeprovisionOperationForOrganization,
		).toHaveBeenCalledWith(expect.anything(), {
			siteId: cmsSite.id,
			organizationId: organization.id,
		});
	});
	it("does not accept a deprovision receipt from another organization", async () => {
		const captureId = "33333333-3333-4333-8333-333333333333";
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue(null);
		mocks.getCmsDeprovisionOperationForOrganization.mockResolvedValue(null);
		await expect(
			client().getCmsRecoveryCapture({ siteId: cmsSite.id, captureId }),
		).rejects.toThrow();
		expect(mocks.getCmsRecoveryCapture).not.toHaveBeenCalled();
	});
	it("returns an owner-scoped CMS recovery manifest", async () => {
		const manifest = await client().getRecoveryManifest({ siteId: cmsSite.id });
		expect(manifest).toMatchObject({
			siteId: cmsSite.id,
			type: "cms",
			recoverable: false,
			blockers: [
				"No restorable Durable Object database bookmark has been captured",
				"No independently verified media backup has been captured",
			],
			recoveryPoints: [
				{
					id: "7",
					label: "Bundle rollback v7 (content and media unchanged)",
					active: true,
				},
			],
		});
		expect(manifest.resources).toContainEqual(
			expect.objectContaining({
				kind: "media",
				state: "ready",
			}),
		);
		expect(manifest.resources).toContainEqual(
			expect.objectContaining({
				kind: "authoring_proxy",
				state: "ready",
			}),
		);
	});

	it("blocks recovery when provider storage cannot be verified", async () => {
		mocks.inspectCmsProviderResources.mockResolvedValue({
			durableObject: {
				identifier: `EmDashDB:${cmsSite.slug}`,
				state: "unknown",
			},
		});
		const manifest = await client().getRecoveryManifest({ siteId: cmsSite.id });
		expect(manifest.recoverable).toBe(false);
		expect(manifest.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "durable_object", state: "unknown" }),
			]),
		);
	});

	it("blocks recovery when the provider reports a missing media bucket", async () => {
		const manifest = await client(
			false,
			cmsResourceEnv(false),
		).getRecoveryManifest({ siteId: cmsSite.id });
		expect(manifest).toMatchObject({
			recoverable: false,
			blockers: expect.arrayContaining(["Media bucket is missing"]),
		});
		expect(manifest.resources).toContainEqual(
			expect.objectContaining({ kind: "media", state: "missing" }),
		);
	});

	it("reports missing CMS recovery dependencies without mutating them", async () => {
		mocks.getAppsByOrganization.mockResolvedValue([]);
		mocks.getTenantBundleSummary.mockResolvedValue({
			activeVersion: null,
			lastDeployedAt: null,
		});
		mocks.reconcileOrganizationSites.mockResolvedValue({
			runId: "33333333-3333-4333-8333-333333333333",
			source: "manual",
			checkedAt: "2026-01-03T00:00:00.000Z",
			sitesChecked: 1,
			issues: [
				{
					siteId: cmsSite.id,
					slug: cmsSite.slug,
					type: "cms",
					code: "missing_authoring_proxy",
					severity: "error",
					detail: "CMS site has no owned authoring proxy",
				},
			],
		});
		const result = await client().runReconciliation({});
		expect(result.sitesChecked).toBe(1);
		expect(result.issues.map((issue) => issue.code)).toEqual([
			"missing_authoring_proxy",
		]);
	});

	it("lets only a platform administrator idempotently repair CMS media", async () => {
		await expect(
			client().repairCmsMedia({ slug: cmsSite.slug }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const env = cmsResourceEnv(false, true);
		await expect(
			client(true, env).repairCmsMedia({ slug: cmsSite.slug }),
		).resolves.toEqual({
			siteId: cmsSite.id,
			slug: cmsSite.slug,
			bucketName: "tedix-cms-media-acme",
			created: true,
			state: "ready",
		});
		expect(env.CMS.fetch).toHaveBeenCalledWith(
			expect.objectContaining({ method: "POST" }),
		);
		const request = vi.mocked(env.CMS.fetch).mock.calls[0]?.[0] as Request;
		expect(request.headers.get("X-Tedix-CMS-Media-Intent")).toBe("repair");
	});
});

const registration = {
	slug: "acme-marketing",
	name: "Acme Marketing",
	authoringAppId: cmsSite.authoringAppId,
	templateSlug: "marketing" as const,
	customDomain: "landing.acme.test",
};

describe("CMS site registration", () => {
	it("requires a platform principal for binding provisioned resources", async () => {
		await expect(client().registerCms(registration)).rejects.toThrow(
			/Platform administrator/,
		);
		expect(mocks.registerCmsSiteIfAbsent).not.toHaveBeenCalled();
	});
	it("rejects an authoring app that targets a different site", async () => {
		await expect(client(true).registerCms(registration)).rejects.toThrow(
			/Authoring app/,
		);
		expect(mocks.registerCmsSiteIfAbsent).not.toHaveBeenCalled();
	});
	it("registers a second site under the current organization", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getCmsSiteByHostname.mockResolvedValue(null);
		mocks.getAppsByOrganization.mockResolvedValue([
			{
				id: cmsSite.authoringAppId,
				metadata: {
					mcpConfig: {
						connectionLabel: registration.slug,
						aggregateApps: [{ slug: "cms" }],
					},
				},
			},
		]);
		mocks.registerCmsSiteIfAbsent.mockImplementation(async (_db, row) => ({
			...row,
			status: "provisioning",
		}));
		mocks.activateCmsSiteAfterMedia.mockImplementation(
			async (_db, identity) => ({
				...cmsSite,
				id: identity.siteId,
				slug: registration.slug,
				name: registration.name,
				authoringAppId: registration.authoringAppId,
				templateSlug: registration.templateSlug,
				customDomain: registration.customDomain,
				canonicalUrl: "https://landing.acme.test",
			}),
		);
		const env = cmsResourceEnv();
		const result = await client(true, env).registerCms(registration);
		expect(result.url).toBe("https://landing.acme.test");
		const mediaRequest = vi.mocked(env.CMS.fetch).mock.calls[0]?.[0] as Request;
		expect(mediaRequest.headers.get("X-Tedix-CMS-Media-Intent")).toBe("create");
		expect(mocks.registerCmsSiteIfAbsent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: organization.id,
				slug: "acme-marketing",
				status: "provisioning",
				templateSlug: "marketing",
			}),
		);
		mocks.getCmsSiteBySlug.mockResolvedValue({
			...cmsSite,
			slug: registration.slug,
			name: registration.name,
			authoringAppId: registration.authoringAppId,
			templateSlug: registration.templateSlug,
			customDomain: registration.customDomain,
			canonicalUrl: "https://landing.acme.test",
		});
		await expect(client(true).registerCms(registration)).resolves.toMatchObject(
			{
				slug: registration.slug,
			},
		);
		expect(mocks.registerCmsSiteIfAbsent).toHaveBeenCalledTimes(1);
	});
});

describe("CMS site creation", () => {
	const input = {
		slug: "acme-marketing",
		name: "Acme Marketing",
		templateSlug: "marketing" as const,
	};
	const authoringApp = {
		id: "44444444-4444-4444-8444-444444444444",
		organizationId: organization.id,
		slug: "cms-acme-marketing",
		visibility: "private",
		metadata: {
			mcpConfig: {
				authMode: "authenticated",
				codeMode: true,
				expectedAudience: "https://cms-acme-marketing.mcp.tedix.dev/mcp",
				connectionLabel: input.slug,
				aggregateApps: [{ slug: "cms" }],
			},
		},
	};
	const site = {
		...cmsSite,
		id: "55555555-5555-4555-8555-555555555555",
		slug: input.slug,
		name: input.name,
		templateSlug: input.templateSlug,
		organizationId: organization.id,
		authoringAppId: authoringApp.id,
		customDomain: null,
		canonicalUrl: "https://acme-marketing.cms.tedix.dev",
	};

	it("requires tenant settings authority before creating any resource", async () => {
		await expect(
			client(false, cmsResourceEnv(), ["apps:read"]).createCms(input),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.createApp).not.toHaveBeenCalled();
		expect(mocks.registerCmsSiteWithinQuota).not.toHaveBeenCalled();
	});

	it("rejects a new site at quota before creating its authoring resources", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 1 });
		await expect(client().createCms(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.createApp).not.toHaveBeenCalled();
		expect(mocks.registerCmsSiteWithinQuota).not.toHaveBeenCalled();
	});

	it("uses starter quota when an invited organization has no billing entitlement", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.listCmsSitesByOrganization.mockResolvedValue([]);
		mocks.getOrganizationFeatures.mockResolvedValue(null);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue(site);
		await expect(client().createCms(input)).resolves.toMatchObject({
			siteId: site.id,
		});
		expect(mocks.registerCmsSiteWithinQuota).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			1,
		);
	});

	it("allows an existing-site retry even when the organization is at quota", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(site);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 1 });
		await expect(client().createCms(input)).resolves.toMatchObject({
			siteId: site.id,
		});
		expect(mocks.registerCmsSiteWithinQuota).not.toHaveBeenCalled();
	});

	it("creates one authoring proxy and an unpublished site, then safely retries", async () => {
		mocks.getCmsSiteBySlug
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(site);
		mocks.getAppBySlug
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(authoringApp);
		mocks.createApp.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue({
			...site,
			status: "provisioning",
		});
		mocks.activateCmsSiteAfterMedia.mockResolvedValue(site);
		mocks.getTenantBundleSummary.mockResolvedValue({
			activeVersion: null,
			lastDeployedAt: null,
		});
		const env = cmsResourceEnv(false, true);
		const first = await client(false, env).createCms(input);
		expect(first).toEqual({
			siteId: site.id,
			slug: input.slug,
			url: site.canonicalUrl,
			readyForAuthoring: true,
			published: false,
		});
		expect(mocks.createApp).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				slug: "cms-acme-marketing",
				organizationId: organization.id,
				metadata: expect.objectContaining({
					mcpConfig: expect.objectContaining({
						connectionLabel: input.slug,
						aggregateApps: [{ slug: "cms" }],
					}),
				}),
			}),
		);
		expect(mocks.registerCmsSiteWithinQuota).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: organization.id,
				authoringAppId: authoringApp.id,
				slug: input.slug,
				status: "provisioning",
				templateSlug: input.templateSlug,
			}),
			5,
		);
		expect(env.CMS.fetch).toHaveBeenCalledWith(
			expect.objectContaining({ method: "POST" }),
		);
		const firstMediaRequest = vi.mocked(env.CMS.fetch).mock
			.calls[0]?.[0] as Request;
		expect(firstMediaRequest.headers.get("X-Tedix-CMS-Media-Intent")).toBe(
			"create",
		);
		expect(firstMediaRequest.headers.get("X-Tedix-CMS-Site-Id")).toBe(site.id);
		expect(mocks.activateCmsSiteAfterMedia).toHaveBeenCalledWith(
			expect.anything(),
			{ siteId: site.id, slug: site.slug },
		);
		await expect(client(false, env).createCms(input)).resolves.toEqual(first);
		const retryMediaRequest = vi.mocked(env.CMS.fetch).mock
			.calls[1]?.[0] as Request;
		expect(retryMediaRequest.headers.get("X-Tedix-CMS-Media-Intent")).toBe(
			"repair",
		);
		expect(mocks.createApp).toHaveBeenCalledTimes(1);
		expect(mocks.registerCmsSiteWithinQuota).toHaveBeenCalledTimes(1);
	});

	it("rejects a foreign site slug before making an authoring app", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue({
			...site,
			organizationId: "foreign-org",
		});
		await expect(client().createCms(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.createApp).not.toHaveBeenCalled();
	});

	it("rejects a same-slug authoring app with another target", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getAppBySlug.mockResolvedValue({
			...authoringApp,
			metadata: {
				mcpConfig: {
					connectionLabel: "other",
					aggregateApps: [{ slug: "cms" }],
				},
			},
		});
		await expect(client().createCms(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.registerCmsSiteWithinQuota).not.toHaveBeenCalled();
	});

	it("reports an existing published site without creating another site", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(site);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		const result = await client().createCms(input);
		expect(result).toMatchObject({
			siteId: site.id,
			readyForAuthoring: true,
			published: true,
		});
		expect(mocks.createApp).not.toHaveBeenCalled();
		expect(mocks.registerCmsSiteWithinQuota).not.toHaveBeenCalled();
	});

	it("returns an existing site after its domain changes, and reports a paused site as unpublished", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue({
			...site,
			status: "paused",
			customDomain: "example.com",
			canonicalUrl: "https://example.com",
		});
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		await expect(client().createCms(input)).resolves.toMatchObject({
			url: "https://example.com",
			readyForAuthoring: false,
			published: false,
		});
	});

	it("leaves a non-serving site for retry if media provisioning fails", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue({
			...site,
			status: "provisioning",
		});
		const env = cmsResourceEnv();
		vi.mocked(env.CMS.fetch).mockResolvedValue(
			Response.json(
				{ success: false, error: "Bucket unavailable" },
				{ status: 503 },
			),
		);
		await expect(client(false, env).createCms(input)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
		});
		expect(mocks.registerCmsSiteWithinQuota).toHaveBeenCalledOnce();
		expect(mocks.activateCmsSiteAfterMedia).not.toHaveBeenCalled();
	});

	it("does not activate when deprovision wins after media readback", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue({
			...site,
			status: "provisioning",
		});
		mocks.activateCmsSiteAfterMedia.mockResolvedValue(null);
		const env = cmsResourceEnv(false, true);
		await expect(client(false, env).createCms(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(env.CMS.fetch).toHaveBeenCalledOnce();
		expect(mocks.activateCmsSiteAfterMedia).toHaveBeenCalledWith(
			expect.anything(),
			{ siteId: site.id, slug: site.slug },
		);
	});

	it("rechecks a concurrent site's configuration after an insert conflict", async () => {
		mocks.getCmsSiteBySlug
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ ...site, organizationId: "foreign-org" });
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue(null);
		await expect(client().createCms(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("reports a quota race when a different slug filled the last slot", async () => {
		mocks.getCmsSiteBySlug.mockResolvedValue(null);
		mocks.getAppBySlug.mockResolvedValue(authoringApp);
		mocks.registerCmsSiteWithinQuota.mockResolvedValue(null);
		mocks.listCmsSitesByOrganization.mockResolvedValue([]);
		mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 1 });
		await expect(client().createCms(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

it("lists owned CMS quota usage including paused sites", async () => {
	mocks.listCmsSitesByOrganization.mockResolvedValue([
		cmsSite,
		{
			...cmsSite,
			id: "66666666-6666-4666-8666-666666666666",
			status: "paused",
		},
	]);
	mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 5 });
	const result = await client().list();
	expect(result.cmsSiteQuota).toEqual({ used: 2, limit: 5 });
});

describe("CMS canonical domain updates", () => {
	it("requires platform authority", async () => {
		await expect(
			client().updateCmsDomain({
				siteId: cmsSite.id,
				customDomain: "example.test",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateCmsSiteDomain).not.toHaveBeenCalled();
	});
	it("rejects another site's hostname", async () => {
		mocks.getCmsSiteByHostname.mockResolvedValueOnce({
			...cmsSite,
			id: "other",
		});
		await expect(
			client(true).updateCmsDomain({
				siteId: cmsSite.id,
				customDomain: "example.test",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.updateCmsSiteDomain).not.toHaveBeenCalled();
	});
	it("updates the owned site's hostname and canonical URL together", async () => {
		mocks.getCmsSiteByHostname.mockResolvedValueOnce(null);
		mocks.updateCmsSiteDomain.mockResolvedValueOnce({
			...cmsSite,
			customDomain: "example.test",
			canonicalUrl: "https://example.test",
		});
		await expect(
			client(true).updateCmsDomain({
				siteId: cmsSite.id,
				customDomain: "example.test",
			}),
		).resolves.toMatchObject({ url: "https://example.test" });
		expect(mocks.updateCmsSiteDomain).toHaveBeenCalledWith(expect.anything(), {
			id: cmsSite.id,
			organizationId: organization.id,
			customDomain: "example.test",
			canonicalUrl: "https://example.test",
		});
	});
	it("does not update an unowned site", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValueOnce(null);
		await expect(
			client(true).updateCmsDomain({ siteId: cmsSite.id, customDomain: null }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateCmsSiteDomain).not.toHaveBeenCalled();
	});
});

describe("tenant CMS domain claims", () => {
	const claimId = "44444444-4444-4444-8444-444444444444";
	const hostname = "blog.acme.test";
	const token = "a".repeat(64);
	const claim = {
		id: claimId,
		organizationId: organization.id,
		siteId: cmsSite.id,
		hostname,
		kind: "primary" as const,
		verificationToken: token,
		providerHostnameId: null,
		status: "pending" as const,
		expiresAt: "2099-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const provider = {
		id: "provider-1",
		hostname,
		status: "active",
		ssl: { status: "active", validation_records: [] },
	};

	beforeEach(() => {
		mocks.getOrganizationFeatures.mockResolvedValue({
			maxCmsSites: 5,
			customDomain: true,
		});
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([]);
		mocks.getCmsDomainClaimForSite.mockResolvedValue(claim);
		mocks.reserveCmsDomainClaim.mockResolvedValue(claim);
		mocks.beginCmsDomainProvisioning.mockResolvedValue({
			...claim,
			status: "provisioning",
		});
		mocks.finishCmsDomainProvisioning.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
		});
		mocks.adoptLegacyCmsDomainClaim.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
			status: "active",
		});
		mocks.activateCmsDomainClaim.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
			status: "active",
		});
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
			status: "removing",
		});
		mocks.removeCmsDomainClaim.mockResolvedValue(true);
		mocks.verifyCmsDnsChallenge.mockResolvedValue(false);
		mocks.verifyCmsDnsTarget.mockResolvedValue(false);
		mocks.verifyCmsDnsZoneApex.mockResolvedValue(false);
		mocks.findCmsCustomHostname.mockResolvedValue(null);
		mocks.getCmsCustomHostname.mockResolvedValue(provider);
		mocks.createCmsCustomHostname.mockResolvedValue(provider);
		mocks.deleteCmsCustomHostname.mockResolvedValue(true);
	});

	it("requires content administration and keeps other organizations' sites inaccessible", async () => {
		await expect(
			client(false, cmsResourceEnv(), ["apps:read"]).beginCmsDomain({
				siteId: cmsSite.id,
				hostname,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.reserveCmsDomainClaim).not.toHaveBeenCalled();
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue(null);
		await expect(
			client().beginCmsDomain({ siteId: cmsSite.id, hostname }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			client().removeCmsDomain({ siteId: cmsSite.id, claimId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.getCmsDomainClaimForSite).not.toHaveBeenCalled();
		expect(mocks.beginRemovingCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("requires entitlement and provider configuration before reserving a claim", async () => {
		mocks.getOrganizationFeatures.mockResolvedValue({ customDomain: false });
		await expect(
			client().beginCmsDomain({ siteId: cmsSite.id, hostname }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.getOrganizationFeatures.mockResolvedValue({ customDomain: true });
		await expect(
			client(false, {} as CloudflareEnv).beginCmsDomain({
				siteId: cmsSite.id,
				hostname,
			}),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		expect(mocks.reserveCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("reserves once, returns the DNS instructions, and reuses the pending claim", async () => {
		const result = await client().beginCmsDomain({
			siteId: cmsSite.id,
			hostname: " BLOG.ACME.TEST. ",
		});
		expect(result).toMatchObject({
			claimId,
			hostname,
			status: "pending",
			txtName: `_tedix-cms.${hostname}`,
			txtValue: token,
			cnameTarget: "acme.cms.tedix.dev",
		});
		expect(mocks.reserveCmsDomainClaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: organization.id,
				siteId: cmsSite.id,
				hostname,
			}),
		);
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([claim]);
		await expect(
			client().beginCmsDomain({ siteId: cmsSite.id, hostname }),
		).resolves.toMatchObject({ claimId });
		await expect(
			client().beginCmsDomain({
				siteId: cmsSite.id,
				hostname: "other.acme.test",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.reserveCmsDomainClaim).toHaveBeenCalledTimes(1);
	});

	it("lets an owner inspect a pending claim without altering it", async () => {
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([claim]);
		await expect(
			client().getCmsDomain({ siteId: cmsSite.id }),
		).resolves.toMatchObject({ claimId, status: "pending" });
		expect(mocks.reserveCmsDomainClaim).not.toHaveBeenCalled();
		expect(mocks.createCmsCustomHostname).not.toHaveBeenCalled();
	});

	it("keeps a subdomain pending until TXT and its direct CNAME point to the owned site", async () => {
		const input = { siteId: cmsSite.id, claimId };
		await expect(client().verifyCmsDomain(input)).resolves.toMatchObject({
			status: "pending",
		});
		expect(mocks.verifyCmsDnsTarget).not.toHaveBeenCalled();
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		await expect(client().verifyCmsDomain(input)).resolves.toMatchObject({
			status: "pending",
		});
		expect(mocks.verifyCmsDnsTarget).toHaveBeenCalledWith(
			hostname,
			"acme.cms.tedix.dev",
		);
		expect(mocks.createCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("can provision a verified zone apex while its CNAME is flattened", async () => {
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsZoneApex.mockResolvedValue(true);
		mocks.getCmsCustomHostname.mockResolvedValue({
			...provider,
			status: "pending",
			ssl: { status: "pending_validation" },
		});
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ status: "pending" });
		expect(mocks.findCmsCustomHostname).toHaveBeenCalled();
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
		});
		mocks.getCmsCustomHostname.mockResolvedValue(provider);
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ status: "active" });
		expect(mocks.activateCmsDomainClaim).toHaveBeenCalledOnce();
	});

	it("waits for Cloudflare hostname and SSL activation, then activates once", async () => {
		const input = { siteId: cmsSite.id, claimId };
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsTarget.mockResolvedValue(true);
		mocks.getCmsCustomHostname.mockResolvedValueOnce({
			...provider,
			ssl: { status: "pending_validation" },
		});
		await expect(client().verifyCmsDomain(input)).resolves.toMatchObject({
			status: "pending",
			providerStatus: "active",
			sslStatus: "pending_validation",
		});
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
		});
		await expect(client().verifyCmsDomain(input)).resolves.toMatchObject({
			status: "active",
			providerStatus: "active",
			sslStatus: "active",
		});
		expect(mocks.activateCmsDomainClaim).toHaveBeenCalledWith(
			expect.anything(),
			{ id: claimId, organizationId: organization.id, siteId: cmsSite.id },
		);
		expect(mocks.createCmsCustomHostname).toHaveBeenCalledTimes(1);
		expect(mocks.beginCmsDomainProvisioning).toHaveBeenCalledOnce();
		expect(mocks.finishCmsDomainProvisioning).toHaveBeenCalledWith(
			expect.anything(),
			{
				id: claimId,
				organizationId: organization.id,
				siteId: cmsSite.id,
				providerHostnameId: provider.id,
				provisioningStartedAt: claim.updatedAt,
			},
		);
	});

	it("does not create twice when another verifier holds the provisioning lease", async () => {
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsTarget.mockResolvedValue(true);
		mocks.beginCmsDomainProvisioning.mockResolvedValue(null);
		mocks.getCmsDomainClaimForSite
			.mockResolvedValueOnce(claim)
			.mockResolvedValueOnce({ ...claim, status: "provisioning" });
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ claimId, status: "provisioning" });
		expect(mocks.findCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.createCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.finishCmsDomainProvisioning).not.toHaveBeenCalled();
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("retries a stale provisioning claim through a new fenced lease", async () => {
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			status: "provisioning",
		});
		mocks.beginCmsDomainProvisioning.mockResolvedValue({
			...claim,
			status: "provisioning",
			updatedAt: "2026-09-26T20:00:00.000Z",
		});
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsTarget.mockResolvedValue(true);
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ claimId, status: "active" });
		expect(mocks.beginCmsDomainProvisioning).toHaveBeenCalledOnce();
		expect(mocks.finishCmsDomainProvisioning).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				providerHostnameId: provider.id,
				provisioningStartedAt: "2026-09-26T20:00:00.000Z",
			}),
		);
	});

	it("retries removal after provider failure and deletes only the exact claim hostname", async () => {
		const input = { siteId: cmsSite.id, claimId };
		mocks.deleteCmsCustomHostname.mockRejectedValueOnce(
			new Error("Cloudflare unavailable"),
		);
		await expect(client().removeCmsDomain(input)).rejects.toThrow(
			"Cloudflare unavailable",
		);
		expect(mocks.removeCmsDomainClaim).not.toHaveBeenCalled();
		await expect(client().removeCmsDomain(input)).resolves.toEqual({
			removed: true,
		});
		expect(mocks.deleteCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			provider.id,
			hostname,
		);
		expect(mocks.removeCmsDomainClaim).toHaveBeenCalledWith(expect.anything(), {
			id: claimId,
			organizationId: organization.id,
			siteId: cmsSite.id,
		});
	});

	it("refuses removal while hostname creation still holds its lease", async () => {
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			status: "provisioning",
		});
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue(null);
		await expect(
			client().removeCmsDomain({ siteId: cmsSite.id, claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.findCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.deleteCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.removeCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("removes a stale provisioning hostname by exact provider lookup", async () => {
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			status: "provisioning",
		});
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue({
			...claim,
			status: "removing_provisioning",
		});
		mocks.findCmsCustomHostname.mockResolvedValue(provider);
		await expect(
			client().removeCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toEqual({ removed: true });
		expect(mocks.findCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			hostname,
		);
		expect(mocks.deleteCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			provider.id,
			hostname,
		);
		expect(mocks.verifyCmsDnsChallenge).not.toHaveBeenCalled();
	});

	it("finishes replacement cleanup when verification is retried after activation", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			customDomain: hostname,
			canonicalUrl: `https://${hostname}`,
		});
		const old = {
			...claim,
			id: "55555555-5555-4555-8555-555555555555",
			hostname: "old.acme.test",
			providerHostnameId: "provider-old",
			status: "active" as const,
		};
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			providerHostnameId: provider.id,
			status: "active",
		});
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([
			{ ...claim, providerHostnameId: provider.id, status: "active" },
			old,
		]);
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue({
			...old,
			status: "removing",
		});
		mocks.beginRemovingReplacedCmsDomainClaim.mockResolvedValue({
			...old,
			status: "removing",
		});
		await client().verifyCmsDomain({ siteId: cmsSite.id, claimId });
		expect(mocks.deleteCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			"provider-old",
			"old.acme.test",
		);
		expect(mocks.removeCmsDomainClaim).toHaveBeenCalledWith(expect.anything(), {
			id: old.id,
			organizationId: organization.id,
			siteId: cmsSite.id,
		});
	});

	it("does not let verification of an older active claim clean the current hostname", async () => {
		mocks.getCmsDomainClaimForSite.mockResolvedValue({
			...claim,
			status: "active",
			providerHostnameId: provider.id,
		});
		mocks.getCmsSiteByIdForOrganization
			.mockResolvedValueOnce(cmsSite)
			.mockResolvedValueOnce({ ...cmsSite, customDomain: "new.acme.test" });
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.beginRemovingReplacedCmsDomainClaim).not.toHaveBeenCalled();
		expect(mocks.deleteCmsCustomHostname).not.toHaveBeenCalled();
	});

	it("adopts a ready legacy hostname already routed by the site", async () => {
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			customDomain: hostname,
			canonicalUrl: `https://${hostname}`,
		});
		mocks.findCmsCustomHostname.mockResolvedValue(provider);
		await expect(
			client().beginCmsDomain({ siteId: cmsSite.id, hostname }),
		).resolves.toMatchObject({ claimId, status: "active" });
		expect(mocks.adoptLegacyCmsDomainClaim).toHaveBeenCalledWith(
			expect.anything(),
			{
				id: claimId,
				organizationId: organization.id,
				siteId: cmsSite.id,
				providerHostnameId: provider.id,
			},
		);
		expect(mocks.verifyCmsDnsChallenge).not.toHaveBeenCalled();
		expect(mocks.createCmsCustomHostname).not.toHaveBeenCalled();
	});

	it("removes a routed legacy hostname with no stored provider ID", async () => {
		mocks.getCmsDomainClaimForSite.mockResolvedValue(claim);
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue({
			...claim,
			status: "removing_legacy",
		});
		mocks.findCmsCustomHostname.mockResolvedValue(provider);
		await expect(
			client().removeCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toEqual({ removed: true });
		expect(mocks.findCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			hostname,
		);
		expect(mocks.deleteCmsCustomHostname).toHaveBeenCalledWith(
			expect.anything(),
			provider.id,
			hostname,
		);
	});

	it("does not delete an unbound provider hostname for a pending claim", async () => {
		mocks.beginRemovingCmsDomainClaim.mockResolvedValue({
			...claim,
			status: "removing",
		});
		await client().removeCmsDomain({ siteId: cmsSite.id, claimId });
		expect(mocks.findCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.deleteCmsCustomHostname).not.toHaveBeenCalled();
	});

	it("reserves a separate www claim only for the site's verified apex", async () => {
		const apex = "acme.test";
		const alias = {
			...claim,
			hostname: `www.${apex}`,
			kind: "www_alias" as const,
		};
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			customDomain: apex,
		});
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([
			{
				...claim,
				hostname: apex,
				status: "active",
				providerHostnameId: provider.id,
			},
		]);
		mocks.verifyCmsDnsZoneApex.mockResolvedValue(true);
		mocks.reserveCmsDomainClaim.mockResolvedValue(alias);
		await expect(
			client().beginCmsDomain({
				siteId: cmsSite.id,
				hostname: alias.hostname,
				redirectToApex: true,
			}),
		).resolves.toMatchObject({ hostname: alias.hostname, status: "pending" });
		expect(mocks.reserveCmsDomainClaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ hostname: alias.hostname, kind: "www_alias" }),
		);
		await expect(
			client().beginCmsDomain({
				siteId: cmsSite.id,
				hostname: "www.other.test",
				redirectToApex: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("keeps the www claim separate and requires its direct CNAME", async () => {
		const apex = "acme.test";
		const alias = {
			...claim,
			hostname: `www.${apex}`,
			kind: "www_alias" as const,
		};
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			customDomain: apex,
		});
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([alias]);
		await expect(
			client().getCmsDomain({ siteId: cmsSite.id }),
		).resolves.toBeNull();
		await expect(
			client().getCmsDomain({ siteId: cmsSite.id, redirectToApex: true }),
		).resolves.toMatchObject({ claimId, hostname: alias.hostname });
		mocks.getCmsDomainClaimForSite.mockResolvedValue(alias);
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsZoneApex.mockResolvedValue(true);
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ status: "pending" });
		expect(mocks.createCmsCustomHostname).not.toHaveBeenCalled();
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("activates a verified www alias without replacing the canonical claim", async () => {
		const apex = "acme.test";
		const alias = {
			...claim,
			hostname: `www.${apex}`,
			kind: "www_alias" as const,
		};
		const aliasProvider = { ...provider, hostname: alias.hostname };
		mocks.getCmsSiteByIdForOrganization.mockResolvedValue({
			...cmsSite,
			customDomain: apex,
		});
		mocks.getCmsDomainClaimForSite.mockResolvedValue(alias);
		mocks.verifyCmsDnsChallenge.mockResolvedValue(true);
		mocks.verifyCmsDnsTarget.mockResolvedValue(true);
		mocks.createCmsCustomHostname.mockResolvedValue(aliasProvider);
		mocks.getCmsCustomHostname.mockResolvedValue(aliasProvider);
		mocks.finishCmsDomainProvisioning.mockResolvedValue({
			...alias,
			providerHostnameId: aliasProvider.id,
		});
		mocks.activateCmsWwwAliasClaim.mockResolvedValue({
			...alias,
			providerHostnameId: aliasProvider.id,
			status: "active",
		});
		await expect(
			client().verifyCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toMatchObject({ status: "active" });
		expect(mocks.activateCmsWwwAliasClaim).toHaveBeenCalled();
		expect(mocks.activateCmsDomainClaim).not.toHaveBeenCalled();
		expect(mocks.beginRemovingReplacedCmsDomainClaim).not.toHaveBeenCalled();
	});

	it("removes the www provider before removing its apex claim", async () => {
		const apex = "acme.test";
		const primary = {
			...claim,
			hostname: apex,
			status: "active" as const,
			providerHostnameId: "provider-apex",
		};
		const alias = {
			...claim,
			id: "55555555-5555-4555-8555-555555555555",
			hostname: `www.${apex}`,
			kind: "www_alias" as const,
			status: "active" as const,
			providerHostnameId: "provider-www",
		};
		mocks.getCmsDomainClaimForSite.mockResolvedValue(primary);
		mocks.listCmsDomainClaimsForSite.mockResolvedValue([primary, alias]);
		mocks.beginRemovingCmsDomainClaim
			.mockResolvedValueOnce({ ...alias, status: "removing" })
			.mockResolvedValueOnce({ ...primary, status: "removing" });
		await expect(
			client().removeCmsDomain({ siteId: cmsSite.id, claimId }),
		).resolves.toEqual({ removed: true });
		expect(mocks.deleteCmsCustomHostname.mock.calls).toEqual([
			[expect.anything(), "provider-www", alias.hostname],
			[expect.anything(), "provider-apex", apex],
		]);
	});
});

describe("CMS draft proposal authority", () => {
	const input = {
		siteId: cmsSite.id,
		action: "rewrite" as const,
		draft: {
			collection: "posts",
			entryId: "entry",
			locale: "en",
			baseRevision: "rev",
			invocationId: "invocation-123456",
			fields: { title: "Draft title" },
		},
	};
	it("admits a current editorial tenant member without OS permissions and bills the site owner", async () => {
		mocks.getCmsSiteById.mockResolvedValue({
			...cmsSite,
			config: { blog: { authDescopeTenantId: "customer-editorial-tenant" } },
		});
		mocks.loadEditorial.mockResolvedValue({
			roles: ["editor"],
			email: "editor@example.com",
			name: "Editor",
		});
		mocks.propose.mockResolvedValue({
			invocationId: input.draft.invocationId,
			entryId: input.draft.entryId,
			locale: input.draft.locale,
			baseRevision: input.draft.baseRevision,
			values: { title: "Proposed title" },
		});
		await client(false, undefined, [], "user", null).proposeCmsEditorDraft(
			input,
		);
		expect(mocks.loadEditorial).toHaveBeenCalledWith(
			expect.anything(),
			"owner-1",
			"customer-editorial-tenant",
		);
		expect(mocks.propose).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			input,
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org-1",
				actorId: "owner-1",
				actorType: "user",
				resourceId: cmsSite.id,
			}),
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("Draft title");
	});
	it("rejects membership revoked in the selected site even with OS permissions", async () => {
		mocks.getCmsSiteById.mockResolvedValue({
			...cmsSite,
			config: { blog: { authDescopeTenantId: "another-tenant" } },
		});
		mocks.loadEditorial.mockResolvedValue(null);
		await expect(client().proposeCmsEditorDraft(input)).rejects.toThrow(
			"editorial membership",
		);
		expect(mocks.propose).not.toHaveBeenCalled();
	});
	it("rejects viewer membership and inactive sites", async () => {
		mocks.getCmsSiteById.mockResolvedValue(cmsSite);
		mocks.getOrganizationById.mockResolvedValue({
			...organization,
			descopeTenantId: "owner-tenant",
		});
		mocks.loadEditorial.mockResolvedValue({ roles: ["viewer"] });
		await expect(client().proposeCmsEditorDraft(input)).rejects.toThrow(
			"editorial membership",
		);
		mocks.getCmsSiteById.mockResolvedValue({ ...cmsSite, status: "paused" });
		await expect(client().proposeCmsEditorDraft(input)).rejects.toThrow(
			"unavailable",
		);
		expect(mocks.propose).not.toHaveBeenCalled();
	});
	it.each(["apikey", "service-binding", "m2m", "tedi"] as const)(
		"rejects %s identities before site reads or inference",
		async (authType) => {
			await expect(
				client(false, undefined, [], authType).proposeCmsEditorDraft(input),
			).rejects.toThrow();
			expect(mocks.getCmsSiteById).not.toHaveBeenCalled();
			expect(mocks.propose).not.toHaveBeenCalled();
		},
	);
	it("refuses even a machine API key with the exact content scope before site reads", async () => {
		await expect(
			client(false, undefined, [], "apikey", null, [
				"mcp:content.write",
			]).proposeCmsEditorDraft(input),
		).rejects.toThrow("editor session");
		expect(mocks.getCmsSiteById).not.toHaveBeenCalled();
		expect(mocks.propose).not.toHaveBeenCalled();
	});
});
