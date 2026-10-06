import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class NonRetryableError extends Error {},
}));

const mocks = vi.hoisted(() => ({
	createDb: vi.fn(),
	getOperation: vi.fn(),
	updateOperation: vi.fn(),
	completeOperation: vi.fn(),
	getSite: vi.fn(),
	setSiteStatus: vi.fn(),
	getApps: vi.fn(),
	listClaims: vi.fn(),
	beginRemovingClaim: vi.fn(),
	removeClaim: vi.fn(),
	findHostname: vi.fn(),
	deleteHostname: vi.fn(),
	countPermits: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: mocks.createDb }));
vi.mock("@tedix/db/queries/cms-deprovision-operations", () => ({
	getCmsDeprovisionOperation: mocks.getOperation,
	updateCmsDeprovisionOperation: mocks.updateOperation,
	completeCmsDeprovisionOperation: mocks.completeOperation,
}));
vi.mock("@tedix/db/queries/cms-restore-fences", () => ({
	countCmsRestorePermitsForSite: mocks.countPermits,
}));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteByIdForOrganization: mocks.getSite,
	setCmsSiteStatus: mocks.setSiteStatus,
}));
vi.mock("@tedix/db/queries/cms-domain-claims", () => ({
	listCmsDomainClaimsForSite: mocks.listClaims,
	beginRemovingCmsDomainClaim: mocks.beginRemovingClaim,
	removeCmsDomainClaim: mocks.removeClaim,
}));
vi.mock("../services/cms-custom-hostnames", () => ({
	findCmsCustomHostname: mocks.findHostname,
	deleteCmsCustomHostname: mocks.deleteHostname,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: mocks.getApps,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	deleteApp: vi.fn(),
	getAppMetadataJson: vi.fn(),
	updateApp: vi.fn(),
}));

import { CmsDeprovisionWorkflow } from "./cms-deprovision-workflow";

const siteId = "11111111-1111-4111-8111-111111111111";
const organizationId = "org-1";
const receipt = {
	id: siteId,
	organizationId,
	slug: "acme",
	authoringAppId: null,
	status: "queued",
	stage: "queued",
	deleted: [],
	errors: [],
};
const completeProviderResult = {
	success: true,
	deletedDurableObjectData: true,
	deletedMediaBucket: true,
	deletedBundles: true,
	deletedSiteBuilderObjects: 0,
	deletedSandbox: true,
	errors: [],
};

function harness(cmsResponse: Response) {
	const fetch = vi.fn().mockResolvedValue(cmsResponse);
	const workflow = new CmsDeprovisionWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(workflow as unknown as { env: CloudflareEnv }).env = {
		DB: {},
		CMS: { fetch },
		PLATFORM_SERVICE_TOKEN: "test",
	} as unknown as CloudflareEnv;
	const calls: string[] = [];
	const step = {
		do: vi.fn(
			async (
				name: string,
				_options: unknown,
				callback: () => Promise<unknown>,
			) => {
				calls.push(name);
				return callback();
			},
		),
	};
	const event = { instanceId: siteId, payload: { siteId, organizationId } };
	return { workflow, event, step, fetch, calls };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDb.mockReturnValue({});
	mocks.getOperation.mockResolvedValue(receipt);
	mocks.countPermits.mockResolvedValue(0);
	mocks.getSite.mockResolvedValue({
		id: siteId,
		slug: receipt.slug,
		authoringAppId: receipt.authoringAppId,
	});
	mocks.getApps.mockResolvedValue([]);
	mocks.listClaims.mockResolvedValue([]);
	mocks.findHostname.mockResolvedValue(null);
	mocks.deleteHostname.mockResolvedValue(true);
	mocks.removeClaim.mockResolvedValue(true);
	mocks.updateOperation.mockResolvedValue(receipt);
	mocks.completeOperation.mockResolvedValue({
		...receipt,
		status: "succeeded",
	});
});

