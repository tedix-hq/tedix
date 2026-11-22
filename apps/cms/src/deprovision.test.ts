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

const authority = vi.hoisted(() => ({
	hasExactCmsDeprovisionAuthority: vi.fn(),
}));
const artifacts = vi.hoisted(() => ({ readThemeArtifactHead: vi.fn() }));
vi.mock("./agent/artifact-source-read", () => artifacts);
const provisioning = vi.hoisted(() => ({ deprovisionCms: vi.fn() }));
const sandbox = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock("./agent/cms-restore-permit", () => authority);
vi.mock("@tedix/provisioning/cms", () => provisioning);
vi.mock("./sandbox", () => ({ getSiteBuilderSandbox: () => sandbox }));
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

import app from "./index";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const URL = "https://builder.tedix.dev/api/internal/deployments/acme";
const HEADERS = {
	Authorization: "Bearer service-secret",
	"X-Tedix-Connection-Label": "acme",
	"X-Tedix-CMS-Site-Id": SITE_ID,
};

function fixture() {
	const keys = new Set([
		"hot-themes/acme/current.css",
		"cms-builds/acme/build.json",
		"themes/acme/staging/old/file.mjs",
		`themes/deploy-status/cms-${SITE_ID}-v12.json`,
		"themes/deploy-status/cms-22222222-2222-4222-8222-222222222222-v1.json",
	]);
	const storage = {
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({
			objects: [...keys]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		})),
		delete: vi.fn(async (keyOrKeys: string | string[]) => {
			for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys])
				keys.delete(key);
		}),
	};
	const dispatch = {
		fetch: vi.fn(async (request: Request) =>
			request.url.endsWith("/media-bucket")
				? Response.json({ success: true, deleted: true })
				: Response.json({ success: true }),
		),
	};
	const env = {
		PLATFORM_SERVICE_TOKEN: "service-secret",
		CMS_INTERNAL_AUTH_TOKEN: "runtime-secret",
		CMS_DISPATCH: dispatch,
		SITE_BUILDER_STORAGE: storage,
		BUNDLES_BUCKET: {},
		ARTIFACTS: {},
		DB: {},
	};
	return { env, storage, dispatch };
}

describe("private CMS deprovision endpoint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authority.hasExactCmsDeprovisionAuthority.mockResolvedValue(true);
		provisioning.deprovisionCms.mockImplementation(
			async (_bindings, _slug, deleteMedia) => {
				await deleteMedia();
				return { errors: [], deletedR2: true, deletedBundles: 2 };
			},
		);
	});

	it("rejects absent, malformed, and stale identities before any provider effect", async () => {
		const { env, dispatch, storage } = fixture();
		const missing = await app.request(
			URL,
			{
				method: "DELETE",
				headers: {
					Authorization: HEADERS.Authorization,
					"X-Tedix-Connection-Label": "acme",
				},
			},
			env as never,
		);
		expect(missing.status).toBe(400);
		const malformed = await app.request(
			URL,
			{
				method: "DELETE",
				headers: { ...HEADERS, "X-Tedix-CMS-Site-Id": "old-site" },
			},
			env as never,
		);
		expect(malformed.status).toBe(400);
		authority.hasExactCmsDeprovisionAuthority.mockResolvedValueOnce(false);
		const stale = await app.request(
			URL,
			{ method: "DELETE", headers: HEADERS },
			env as never,
		);
		expect(stale.status).toBe(409);
		authority.hasExactCmsDeprovisionAuthority.mockRejectedValueOnce(
			new Error("D1 unavailable"),
		);
		const unavailable = await app.request(
			URL,
			{ method: "DELETE", headers: HEADERS },
			env as never,
		);
		expect(unavailable.status).toBe(503);
		expect(dispatch.fetch).not.toHaveBeenCalled();
		expect(provisioning.deprovisionCms).not.toHaveBeenCalled();
		expect(storage.list).not.toHaveBeenCalled();
		expect(sandbox.destroy).not.toHaveBeenCalled();
	});

	it("passes exact site ID to runtime and purges staging plus site-owned deploy status", async () => {
		const { env, dispatch, storage } = fixture();
		const response = await app.request(
			URL,
			{ method: "DELETE", headers: HEADERS },
			env as never,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			deletedSiteBuilderObjects: 4,
		});
		expect(authority.hasExactCmsDeprovisionAuthority).toHaveBeenCalledWith(
			env.DB,
			{ siteId: SITE_ID, slug: "acme" },
		);
		expect(dispatch.fetch).toHaveBeenCalledTimes(2);
		for (const [request] of dispatch.fetch.mock.calls) {
			expect(request.headers.get("X-Tedix-CMS-Site-Id")).toBe(SITE_ID);
		}
		expect(storage.list).toHaveBeenCalledWith({
			prefix: "themes/acme/staging/",
		});
		expect(storage.list).toHaveBeenCalledWith({
			prefix: `themes/deploy-status/cms-${SITE_ID}-v`,
		});
		const deleted = storage.delete.mock.calls.flatMap(([keyOrKeys]) =>
			Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys],
		);
		expect(deleted).toContain("themes/acme/staging/old/file.mjs");
		expect(deleted).toContain(`themes/deploy-status/cms-${SITE_ID}-v12.json`);
		expect(deleted).not.toContain(
			"themes/deploy-status/cms-22222222-2222-4222-8222-222222222222-v1.json",
		);
		expect(sandbox.destroy).toHaveBeenCalledOnce();
	});
});

describe("private CMS resource inspection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it("reads canonical theme source without modifying site or build storage", async () => {
		const { env, storage, dispatch } = fixture();
		artifacts.readThemeArtifactHead.mockResolvedValue({
			branch: "main",
			sourceCommit: "a".repeat(40),
		});
		const response = await app.request(
			`${URL}/resources`,
			{ headers: HEADERS },
			env as never,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			theme: { identifier: "cms-theme-acme", state: "present" },
		});
		expect(artifacts.readThemeArtifactHead).toHaveBeenCalledWith({
			orgSlug: "acme",
			artifacts: env.ARTIFACTS,
		});
		expect(storage.delete).not.toHaveBeenCalled();
		expect(sandbox.destroy).not.toHaveBeenCalled();
		expect(provisioning.deprovisionCms).not.toHaveBeenCalled();
		expect(dispatch.fetch.mock.calls[0]?.[0].method).toBe("GET");
	});
	it("preserves unknown when the theme provider is unavailable", async () => {
		const { env } = fixture();
		artifacts.readThemeArtifactHead.mockRejectedValue(
			new Error("provider unavailable"),
		);
		const response = await app.request(
			`${URL}/resources`,
			{ headers: HEADERS },
			env as never,
		);
		expect(await response.json()).toMatchObject({
			theme: { state: "unknown", error: "provider unavailable" },
		});
	});
	it("rejects a mismatched site label before reading Artifacts", async () => {
		const { env } = fixture();
		const response = await app.request(
			`${URL}/resources`,
			{ headers: { ...HEADERS, "X-Tedix-Connection-Label": "other" } },
			env as never,
		);
		expect(response.status).toBe(403);
		expect(artifacts.readThemeArtifactHead).not.toHaveBeenCalled();
	});
});
