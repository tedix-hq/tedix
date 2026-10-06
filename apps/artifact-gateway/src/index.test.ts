import { describe, expect, it, vi } from "vite-plus/test";

import { handleArtifactGatewayRequest } from "./index";

function gateway(fetch: (request: Request) => Promise<Response>) {
	return {
		API_SERVICE: { fetch },
		GIT_SHA: "test-sha",
	} as unknown as Pick<Cloudflare.Env, "API_SERVICE" | "GIT_SHA">;
}

describe("artifact gateway", () => {
	it("reports the exact deployed SHA without forwarding authority", async () => {
		const fetch = vi.fn(async () => new Response("unexpected"));
		const response = await handleArtifactGatewayRequest(
			new Request(
				"https://artifacts.example/health?_tedix_deploy_proof=unique",
			),
			gateway(fetch),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Tedix-Git-Sha")).toBe("test-sha");
		expect(await response.json()).toEqual({
			deployedSha: "test-sha",
			service: "artifact-gateway",
			status: "ok",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		"https://artifacts.example/artifacts/s/tedi-1/artifact-1?exp=1&token=x",
		"https://artifacts.example/artifacts/s/tedi-1/artifact-1/index.html?exp=1&token=x",
		"https://artifacts.example/skill-media/run-1/image.png?exp=1&token=x",
	])("forwards only signed byte route %s", async (url) => {
		const fetch = vi.fn(async () => new Response("bytes", { status: 200 }));
		const response = await handleArtifactGatewayRequest(
			new Request(url),
			gateway(fetch),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Tedix-Git-Sha")).toBe("test-sha");
		expect(await response.text()).toBe("bytes");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect((fetch.mock.calls[0]?.[0] as Request).url).toBe(url);
	});

	it.each([
		"https://artifacts.example/",
		"https://artifacts.example/rpc/osWorkspaces/list",
		"https://artifacts.example/artifacts/tedi-1/artifact-1",
		"https://artifacts.example/artifacts/s/tedi-1",
		"https://artifacts.example/skill-runs/run-1/media/image.png",
		"https://artifacts.example/skill-media/run-1",
	])("refuses every non-signed route %s", async (url) => {
		const fetch = vi.fn(async () => new Response("unexpected"));
		const response = await handleArtifactGatewayRequest(
			new Request(url),
			gateway(fetch),
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("X-Tedix-Git-Sha")).toBe("test-sha");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses mutations even when the path has a signed shape", async () => {
		const fetch = vi.fn(async () => new Response("unexpected"));
		const response = await handleArtifactGatewayRequest(
			new Request(
				"https://artifacts.example/artifacts/s/tedi-1/artifact-1?exp=1&token=x",
				{ method: "POST", body: "write" },
			),
			gateway(fetch),
		);

		expect(response.status).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not allow non-GET methods on health", async () => {
		const fetch = vi.fn(async () => new Response("unexpected"));
		const response = await handleArtifactGatewayRequest(
			new Request("https://artifacts.example/health", { method: "POST" }),
			gateway(fetch),
		);

		expect(response.status).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("strips every ambient authority header before the service binding", async () => {
		let forwarded: Request | undefined;
		const response = await handleArtifactGatewayRequest(
			new Request(
				"https://artifacts.example/artifacts/s/tedi-1/artifact-1?exp=1&token=x",
				{
					headers: {
						Authorization: "Bearer secret",
						Cookie: "DS=session; DSR=refresh",
						"Proxy-Authorization": "Basic secret",
						"X-API-Key": "sk_secret",
						"X-Service-Binding": "forged",
						"X-Tedix-External-Agent-Principal-Id": "agent-secret",
						"X-Tedix-Org-Id": "org-secret",
						"X-Tedix-Service-Binding": "forged",
						"X-Tedix-Tedi-Id": "tedi-secret",
						"X-Tedix-Tedi-Scopes": "admin",
						"X-Tedix-Tenant-Id": "tenant-secret",
						"X-Trace-Id": "trace-safe",
					},
				},
			),
			gateway(async (request) => {
				forwarded = request;
				return new Response("bytes");
			}),
		);

		expect(response.status).toBe(200);
		expect(forwarded).toBeDefined();
		for (const name of [
			"Authorization",
			"Cookie",
			"Proxy-Authorization",
			"X-API-Key",
			"X-Service-Binding",
			"X-Tedix-External-Agent-Principal-Id",
			"X-Tedix-Org-Id",
			"X-Tedix-Service-Binding",
			"X-Tedix-Tedi-Id",
			"X-Tedix-Tedi-Scopes",
			"X-Tedix-Tenant-Id",
		]) {
			expect(forwarded?.headers.has(name)).toBe(false);
		}
		expect(forwarded?.headers.get("X-Trace-Id")).toBe("trace-safe");
	});

	it("strips authority-bearing response headers without buffering the body", async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("streamed"));
				controller.close();
			},
		});
		const response = await handleArtifactGatewayRequest(
			new Request(
				"https://artifacts.example/skill-media/run-1/file.bin?exp=1&token=x",
			),
			gateway(
				async () =>
					new Response(body, {
						headers: {
							"Access-Control-Allow-Credentials": "true",
							"Content-Type": "application/octet-stream",
							"Set-Cookie": "DS=secret",
						},
					}),
			),
		);

		expect(response.headers.has("Set-Cookie")).toBe(false);
		expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
			false,
		);
		expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
			"cross-origin",
		);
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(await response.text()).toBe("streamed");
	});
});
