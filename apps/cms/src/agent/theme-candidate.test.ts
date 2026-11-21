import { describe, expect, it, vi } from "vite-plus/test";
import { readCmsBundle } from "@tedix/provisioning/cms-bundle";
import { readThemeCandidate, stageThemeCandidate } from "./theme-candidate";
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
