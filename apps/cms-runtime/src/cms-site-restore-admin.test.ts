import { describe, expect, it, vi } from "vite-plus/test";

const dependencies = vi.hoisted(() => ({
	getCmsSiteBySlug: vi.fn(),
	readRecoveryAuthority: vi.fn(),
	readVerifiedCmsRecoveryCapture: vi.fn(),
}));
vi.mock("@tedix/db/queries/cms-sites", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/cms-sites")>()),
	getCmsSiteBySlug: dependencies.getCmsSiteBySlug,
}));
vi.mock("./cms-recovery-workflow", async (importOriginal) => ({
	...(await importOriginal<typeof import("./cms-recovery-workflow")>()),
	readRecoveryAuthority: dependencies.readRecoveryAuthority,
	readVerifiedCmsRecoveryCapture: dependencies.readVerifiedCmsRecoveryCapture,
}));

import { cmsSiteRestoreAdminResponse } from "./index";

const siteId = "13d1b0d0-2664-4006-981b-d27af4e73794";
const captureId = "8b7637c1-39b2-41ba-9bac-33fc7e19be7b";
const slug = "restore-proof";
const url = new URL(
	`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/site-restores?siteId=${siteId}`,
);

function harness(mode: "restore" | "roundtrip" = "roundtrip") {
	const objects = new Map<string, { value: string; etag: string }>();
	const create = vi.fn(async () => ({}));
	const env = {
		CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
		PLATFORM_DB: {},
		RECOVERY_STORAGE: {
			list: vi.fn(async ({ prefix }: { prefix: string }) => ({
				objects: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
				truncated: false,
			})),
			get: vi.fn(async (key: string) => {
				const object = objects.get(key);
				return object
					? { etag: object.etag, json: async () => JSON.parse(object.value) }
					: null;
			}),
			put: vi.fn(async (key: string, value: string) => {
				if (objects.has(key)) return null;
				objects.set(key, { value, etag: "etag-1" });
				return { etag: "etag-1" };
			}),
		},
		CMS_SITE_RESTORE_WORKFLOW: { create },
	};
	const request = new Request(url, {
		method: "POST",
		headers: {
			"X-Tedix-CMS-Internal-Auth": "internal-secret",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ siteId, captureId, mode }),
	});
	dependencies.getCmsSiteBySlug.mockResolvedValue({
		id: siteId,
		slug,
		status: "active",
	});
	dependencies.readRecoveryAuthority.mockResolvedValue({
		siteId,
		bundle: { version: 7, etag: "bundle-etag" },
	});
	dependencies.readVerifiedCmsRecoveryCapture.mockResolvedValue({
		manifest: {
			version: 2,
			digestAlgorithm: "cms-site-sqlite-v2",
			bundle: { version: 7, etag: "bundle-etag" },
			bookmark: "private-bookmark",
		},
		records: [],
	});
	return { env, request, create, objects };
}

describe("CMS site restore service admission", () => {
	it("lists private receipts and preflights a capture without mutating it", async () => {
		const h = harness();
		const started = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: h.request,
			slug,
			url,
		});
		const startedBody = (await started?.json()) as { generation: string };
		const listUrl = new URL(url);
		listUrl.searchParams.set("list", "1");
		const listed = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: new Request(listUrl, {
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
			}),
			slug,
			url: listUrl,
		});
		expect(await listed?.json()).toMatchObject({
			ok: true,
			receipts: [{ generation: startedBody.generation, phase: "claimed" }],
		});
		const preflightUrl = new URL(url);
		preflightUrl.searchParams.set("preflightCaptureId", captureId);
		const preflight = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: new Request(preflightUrl, {
				headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
			}),
			slug,
			url: preflightUrl,
		});
		expect(await preflight?.json()).toEqual({ ok: true, restorable: true });
		expect(h.objects.size).toBe(1);
	});

	it("claims one private generation and returns only sanitized owner status", async () => {
		const h = harness();
		const response = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: h.request,
			slug,
			url,
		});
		expect(response?.status).toBe(202);
		const body = (await response?.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			ok: true,
			siteId,
			captureId,
			phase: "claimed",
		});
		expect(JSON.stringify(body)).not.toContain("private-bookmark");
		expect(h.create).toHaveBeenCalledWith({
			id: `${siteId}-${body.generation}`,
			params: {
				siteId,
				slug,
				captureId,
				generation: body.generation,
				mode: "roundtrip",
			},
		});
		expect([...h.objects.keys()]).toEqual([
			`recovery/restores/${siteId}/${body.generation}/receipt.json`,
		]);
	});

	it("refuses missing service auth and a v1-only capture before claiming", async () => {
		const h = harness("restore");
		const unauthorized = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: new Request(url, { method: "POST" }),
			slug,
			url,
		});
		expect(unauthorized?.status).toBe(401);
		dependencies.readVerifiedCmsRecoveryCapture.mockResolvedValue({
			manifest: { version: 1, bundle: { version: 7, etag: "bundle-etag" } },
			records: [],
		});
		const rejected = await cmsSiteRestoreAdminResponse({
			env: h.env as never,
			request: h.request,
			slug,
			url,
		});
		expect(rejected?.status).toBe(409);
		expect(h.create).not.toHaveBeenCalled();
		expect(h.objects.size).toBe(0);
	});
});
