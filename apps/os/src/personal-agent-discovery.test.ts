// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
	handleOsRequest,
	type OsRouterEnv,
	type TenantResolver,
} from "./worker";

const document = {
	protocol_version: "1.0",
	organization: { name: "Alpha", domain: "alpha.os.tedix.dev" },
	auth: { disabled: true },
	apis: [
		{
			type: "mcp",
			url: "https://mcp.example.com/mcp",
			description: "Shared work",
		},
	],
};
const resolver: TenantResolver = async () => ({
	provisioned: true,
	organizationId: "org-alpha",
	descopeTenantId: "tenant-alpha",
});
function env(result: unknown = document, status = 200): OsRouterEnv {
	return {
		ASSETS: { fetch: async () => new Response("shell") },
		API_SERVICE: {
			fetch: async (request: Request) => {
				expect(request.url).toContain("osTenant/personalAgentDiscovery");
				expect(request.headers.get("X-Service-Binding")).toBe("true");
				expect(await request.json()).toEqual({
					json: {
						organizationId: "org-alpha",
						hostname: document.organization.domain,
					},
				});
				return Response.json({ json: result }, { status });
			},
		},
	};
}
const url = "https://alpha.os.tedix.dev/.well-known/poppy.json";
describe("public organization discovery", () => {
	it("serves JSON without a login or redirect, including HEAD", async () => {
		const response = await handleOsRequest(new Request(url), env(), resolver);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.json()).toEqual(document);
		const head = await handleOsRequest(
			new Request(url, { method: "HEAD" }),
			env(),
			resolver,
		);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});
	it("returns 404 for missing configuration and 503 for API failure", async () => {
		expect(
			(await handleOsRequest(new Request(url), env(null), resolver)).status,
		).toBe(404);
		expect(
			(await handleOsRequest(new Request(url), env(null, 503), resolver))
				.status,
		).toBe(503);
	});
	it("never serves the shell or another organization's document on the launcher or unprovisioned host", async () => {
		expect(
			(
				await handleOsRequest(
					new Request("https://os.tedix.dev/.well-known/poppy.json"),
					env(),
					resolver,
				)
			).status,
		).toBe(404);
		expect(
			(
				await handleOsRequest(new Request(url), env(), async () => ({
					provisioned: false,
				}))
			).status,
		).toBe(404);
	});
	it("refuses writes", async () => {
		const response = await handleOsRequest(
			new Request(url, { method: "POST" }),
			env(),
			resolver,
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
	});
});