describe("CmsDeprovisionWorkflow", () => {
	it("waits for site permits to drain before pausing or calling a provider", async () => {
		vi.useFakeTimers();
		try {
			mocks.countPermits.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
			const { workflow, event, step, fetch } = harness(
				Response.json(completeProviderResult),
			);
			const run = workflow.run(event as never, step as never);
			await vi.advanceTimersByTimeAsync(2_000);
			await expect(run).resolves.toMatchObject({ siteId });
			expect(mocks.countPermits).toHaveBeenCalledWith({}, siteId);
			expect(mocks.countPermits).toHaveBeenCalledTimes(2);
			expect(mocks.setSiteStatus.mock.invocationCallOrder[0]).toBeGreaterThan(
				mocks.countPermits.mock.invocationCallOrder[1]!,
			);
			expect(fetch.mock.invocationCallOrder[0]).toBeGreaterThan(
				mocks.countPermits.mock.invocationCallOrder[1]!,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails closed and records failure when the D1 drain read fails", async () => {
		mocks.countPermits.mockRejectedValue(new Error("D1 unavailable"));
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"D1 unavailable",
		);
		expect(mocks.setSiteStatus).not.toHaveBeenCalled();
		expect(mocks.deleteHostname).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.updateOperation).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				status: "failed",
				errors: ["D1 unavailable"],
			}),
		);
	});

	it("leaves resources intact when an orphan permit never drains", async () => {
		vi.useFakeTimers();
		try {
			mocks.countPermits.mockResolvedValue(1);
			const { workflow, event, step, fetch } = harness(
				Response.json(completeProviderResult),
			);
			const run = workflow.run(event as never, step as never);
			const outcome = expect(run).rejects.toThrow(
				"CMS mutations are still in progress",
			);
			await vi.advanceTimersByTimeAsync(538_000);
			await outcome;
			expect(mocks.setSiteStatus).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
			expect(mocks.updateOperation).toHaveBeenCalledWith(
				{},
				expect.objectContaining({ status: "failed" }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a changed site identity before draining or provider cleanup", async () => {
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: "replacement",
			authoringAppId: receipt.authoringAppId,
		});
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"CMS deprovision site identity mismatch",
		);
		expect(mocks.countPermits).not.toHaveBeenCalled();
		expect(mocks.setSiteStatus).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects a changed authoring app before resource cleanup", async () => {
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: receipt.slug,
			authoringAppId: "other-app",
		});
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"CMS deprovision site identity mismatch",
		);
		expect(mocks.countPermits).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("counts permits only for the operation site ID", async () => {
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await workflow.run(event as never, step as never);
		expect(mocks.countPermits).toHaveBeenCalledExactlyOnceWith({}, siteId);
	});

	it("records progress and a final receipt after provider and site cleanup", async () => {
		const { workflow, event, step, fetch, calls } = harness(
			Response.json(completeProviderResult),
		);
		await expect(
			workflow.run(event as never, step as never),
		).resolves.toMatchObject({
			siteId,
			deleted: expect.arrayContaining(["durable_object", "site"]),
		});
		expect(calls).toEqual([
			"verify deprovision receipt",
			"drain CMS mutations",
			"pause site and disable authoring",
			"remove CMS custom hostnames",
			"remove CMS resources",
			"remove site records",
		]);
		expect(mocks.setSiteStatus).toHaveBeenCalledWith({}, siteId, "paused");
		expect(fetch).toHaveBeenCalledOnce();
		const request = fetch.mock.calls[0]?.[0] as Request;
		expect(request.method).toBe("DELETE");
		expect(request.headers.get("X-Tedix-CMS-Site-Id")).toBe(siteId);
		expect(await request.text()).toBe("");
		expect(mocks.completeOperation).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				siteId,
				organizationId,
				deleted: expect.arrayContaining(["durable_object", "site"]),
			}),
		);
	});

	it("records only provider-confirmed resources after partial cleanup failure", async () => {
		const { workflow, event, step } = harness(
			Response.json(
				{
					...completeProviderResult,
					success: false,
					deletedMediaBucket: false,
					deletedSandbox: false,
					errors: ["R2 bucket unavailable"],
				},
				{ status: 502 },
			),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"R2 bucket unavailable",
		);
		expect(mocks.updateOperation).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				status: "running",
				deleted: ["durable_object", "bundles"],
			}),
		);
		expect(mocks.completeOperation).not.toHaveBeenCalled();
	});

	it("does not delete site records when provider omits an outcome", async () => {
		const { workflow, event, step } = harness(
			Response.json({ ...completeProviderResult, deletedSandbox: undefined }),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"CMS lifecycle omitted a resource cleanup outcome",
		);
		expect(mocks.completeOperation).not.toHaveBeenCalled();
	});

	it("retains a failed receipt and does not delete the site after provider failure", async () => {
		const { workflow, event, step } = harness(
			Response.json(
				{ success: false, errors: ["Durable Object unavailable"] },
				{ status: 502 },
			),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"Durable Object unavailable",
		);
		expect(mocks.completeOperation).not.toHaveBeenCalled();
		expect(mocks.updateOperation).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				status: "failed",
				errors: ["Durable Object unavailable"],
			}),
		);
	});

	it("deletes the exact owned hostname before CMS resources and site records", async () => {
		const claim = {
			id: "claim-a",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			verificationToken: "proof",
			providerHostnameId: "provider-a",
			status: "active",
		};
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: "acme",
			authoringAppId: null,
			customDomain: claim.hostname,
		});
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue({
			...claim,
			status: "removing",
		});
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(
			workflow.run(event as never, step as never),
		).resolves.toMatchObject({
			deleted: expect.arrayContaining(["hostname", "site"]),
		});
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"provider-a",
			"blog.example.com",
		);
		expect(mocks.removeClaim).toHaveBeenCalledWith(
			{},
			{
				id: claim.id,
				organizationId,
				siteId,
			},
		);
		expect(mocks.deleteHostname.mock.invocationCallOrder[0]).toBeLessThan(
			fetch.mock.invocationCallOrder[0]!,
		);
	});

	it("waits for an in-flight hostname creation before removing site resources", async () => {
		const claim = {
			id: "claim-creating",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			providerHostnameId: null,
			status: "provisioning",
		};
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue(null);
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"CMS domain provisioning is still in progress",
		);
		expect(step.do).toHaveBeenCalledWith(
			"remove CMS custom hostnames",
			expect.objectContaining({
				retries: expect.objectContaining({ delay: "1 minute" }),
			}),
			expect.any(Function),
		);
		expect(mocks.findHostname).not.toHaveBeenCalled();
		expect(mocks.removeClaim).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("finds and deletes a stale provisioning hostname without relying on DNS TXT", async () => {
		const claim = {
			id: "claim-stale",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			providerHostnameId: null,
			status: "provisioning",
		};
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue({
			...claim,
			status: "removing_provisioning",
		});
		mocks.findHostname.mockResolvedValue({
			id: "provider-stale",
			hostname: claim.hostname,
		});
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await expect(
			workflow.run(event as never, step as never),
		).resolves.toMatchObject({
			deleted: expect.arrayContaining(["hostname", "site"]),
		});
		expect(mocks.findHostname).toHaveBeenCalledWith(
			expect.anything(),
			claim.hostname,
		);
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"provider-stale",
			claim.hostname,
		);
		expect(mocks.removeClaim).toHaveBeenCalledWith(
			{},
			{
				id: claim.id,
				organizationId,
				siteId,
			},
		);
	});

	it("retries exact cleanup when a stale provisioning deletion failed", async () => {
		const claim = {
			id: "claim-retry",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			providerHostnameId: null,
			status: "removing_provisioning",
		};
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue(claim);
		mocks.findHostname.mockResolvedValue({
			id: "provider-retry",
			hostname: claim.hostname,
		});
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await workflow.run(event as never, step as never);
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"provider-retry",
			claim.hostname,
		);
	});

	it("does not look up a provider for a pending claim that never began creation", async () => {
		const claim = {
			id: "claim-pending",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			providerHostnameId: null,
			status: "pending",
		};
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue({
			...claim,
			status: "removing",
		});
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await workflow.run(event as never, step as never);
		expect(mocks.findHostname).not.toHaveBeenCalled();
		expect(mocks.deleteHostname).not.toHaveBeenCalled();
		expect(mocks.removeClaim).toHaveBeenCalledOnce();
	});

	it("finds an older provider hostname when a pending claim was already routed", async () => {
		const claim = {
			id: "claim-legacy",
			organizationId,
			siteId,
			hostname: "blog.example.com",
			providerHostnameId: null,
			status: "pending",
		};
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: "acme",
			authoringAppId: null,
			customDomain: claim.hostname,
		});
		mocks.listClaims.mockResolvedValue([claim]);
		mocks.beginRemovingClaim.mockResolvedValue({
			...claim,
			status: "removing_legacy",
		});
		mocks.findHostname.mockResolvedValue({
			id: "provider-legacy",
			hostname: claim.hostname,
		});
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await workflow.run(event as never, step as never);
		expect(mocks.findHostname).toHaveBeenCalledWith(
			expect.anything(),
			claim.hostname,
		);
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"provider-legacy",
			claim.hostname,
		);
		expect(mocks.findHostname).toHaveBeenCalledOnce();
	});

	it("keeps the failed receipt and site if hostname deletion fails", async () => {
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: "acme",
			authoringAppId: null,
			customDomain: "blog.example.com",
		});
		mocks.findHostname.mockResolvedValue({
			id: "legacy-provider",
			hostname: "blog.example.com",
		});
		mocks.deleteHostname.mockRejectedValue(
			new Error("Cloudflare denied deletion"),
		);
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(workflow.run(event as never, step as never)).rejects.toThrow(
			"Cloudflare denied deletion",
		);
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"legacy-provider",
			"blog.example.com",
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.completeOperation).not.toHaveBeenCalled();
	});

	it("removes a legacy site hostname with provider exact lookup", async () => {
		mocks.getSite.mockResolvedValue({
			id: siteId,
			slug: "acme",
			authoringAppId: null,
			customDomain: "blog.example.com",
		});
		mocks.findHostname.mockResolvedValue({
			id: "legacy-provider",
			hostname: "blog.example.com",
		});
		const { workflow, event, step } = harness(
			Response.json(completeProviderResult),
		);
		await expect(
			workflow.run(event as never, step as never),
		).resolves.toMatchObject({
			deleted: expect.arrayContaining(["hostname", "site"]),
		});
		expect(mocks.findHostname).toHaveBeenCalledWith(
			expect.anything(),
			"blog.example.com",
		);
		expect(mocks.deleteHostname).toHaveBeenCalledWith(
			expect.anything(),
			"legacy-provider",
			"blog.example.com",
		);
	});

	it.each(["blog.tedix.dev", "blog.tedix.tech"])(
		"keeps the platform route for %s while removing the CMS site",
		async (customDomain) => {
			mocks.getSite.mockResolvedValue({
				id: siteId,
				slug: "acme",
				authoringAppId: null,
				customDomain,
			});
			const { workflow, event, step, fetch } = harness(
				Response.json(completeProviderResult),
			);
			await expect(
				workflow.run(event as never, step as never),
			).resolves.toMatchObject({
				deleted: expect.arrayContaining(["durable_object", "site"]),
			});
			expect(mocks.findHostname).not.toHaveBeenCalled();
			expect(mocks.deleteHostname).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledOnce();
			expect(mocks.completeOperation).toHaveBeenCalledWith(
				{},
				expect.objectContaining({
					deleted: expect.not.arrayContaining(["hostname"]),
				}),
			);
		},
	);

	it("does not repeat cleanup for a successful receipt", async () => {
		mocks.getOperation.mockResolvedValue({ ...receipt, status: "succeeded" });
		const { workflow, event, step, fetch } = harness(
			Response.json(completeProviderResult),
		);
		await expect(
			workflow.run(event as never, step as never),
		).resolves.toMatchObject({ status: "succeeded" });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.completeOperation).not.toHaveBeenCalled();
	});
});
