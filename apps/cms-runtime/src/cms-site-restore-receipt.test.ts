import { describe, expect, it } from "vite-plus/test";
import {
	advanceCmsSiteRestoreReceipt,
	claimCmsSiteRestoreReceipt,
	readCmsSiteRestoreReceipt,
	type CmsSiteRestoreReceipt,
} from "./cms-site-restore-receipt";

const identity = {
	siteId: "13d1b0d0-2664-4006-981b-d27af4e73794",
	slug: "restore-proof",
	captureId: "8b7637c1-39b2-41ba-9bac-33fc7e19be7b",
	generation: "3d2a177a-34e1-4caa-83b1-af457c26e4c0",
};

function receipt(): CmsSiteRestoreReceipt {
	return {
		version: 1,
		...identity,
		phase: "claimed",
		mode: "restore",
		createdAt: "2026-09-29T00:00:00.000Z",
		updatedAt: "2026-09-29T00:00:00.000Z",
		bundle: { version: 7, etag: "bundle-etag" },
	};
}

function storage() {
	let saved: { value: CmsSiteRestoreReceipt; etag: string } | null = null;
	let revision = 0;
	return {
		get: async (_key: string) =>
			saved
				? {
						etag: saved.etag,
						json: async () => saved?.value,
					}
				: null,
		put: async (
			_key: string,
			body: string,
			options: {
				onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string };
			},
		) => {
			if (options.onlyIf?.etagDoesNotMatch === "*" && saved) return null;
			if (
				options.onlyIf?.etagMatches &&
				options.onlyIf.etagMatches !== saved?.etag
			)
				return null;
			revision++;
			saved = { value: JSON.parse(body), etag: `etag-${revision}` };
			return { etag: saved.etag };
		},
		force: (value: CmsSiteRestoreReceipt) => {
			saved = { value, etag: `etag-${++revision}` };
		},
	};
}

describe("CMS site restore receipt", () => {
	it("claims once and rejects a concurrent stale phase write", async () => {
		const bucket = storage();
		const first = await claimCmsSiteRestoreReceipt(bucket as never, receipt());
		await expect(
			claimCmsSiteRestoreReceipt(bucket as never, receipt()),
		).rejects.toThrow("already claimed");
		const second = await advanceCmsSiteRestoreReceipt(bucket as never, first, {
			...first.receipt,
			phase: "fenced",
			updatedAt: "2026-09-29T00:00:01.000Z",
		});
		await expect(
			advanceCmsSiteRestoreReceipt(bucket as never, first, {
				...first.receipt,
				phase: "fenced",
				updatedAt: "2026-09-29T00:00:02.000Z",
			}),
		).rejects.toThrow("compare-and-swap failed");
		expect(
			(await readCmsSiteRestoreReceipt(bucket as never, identity))?.etag,
		).toBe(second.etag);
	});

	it("keeps the claimed generation and bundle immutable", async () => {
		const bucket = storage();
		const current = await claimCmsSiteRestoreReceipt(
			bucket as never,
			receipt(),
		);
		for (const changed of [
			{ generation: "16acb373-b829-4562-bd0c-2607c54764ca" },
			{ bundle: { version: 8, etag: "bundle-etag" } },
			{ phase: "released" as const },
		]) {
			await expect(
				advanceCmsSiteRestoreReceipt(bucket as never, current, {
					...current.receipt,
					phase: "fenced",
					...changed,
				}),
			).rejects.toThrow("transition invalid");
		}
	});

	it("rejects a malformed private receipt instead of assuming a phase", async () => {
		const bucket = storage();
		bucket.force({ ...receipt(), siteId: "another-site" });
		await expect(
			readCmsSiteRestoreReceipt(bucket as never, identity),
		).rejects.toThrow("identity changed");
	});
});
