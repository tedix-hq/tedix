import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getSiteBySlug: vi.fn(),
	getSiteByAlias: vi.fn(),
	getBundle: vi.fn(),
	permit: vi.fn(),
}));

vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteBySlug: mocks.getSiteBySlug,
	getCmsSiteByActiveWwwAlias: mocks.getSiteByAlias,
	getCmsSiteByHostname: vi.fn(),
}));
vi.mock("@tedix/db/queries/tenant-bundles", () => ({
	getActiveTenantBundle: mocks.getBundle,
	listActiveTenantBundles: vi.fn(),
}));
vi.mock("./tenant-restore-fence", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tenant-restore-fence")>()),
	withCmsRestoreResponsePermit: mocks.permit,
}));

import cmsRuntime from "./index";
import { publicRestorePermitEligible } from "./public-restore-permits";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSiteBySlug.mockResolvedValue({
		id: "site-1",
		slug: "tedix-landing",
		restoreEpoch: 7,
	});
	mocks.getSiteByAlias.mockResolvedValue(null);
	mocks.getBundle.mockResolvedValue(null);
	mocks.permit.mockResolvedValue({ admitted: false });
});

describe("early public restore gate", () => {
	it("overlaps fresh metadata reads and still refuses content behind a closed fence", async () => {
		let resolveSite!: (site: {
			id: string;
			slug: string;
			restoreEpoch: number;
		}) => void;
		let resolveBundle!: (bundle: null) => void;
		mocks.getSiteBySlug.mockReturnValue(
			new Promise((resolve) => {
				resolveSite = resolve;
			}),
		);
		mocks.getBundle.mockReturnValue(
			new Promise((resolve) => {
				resolveBundle = resolve;
			}),
		);
		const loader = vi.fn();
		const response = cmsRuntime.fetch(
			new Request("https://tenant.cms.tedix.dev/"),
			{
				PLATFORM_DB: {},
				ENVIRONMENT: "production",
				LOADER: { get: loader },
			} as never,
			{} as never,
		);
		await vi.waitFor(() => {
			expect(mocks.getSiteBySlug).toHaveBeenCalledTimes(1);
			expect(mocks.getBundle).toHaveBeenCalledTimes(1);
		});
		expect(mocks.permit).not.toHaveBeenCalled();
		resolveSite({ id: "site-1", slug: "tenant", restoreEpoch: 7 });
		resolveBundle(null);
		expect((await response).status).toBe(503);
		expect(mocks.permit).toHaveBeenCalledTimes(1);
		expect(loader).not.toHaveBeenCalled();
	});

	it.each([
		"/",
		"/.well-known/security.txt",
		"/_astro/site.js",
		"/_image?href=%2Fhero.png",
		"/_tedix/webmcp/mcp",
		"/_tedix/internal/unrecognized",
	])("checks the exact site before public path %s", async (path) => {
		const response = await cmsRuntime.fetch(
			new Request(`https://tedix.dev${path}`),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(mocks.permit).toHaveBeenCalledWith(
			expect.anything(),
			{ siteId: "site-1", slug: "tedix-landing", restoreEpoch: 7 },
			expect.any(Function),
			undefined,
			publicRestorePermitEligible(new Request(`https://tedix.dev${path}`))
				? expect.objectContaining({
						enter: expect.any(Function),
						leave: expect.any(Function),
					})
				: undefined,
			publicRestorePermitEligible(new Request(`https://tedix.dev${path}`))
				? expect.any(Function)
				: undefined,
			expect.any(Request),
		);
	});

	it("fails closed if the marketing site identity is unavailable", async () => {
		mocks.getSiteBySlug.mockResolvedValue(null);
		const response = await cmsRuntime.fetch(
			new Request("https://tedix.dev/"),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(mocks.permit).not.toHaveBeenCalled();
	});

	it("answers 404, not a restore message, for an unclaimed platform subdomain", async () => {
		mocks.getSiteBySlug.mockResolvedValue(null);
		const response = await cmsRuntime.fetch(
			new Request("https://no-such-site.cms.tedix.dev/"),
			{ PLATFORM_DB: {}, ENVIRONMENT: "production" } as never,
			{} as never,
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("CMS site not found");
		expect(mocks.permit).not.toHaveBeenCalled();
	});

	it("passes the marketing slug through the admitted public route", async () => {
		mocks.permit.mockImplementation(async (_db, _identity, run) => ({
			admitted: true,
			value: await run(),
		}));
		const response = await cmsRuntime.fetch(
			new Request("https://tedix.dev/"),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("missing CF_ACCOUNT_ID");
	});
});
