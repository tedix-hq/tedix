import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getSiteByActiveWwwAlias: vi.fn(),
	getSiteByHostname: vi.fn(),
	createDb: vi.fn(() => ({})),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: mocks.createDb }));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteByActiveWwwAlias: mocks.getSiteByActiveWwwAlias,
	getCmsSiteByHostname: mocks.getSiteByHostname,
	getCmsSiteBySlug: vi.fn(),
}));

import cmsRuntime from "./index";

beforeEach(() => vi.clearAllMocks());

describe("CMS custom hostname routing", () => {
	it("does not serve a removed hostname from an isolate cache", async () => {
		mocks.getSiteByHostname
			.mockResolvedValueOnce({ slug: "alpha" })
			.mockResolvedValueOnce(null);
		const env = {
			ENVIRONMENT: "production",
			PLATFORM_DB: {},
		} as never;
		const request = new Request("https://blog.example.com/");
		const first = await cmsRuntime.fetch(request, env, {} as never);
		// The first request resolved the hostname, then stopped at missing test
		// provider bindings before loading the tenant bundle.
		expect(first.status).toBe(503);
		const removed = await cmsRuntime.fetch(request, env, {} as never);
		expect(removed.status).toBe(404);
		expect(mocks.getSiteByHostname).toHaveBeenCalledTimes(2);
	});

	it("redirects a verified www companion to its current apex with path and query", async () => {
		mocks.getSiteByActiveWwwAlias.mockResolvedValue({
			customDomain: "example.com",
		});
		const env = { PLATFORM_DB: {} } as never;
		for (const method of ["GET", "HEAD"]) {
			const response = await cmsRuntime.fetch(
				new Request("https://www.example.com/about/team?src=mail&v=2", {
					method,
				}),
				env,
				{} as never,
			);
			expect(response.status).toBe(301);
			expect(response.headers.get("location")).toBe(
				"https://example.com/about/team?src=mail&v=2",
			);
		}
		expect(mocks.getSiteByActiveWwwAlias).toHaveBeenCalledTimes(2);
		expect(mocks.getSiteByHostname).not.toHaveBeenCalled();
	});

	it("reads the companion mapping again after removal", async () => {
		mocks.getSiteByActiveWwwAlias
			.mockResolvedValueOnce({ customDomain: "example.com" })
			.mockResolvedValueOnce(null);
		const env = { PLATFORM_DB: {} } as never;
		const request = new Request("https://www.example.com/posts/one?draft=0");
		const active = await cmsRuntime.fetch(request, env, {} as never);
		const removed = await cmsRuntime.fetch(request, env, {} as never);
		expect(active.status).toBe(301);
		expect(removed.status).toBe(404);
		expect(mocks.getSiteByActiveWwwAlias).toHaveBeenCalledTimes(2);
	});

	it.each([
		"/_emdash/admin",
		"/_emdash/api/auth/session-broker/start",
		"/_tedix/webmcp/mcp",
		"/_astro/site.js",
		"/_image",
		"/api/session",
		"/auth/callback",
		"/admin",
		"/login",
		"/.well-known/openid-configuration",
		"/%5Femdash/admin",
	])("does not redirect an editor or service path: %s", async (path) => {
		const response = await cmsRuntime.fetch(
			new Request(`https://www.example.com${path}`),
			{ ENVIRONMENT: "production", PLATFORM_DB: {} } as never,
			{} as never,
		);
		expect(response.status).toBe(404);
		expect(mocks.getSiteByActiveWwwAlias).not.toHaveBeenCalled();
	});

	it("does not redirect non-GET requests", async () => {
		const response = await cmsRuntime.fetch(
			new Request("https://www.example.com/posts/one", { method: "POST" }),
			{ ENVIRONMENT: "production", PLATFORM_DB: {} } as never,
			{} as never,
		);
		expect(response.status).toBe(404);
		expect(mocks.getSiteByActiveWwwAlias).not.toHaveBeenCalled();
	});
});
