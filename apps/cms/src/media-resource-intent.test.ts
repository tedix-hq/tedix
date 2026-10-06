import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {},
	RpcTarget: class {},
}));
vi.mock("@cloudflare/sandbox", () => ({ DirectoryBackupGateway: class {} }));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {},
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("./agent/deploy-workflow", () => ({
	DeployWorkflow: class {},
	deployStatusKey: vi.fn(),
}));
vi.mock("./agent/image-generation-workflow", () => ({
	ImageGenerationWorkflow: class {},
	imageGenerationStatusKey: vi.fn(),
}));
vi.mock("./container/site-builder-sandbox", () => ({
	SiteBuilderSandboxRuntime: class {},
}));
vi.mock("./sandbox", () => ({ getSiteBuilderSandbox: vi.fn() }));

import app from "./index";

const url = "https://builder.tedix.dev/api/internal/deployments/acme/media";
const authHeaders = {
	Authorization: "Bearer service-secret",
	"X-Tedix-Connection-Label": "acme",
	"X-Tedix-CMS-Site-Id": "11111111-1111-4111-8111-111111111111",
};

describe("private CMS media intent relay", () => {
	it("keeps service authorization ahead of intent validation", async () => {
		const dispatch = { fetch: vi.fn() };
		const env = {
			PLATFORM_SERVICE_TOKEN: "service-secret",
			CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
			CMS_DISPATCH: dispatch,
		};
		expect(
			(
				await app.request(
					url,
					{ method: "POST", headers: { "X-Tedix-CMS-Media-Intent": "create" } },
					env as never,
				)
			).status,
		).toBe(403);
		expect(
			(
				await app.request(
					url,
					{
						method: "POST",
						headers: {
							...authHeaders,
							"X-Tedix-Connection-Label": "other",
							"X-Tedix-CMS-Media-Intent": "create",
						},
					},
					env as never,
				)
			).status,
		).toBe(403);
		expect(dispatch.fetch).not.toHaveBeenCalled();
	});

	it("rejects missing and invalid intent before runtime dispatch", async () => {
		const dispatch = { fetch: vi.fn() };
		const env = {
			PLATFORM_SERVICE_TOKEN: "service-secret",
			CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
			CMS_DISPATCH: dispatch,
		};
		for (const intent of [undefined, "delete", "CREATE"]) {
			const response = await app.request(
				url,
				{
					method: "POST",
					headers: {
						...authHeaders,
						...(intent ? { "X-Tedix-CMS-Media-Intent": intent } : {}),
					},
				},
				env as never,
			);
			expect(response.status).toBe(400);
		}
		expect(dispatch.fetch).not.toHaveBeenCalled();
		const missingSiteId = await app.request(
			url,
			{
				method: "POST",
				headers: {
					Authorization: authHeaders.Authorization,
					"X-Tedix-Connection-Label": "acme",
					"X-Tedix-CMS-Media-Intent": "create",
				},
			},
			env as never,
		);
		expect(missingSiteId.status).toBe(400);
		expect(dispatch.fetch).not.toHaveBeenCalled();
	});

	it("forwards only validated internal intent and leaves GET unchanged", async () => {
		const dispatch = {
			fetch: vi.fn(async (_request: Request) =>
				Response.json({ success: true }),
			),
		};
		const env = {
			PLATFORM_SERVICE_TOKEN: "service-secret",
			CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
			CMS_DISPATCH: dispatch,
		};
		for (const intent of ["create", "repair"]) {
			const response = await app.request(
				url,
				{
					method: "POST",
					headers: {
						...authHeaders,
						"X-Tedix-CMS-Media-Intent": intent,
						"X-Forwarded-Authorization": "Bearer user-secret",
					},
				},
				env as never,
			);
			expect(response.status).toBe(200);
		}
		const get = await app.request(url, { headers: authHeaders }, env as never);
		expect(get.status).toBe(200);
		const requests = dispatch.fetch.mock.calls.map(
			([request]) => request as Request,
		);
		expect(
			requests.map((request) =>
				request.headers.get("X-Tedix-CMS-Media-Intent"),
			),
		).toEqual(["create", "repair", null]);
		for (const request of requests) {
			if (request.method === "POST")
				expect(request.headers.get("X-Tedix-CMS-Site-Id")).toBe(
					authHeaders["X-Tedix-CMS-Site-Id"],
				);
			expect(request.headers.get("X-Tedix-CMS-Internal-Auth")).toBe(
				"runtime-secret",
			);
			expect(request.headers.get("Authorization")).toBeNull();
			expect(request.headers.get("X-Forwarded-Authorization")).toBeNull();
		}
	});
});
