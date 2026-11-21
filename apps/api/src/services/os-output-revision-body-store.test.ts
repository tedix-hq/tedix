import { describe, expect, it, vi } from "vite-plus/test";
import type { OsOutputRevisionRow } from "@tedix/db/tenant-store/outputs-schema";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	hydrateOutputRevision,
	outputRevisionBodyKey,
	storeOutputRevisionBody,
} from "./os-output-revision-body-store";

function bucket() {
	const objects = new Map<string, ArrayBuffer>();
	return {
		objects,
		put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
			objects.set(key, bytes);
		}),
		get: vi.fn(async (key: string) => {
			const bytes = objects.get(key);
			return bytes ? { arrayBuffer: async () => bytes } : null;
		}),
	};
}

function revision(content: string, metadata = {}): OsOutputRevisionRow {
	return {
		id: "revision-1",
		organizationId: "org-1",
		outputId: "output-1",
		revision: 1,
		content,
		note: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-01-01",
		skillRunId: null,
		skillId: null,
		accessEnvelope: null,
		contentSha256: null,
		contentBytes: null,
		bodyR2Key: null,
		...metadata,
	};
}

describe("output revision body store", () => {
	it.each([
		"",
		"plain ASCII\r\nexact whitespace  ",
		"\ufeffGrüße 🌍\n漢字",
		'{"kind":"document","blocks":[]}',
	])(
		"round trips exact UTF-8 bytes and preserves the evidence digest: %j",
		async (content) => {
			const storage = bucket();
			const metadata = await storeOutputRevisionBody(storage, "org-1", content);
			expect(metadata.contentSha256).toBe(await sha256Hex(content));
			expect(metadata.contentBytes).toBe(
				new TextEncoder().encode(content).byteLength,
			);
			const hydrated = await hydrateOutputRevision(
				revision("", metadata),
				storage,
			);
			expect(hydrated.content).toBe(content);
			expect(await sha256Hex(hydrated.content)).toBe(metadata.contentSha256);
			expect(
				new Uint8Array(
					await new Response(
						new Blob([storage.objects.get(metadata.bodyR2Key)!])
							.stream()
							.pipeThrough(new DecompressionStream("gzip")),
					).arrayBuffer(),
				),
			).toEqual(new TextEncoder().encode(content));
		},
	);

	it("accepts encoded bytes and verifies a hydrated body with one digest", async () => {
		const storage = bucket();
		const content = "\ufeffGrüße 🌍";
		const metadata = await storeOutputRevisionBody(
			storage,
			"org-1",
			new TextEncoder().encode(content),
		);
		const digest = vi.spyOn(crypto.subtle, "digest");
		try {
			expect(
				(await hydrateOutputRevision(revision("", metadata), storage)).content,
			).toBe(content);
			expect(digest).toHaveBeenCalledTimes(1);
			const lap = vi.fn();
			const next = { ...revision("", metadata), id: "revision-2", revision: 2 };
			expect(await hydrateOutputRevision(next, storage, lap)).toEqual({
				...next,
				content,
			});
			expect(storage.get).toHaveBeenCalledTimes(1);
			expect(digest).toHaveBeenCalledTimes(1);
			expect(lap).toHaveBeenCalledWith("bodyCacheHitMs");
			await expect(
				hydrateOutputRevision({ ...next, contentBytes: 1 }, storage),
			).rejects.toThrow("length mismatch");
			await expect(
				hydrateOutputRevision({ ...next, organizationId: "org-2" }, storage),
			).rejects.toThrow("key does not match");
			await expect(hydrateOutputRevision(next, bucket())).rejects.toThrow(
				"object is missing",
			);
		} finally {
			digest.mockRestore();
		}
	});

	it("bounds cached body memory and does not cache oversized bodies", async () => {
		const storage = bucket();
		const first = revision(
			"",
			await storeOutputRevisionBody(storage, "org-1", "a".repeat(3_000_000)),
		);
		const second = revision(
			"",
			await storeOutputRevisionBody(storage, "org-1", "b".repeat(3_000_000)),
		);
		await hydrateOutputRevision(first, storage);
		await hydrateOutputRevision(second, storage);
		await hydrateOutputRevision(first, storage);
		expect(storage.get).toHaveBeenCalledTimes(3);
		const oversized = revision(
			"",
			await storeOutputRevisionBody(storage, "org-1", "c".repeat(4_200_000)),
		);
		await hydrateOutputRevision(oversized, storage);
		await hydrateOutputRevision(oversized, storage);
		expect(storage.get).toHaveBeenCalledTimes(5);
	});

	it("deduplicates within an organization and separates organizations", async () => {
		const storage = bucket();
		const a = await storeOutputRevisionBody(storage, "org-1", "same");
		const b = await storeOutputRevisionBody(storage, "org-1", "same");
		const other = await storeOutputRevisionBody(storage, "org-2", "same");
		expect(a.bodyR2Key).toBe(b.bodyR2Key);
		expect(a.bodyR2Key).not.toBe(other.bodyR2Key);
		expect(storage.objects.size).toBe(2);
	});

	it("reads legacy inline bodies and prefers verified inline content without an R2 read", async () => {
		const storage = bucket();
		expect(
			(await hydrateOutputRevision(revision("legacy"), storage)).content,
		).toBe("legacy");
		const metadata = await storeOutputRevisionBody(storage, "org-1", "inline");
		storage.objects.clear();
		expect(
			(await hydrateOutputRevision(revision("inline", metadata), storage))
				.content,
		).toBe("inline");
		expect(storage.get).not.toHaveBeenCalled();
		await expect(
			hydrateOutputRevision(revision("tampered", metadata), storage),
		).rejects.toThrow("digest mismatch");
	});

	it("fails closed for missing, corrupted or cross-organization objects and wrong lengths", async () => {
		const storage = bucket();
		const metadata = await storeOutputRevisionBody(storage, "org-1", "right");
		await expect(
			hydrateOutputRevision(
				revision("", { ...metadata, organizationId: "org-2" }),
				storage,
			),
		).rejects.toThrow("key does not match");
		expect(storage.get).not.toHaveBeenCalled();
		await expect(
			hydrateOutputRevision(
				revision("right", { ...metadata, contentBytes: 1 }),
				storage,
			),
		).rejects.toThrow("length mismatch");
		const wrong = await storeOutputRevisionBody(storage, "org-1", "wrong");
		storage.objects.set(
			metadata.bodyR2Key,
			storage.objects.get(wrong.bodyR2Key)!,
		);
		await expect(
			hydrateOutputRevision(revision("", metadata), storage),
		).rejects.toThrow("digest mismatch");
		storage.objects.clear();
		await expect(
			hydrateOutputRevision(revision("", metadata), storage),
		).rejects.toThrow("object is missing");
	});

	it("rejects malformed key components", () => {
		expect(() => outputRevisionBodyKey("../org", "a".repeat(64))).toThrow();
		expect(() => outputRevisionBodyKey("org-1", "bad")).toThrow();
	});
});
