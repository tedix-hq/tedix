import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getSiteBySlug: vi.fn(),
	getSiteByAlias: vi.fn(),
	permit: vi.fn(),
}));

vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteBySlug: mocks.getSiteBySlug,
	getCmsSiteByActiveWwwAlias: mocks.getSiteByAlias,
	getCmsSiteByHostname: vi.fn(),
}));
vi.mock("./tenant-restore-fence", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tenant-restore-fence")>()),
	withCmsRestoreResponsePermit: mocks.permit,
}));

import cmsRuntime from "./index";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSiteBySlug.mockResolvedValue({
		id: "site-1",
		slug: "tedix-landing",
	});
	mocks.getSiteByAlias.mockResolvedValue(null);
	mocks.permit.mockResolvedValue({ admitted: false });
});

describe("early public restore gate", () => {
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
			{ siteId: "site-1", slug: "tedix-landing" },
			expect.any(Function),
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
