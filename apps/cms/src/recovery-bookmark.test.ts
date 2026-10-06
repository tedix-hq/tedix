import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {},
	RpcTarget: class {},
}));
vi.mock("@cloudflare/sandbox", () => ({ DirectoryBackupGateway: class {} }));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {},
}));

const storage = vi.hoisted(() => ({ getCmsTemplateSelection: vi.fn() }));
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

describe("private CMS recovery bookmark relay", () => {
	beforeEach(() => {
		storage.getCmsTemplateSelection.mockReset();
		storage.getCmsTemplateSelection.mockResolvedValue({
			organizationId: "org-1",
			blogTemplateSlug: "marketing",
			metaTemplateSlug: null,
		});
	});

	it("requires a service token bound to the exact site slug", async () => {
		const dispatch = { fetch: vi.fn() };
		const env = {
			PLATFORM_SERVICE_TOKEN: "service-secret",
			CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
			CMS_DISPATCH: dispatch,
		};
		const url =
			"https://builder.tedix.dev/api/internal/deployments/acme/recovery-bookmark";
		const denied = await app.request(url, { method: "POST" }, env as never);
		expect(denied.status).toBe(403);
		const mismatched = await app.request(
			url,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"X-Tedix-Connection-Label": "other",
				},
			},
			env as never,
		);
		expect(mismatched.status).toBe(403);
		expect(storage.getCmsTemplateSelection).not.toHaveBeenCalled();
		expect(dispatch.fetch).not.toHaveBeenCalled();
	});

	it("requires an active site before relaying to the runtime", async () => {
		storage.getCmsTemplateSelection.mockResolvedValueOnce(null);
		const dispatch = { fetch: vi.fn() };
		const response = await app.request(
			"https://builder.tedix.dev/api/internal/deployments/acme/recovery-bookmark",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"X-Tedix-Connection-Label": "acme",
				},
			},
			{
				PLATFORM_SERVICE_TOKEN: "service-secret",
				CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
				CMS_DISPATCH: dispatch,
			} as never,
		);
		expect(response.status).toBe(404);
		expect(dispatch.fetch).not.toHaveBeenCalled();
	});

	it("sends only the internal token to the exact-slug runtime route", async () => {
		const dispatch = {
			fetch: vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ ok: true },
						{ headers: { "Cache-Control": "public, max-age=60" } },
					),
				),
		};
		const response = await app.request(
			"https://builder.tedix.dev/api/internal/deployments/acme/recovery-bookmark",
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
		const relayed = dispatch.fetch.mock.calls[0]?.[0] as Request;
		expect(relayed.url).toBe(
			"https://acme.cms.tedix.dev/_tedix/internal/database-runtime/recovery-bookmark",
		);
		expect(relayed.method).toBe("POST");
		expect(relayed.headers.get("X-Tedix-CMS-Internal-Auth")).toBe(
			"runtime-secret",
		);
		expect(relayed.headers.get("Authorization")).toBeNull();
		expect(relayed.headers.get("X-Forwarded-Authorization")).toBeNull();
	});
});
