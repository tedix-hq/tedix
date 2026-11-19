import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createCatalogScanFetch,
	externalCatalogScanHeaders,
	resolveCatalogBuilderSite,
} from "./catalog-internal-scan";
import { connectMcpServer } from "./mcp-client";
import { getCatalogBaseApp } from "@tedix/db/queries/apps";
import { listCmsSitesByOrganization } from "@tedix/db/queries/cms-sites";

vi.mock("@tedix/db/queries/apps", () => ({ getCatalogBaseApp: vi.fn() }));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	listCmsSitesByOrganization: vi.fn(),
}));

const token = "platform-scan-token";
const hostSettings = {
	SITE_BUILDER_HOSTNAME: "builder.installation.example",
	CMS_TENANT_HOST_SUFFIX: "cms.installation.example",
	MCP_URL: "https://gateway.installation.example",
	PLATFORM_SERVICE_TOKEN: token,
};

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

describe("catalog scan transport", () => {
	it.each([
		["https://builder.tedix.dev/mcp", "cms", "published-site", null],
		["https://builder.installation.example/mcp", "cms", "published-site", null],
		[
			"https://builder.installation.example/mcp?org=selected",
			"cms",
			"selected",
			null,
		],
		["https://store.cms.installation.example/mcp", "cms", "store", null],
		[
			"https://gateway.installation.example/mcp",
			"mcp",
			null,
			"gateway.installation.example",
		],
		[
			"https://docs.gateway.installation.example/mcp/",
			"mcp",
			null,
			"docs.gateway.installation.example",
		],
	])(
		"signs in over the selected binding for %s",
		async (endpoint, service, label, host) => {
			const cms = vi.fn(
				async (_request: Request) => new Response(null, { status: 401 }),
			);
			const mcp = vi.fn(cms.getMockImplementation()!);
			const publicFetch = vi.fn();
			vi.stubGlobal("fetch", publicFetch);
			const fetchFn = createCatalogScanFetch(
				endpoint,
				{
					...(endpoint.includes(".tedix.dev") ? {} : hostSettings),
					PLATFORM_SERVICE_TOKEN: token,
					CMS: { fetch: cms },
					MCP_SERVICE: { fetch: mcp },
				},
				async () => "published-site",
			);
			await connectMcpServer(endpoint, { fetchFn });
			const selected = service === "cms" ? cms : mcp;
			expect(selected).toHaveBeenCalled();
			for (const [request] of selected.mock.calls) {
				expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
				expect(request.headers.get("X-Service-Binding")).toBe("true");
				expect(request.headers.get("X-Tedix-Connection-Label")).toBe(label);
				expect(request.headers.get("X-Tedix-Host")).toBe(host);
				expect(request.headers.get("X-Tedix-Delegated-Scope")).toBeNull();
				expect(request.headers.get("X-Tedix-Actor-Type")).toBeNull();
				expect(request.headers.get("X-Tedix-Actor-Id")).toBeNull();
			}
			expect(service === "cms" ? mcp : cms).not.toHaveBeenCalled();
			expect(publicFetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://vendor.example/mcp",
		"https://builder.installation.example.vendor.example/mcp",
		"https://vendor.example/mcp?host=builder.installation.example",
		"https://notgateway.installation.example/mcp",
		"https://deep.docs.gateway.installation.example/mcp",
		"https://docs.gateway.installation.example.vendor.example/mcp",
		"https://store.cms.installation.example.vendor.example/mcp",
		"https://builder.tedix.dev/mcp",
		"http://builder.installation.example/mcp",
		"https://builder.installation.example:8443/mcp",
		"https://builder.installation.example/other",
	])(
		"never presents the platform token on public transport to %s",
		async (endpoint) => {
			const publicFetch = vi.fn(
				async (_url: string, _init?: RequestInit) =>
					new Response(null, { status: 401 }),
			);
			vi.stubGlobal("fetch", publicFetch);
			const boundFetch = vi.fn();
			await connectMcpServer(endpoint, {
				fetchFn: createCatalogScanFetch(endpoint, {
					...hostSettings,
					CMS: { fetch: boundFetch },
					MCP_SERVICE: { fetch: boundFetch },
				}),
				headers: externalCatalogScanHeaders(
					{ authorization: `bearer ${token}` },
					token,
				),
			});
			expect(publicFetch).toHaveBeenCalled();
			for (const [, init] of publicFetch.mock.calls) {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBeNull();
				expect(headers.get("X-Service-Binding")).toBeNull();
			}
			expect(boundFetch).not.toHaveBeenCalled();
		},
	);

	it("pins the original endpoint and leaves redirects un-followed", async () => {
		const endpoint = "https://builder.installation.example/mcp?org=sample";
		const binding = vi.fn(
			async (_request: Request) =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://vendor.example/mcp" },
				}),
		);
		const fetch = createCatalogScanFetch(endpoint, {
			...hostSettings,
			CMS: { fetch: binding },
		})!;
		expect((await fetch(endpoint, { redirect: "follow" })).status).toBe(302);
		expect(binding.mock.calls[0]?.[0].redirect).toBe("manual");
		await expect(fetch("https://vendor.example/mcp")).rejects.toThrow(
			"endpoint changed",
		);
		await expect(
			fetch("https://builder.installation.example/mcp?org=other"),
		).rejects.toThrow("endpoint changed");
		expect(binding).toHaveBeenCalledOnce();
	});

	it("fails closed when the service binding is unavailable", async () => {
		const endpoint = "https://builder.installation.example/mcp";
		const publicFetch = vi.fn();
		vi.stubGlobal("fetch", publicFetch);
		const fetch = createCatalogScanFetch(endpoint, hostSettings)!;
		await expect(fetch(endpoint)).rejects.toThrow(
			"binding or platform sign-in is unavailable",
		);
		expect(publicFetch).not.toHaveBeenCalled();
	});

	it("derives the site from the catalog base app owner", async () => {
		vi.mocked(getCatalogBaseApp).mockResolvedValue({
			organizationId: "publisher",
		} as never);
		vi.mocked(listCmsSitesByOrganization).mockResolvedValue([
			{ status: "paused", slug: "retired" },
			{ status: "active", slug: "published-site" },
		] as never);
		const db = {} as never;
		await expect(
			resolveCatalogBuilderSite(db, {
				catalogAppId: "cms",
				organizationId: "scanner",
			}),
		).resolves.toBe("published-site");
		expect(listCmsSitesByOrganization).toHaveBeenCalledExactlyOnceWith(
			db,
			"publisher",
		);
	});
});
