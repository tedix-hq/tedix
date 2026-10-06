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

const storage = vi.hoisted(() => ({
	getCmsTemplateSelection: vi.fn(),
}));
vi.mock("./agent/storage", () => storage);
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

const SITE_ID = "11111111-1111-4111-8111-111111111111";

describe("private CMS recovery capture relay", () => {
	it("requires exact service label and site ID", async () => {
		const dispatch = { fetch: vi.fn() };
		const env = {
			PLATFORM_SERVICE_TOKEN: "service-secret",
			CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
			CMS_DISPATCH: dispatch,
		};
		const url =
			"https://builder.tedix.dev/api/internal/deployments/acme/recovery-captures?siteId=invalid";
		const denied = await app.request(url, { method: "POST" }, env as never);
		expect(denied.status).toBe(403);
		const mismatch = await app.request(
			url,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"X-Tedix-Connection-Label": "acme",
				},
			},
			env as never,
		);
		expect(mismatch.status).toBe(400);
		expect(dispatch.fetch).not.toHaveBeenCalled();
	});

	it("relays only the internal token and no user headers", async () => {
		const dispatch = {
			fetch: vi.fn(async () => Response.json({ ok: true, status: "queued" })),
		};
		const response = await app.request(
			`https://builder.tedix.dev/api/internal/deployments/acme/recovery-captures?siteId=${SITE_ID}`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"X-Tedix-Connection-Label": "acme",
					"X-Forwarded-Authorization": "Bearer user-secret",
				},
			},
			{
				PLATFORM_SERVICE_TOKEN: "service-secret",
				CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
				CMS_DISPATCH: dispatch,
			} as never,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const relayed = (dispatch.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as Request;
		expect(relayed.url).toContain(
			"https://acme.cms.tedix.dev/_tedix/internal/database-runtime/recovery-captures",
		);
		expect(relayed.headers.get("X-Tedix-CMS-Internal-Auth")).toBe(
			"runtime-secret",
		);
		expect(relayed.headers.get("Authorization")).toBeNull();
		expect(relayed.headers.get("X-Forwarded-Authorization")).toBeNull();
	});
});

describe("private CMS site restore relay", () => {
	it("forwards the exact restore request body with only service authentication", async () => {
		const dispatch = {
			fetch: vi.fn(async (_request: Request) =>
				Response.json({ ok: true, phase: "claimed" }),
			),
		};
		const body = JSON.stringify({
			siteId: SITE_ID,
			captureId: "22222222-2222-4222-8222-222222222222",
			mode: "roundtrip",
		});
		const response = await app.request(
			`https://builder.tedix.dev/api/internal/deployments/acme/site-restores?siteId=${SITE_ID}`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"X-Tedix-Connection-Label": "acme",
					"Content-Type": "application/json",
					"X-Forwarded-Authorization": "Bearer user-secret",
				},
				body,
			},
			{
				PLATFORM_SERVICE_TOKEN: "service-secret",
				CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
				CMS_DISPATCH: dispatch,
			} as never,
		);
		expect(response.status).toBe(200);
		const relayed = dispatch.fetch.mock.calls[0]?.[0] as Request;
		expect(relayed.url).toContain(
			"https://acme.cms.tedix.dev/_tedix/internal/database-runtime/site-restores",
		);
		expect(await relayed.text()).toBe(body);
		expect(relayed.headers.get("X-Tedix-CMS-Internal-Auth")).toBe(
			"runtime-secret",
		);
		expect(relayed.headers.get("Authorization")).toBeNull();
		expect(relayed.headers.get("X-Forwarded-Authorization")).toBeNull();
	});
});
