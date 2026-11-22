import { describe, expect, it, vi } from "vite-plus/test";
import { readCmsBundle } from "@tedix/provisioning/cms-bundle";
import {
	listThemeCandidatePreviews,
	readThemeCandidate,
	stageThemeCandidate,
} from "./theme-candidate";
import { cleanupStagedBundle } from "./deploy-staging";
import type { AppBindings } from "../types";

function bucket() {
	const objects = new Map<string, ArrayBuffer>();
	return {
		objects,
		delete: vi.fn(async (keys: string[]) => {
			for (const key of keys) objects.delete(key);
		}),
		put: vi.fn(async (key: string, value: string | ArrayBuffer) => {
			objects.set(
				key,
				typeof value === "string"
					? new TextEncoder().encode(value).buffer
					: value,
			);
		}),
		get: vi.fn(async (key: string) => {
			const value = objects.get(key);
			return value
				? {
						body: new Blob([value]).stream(),
						text: async () => new TextDecoder().decode(value),
						json: async () => JSON.parse(new TextDecoder().decode(value)),
						arrayBuffer: async () => value,
					}
				: null;
		}),
	};
}

describe("CMS theme candidate staging", () => {
	it("retains the exact compiled modules and assets without touching active rows or live assets", async () => {
		const staging = bucket();
		const bundles = bucket();
		const sourceCommit = "a".repeat(40);
		const prefix = "themes/acme/staging/attempt/";
		await staging.put(
			`${prefix}manifest.json`,
			JSON.stringify({
				mainModule: "entry.mjs",
				files: ["entry.mjs"],
				sourceRevision: { kind: "artifacts_commit", value: sourceCommit },
			}),
		);
		await staging.put(
			`${prefix}files/entry.mjs`,
			"export default { fetch() { return new Response('candidate'); } }",
		);
		await staging.put(
			`${prefix}static-manifest.json`,
			JSON.stringify({ filenames: ["app.css"] }),
		);
		await staging.put(`${prefix}static/app.css`, "body { color: green }");
		const prepare = vi.fn(() => {
			throw new Error("staging must not write active state");
		});
		const env = {
			DB: { prepare },
			SITE_BUILDER_STORAGE: staging,
			BUNDLES_BUCKET: bundles,
		} as unknown as AppBindings;
		const candidate = await stageThemeCandidate(
			env,
			{
				siteId: "site-1",
				orgSlug: "acme",
				restoreEpoch: 0,
				sourceCommit,
				nextBundleVersion: 7,
				expectedActiveVersion: 6,
			},
			"cms-candidate",
			"attempt",
		);
		expect(candidate).toMatchObject({
			ready: true,
			sourceCommit,
			version: 7,
			expectedActiveVersion: 6,
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(
			[...bundles.objects.keys()].some(
				(key) => key.startsWith("static/") || key.startsWith("acme/v"),
			),
		).toBe(false);
		const expectedModule = await (await staging.get(
			`${prefix}files/entry.mjs`,
		))!.text();
		await cleanupStagedBundle(
			staging as unknown as R2Bucket,
			"acme",
			"attempt",
		);
		expect(staging.objects.size).toBe(0);
		expect(
			await readThemeCandidate(
				bundles as unknown as R2Bucket,
				"acme",
				"cms-candidate",
			),
		).toEqual(candidate);
		expect(bundles.delete).not.toHaveBeenCalled();
		expect(
			(await readCmsBundle(bundles, candidate.r2Prefix)).modules["entry.mjs"]
				?.js,
		).toBe(expectedModule);
		expect(
			new TextDecoder().decode(bundles.objects.get(`${prefix}static/app.css`)),
		).toBe("body { color: green }");
	});
});

it("lists only unexpired candidates for the current site identity without activating them", async () => {
	const storage = bucket();
	const now = Date.now();
	const candidate = {
		ready: true,
		id: "cms-ready",
		slug: "acme",
		siteId: "site",
		restoreEpoch: 2,
		version: 8,
		expectedActiveVersion: 7,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
		etag: "etag",
	};
	const variants = [
		candidate,
		{ ...candidate, id: "cms-other-site", siteId: "other" },
		{ ...candidate, id: "cms-old-epoch", restoreEpoch: 1 },
		{
			...candidate,
			id: "cms-expired",
			expiresAt: new Date(now - 1).toISOString(),
		},
		{ ...candidate, id: "cms-incomplete", ready: false },
		{ ...candidate, id: "cms-live", version: 7 },
		{ ...candidate, id: "cms-outdated", expectedActiveVersion: 6 },
	];
	for (const value of variants)
		await storage.put(
			`theme-candidates/acme/${value.id}.json`,
			JSON.stringify(value),
		);
	const list = vi.fn().mockResolvedValue({
		objects: variants.map((value) => ({
			key: `theme-candidates/acme/${value.id}.json`,
		})),
		truncated: false,
	});
	const previews = await listThemeCandidatePreviews(
		{ ...storage, list } as unknown as R2Bucket,
		{ siteId: "site", slug: "acme", restoreEpoch: 2 },
		7,
		"https://acme.example",
		"preview-secret",
	);
	expect(previews.map((value) => value.id)).toEqual([
		"cms-ready",
		"cms-outdated",
	]);
	expect(previews[0]).toMatchObject({ version: 8, predecessorMatches: true });
	expect(previews[0]!.previewUrl).toMatch(
		/^https:\/\/acme.example\/_tedix\/theme-preview\/cms-ready\/\d+\.[a-f0-9]{64}\/$/,
	);
	expect(previews[1]!.predecessorMatches).toBe(false);
	expect(storage.delete).not.toHaveBeenCalled();
	expect(list).toHaveBeenCalledWith({
		prefix: "theme-candidates/acme/",
		cursor: undefined,
	});
});
