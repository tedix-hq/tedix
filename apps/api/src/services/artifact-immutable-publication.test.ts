import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import type { TediArtifactRow } from "@tedix/db/queries/cognitive-runtime";
import {
	MAX_REDACTED_ARTIFACT_BYTES,
	publishImmutablePrivateTextArtifact,
	readVerifiedPrivateTextArtifact,
} from "./artifact-immutable-publication";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const dbMocks = vi.hoisted(() => ({
	claim: vi.fn(),
	mark: vi.fn(),
	get: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	claimTediArtifact: dbMocks.claim,
	markTediArtifactPublished: dbMocks.mark,
	getTediArtifact: dbMocks.get,
}));

const encode = (text: string) => new TextEncoder().encode(text);
async function artifact(
	bytes: Uint8Array,
	changes: Partial<TediArtifactRow> = {},
) {
	return {
		id: "child-1",
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conversation-1",
		runId: "run-1",
		messageId: null,
		kind: "document",
		name: "redacted.txt",
		mimeType: "text/plain; charset=utf-8",
		uri: "r2://tedix-tedi-production/tedi-1/artifacts/redacted/child-1.txt",
		sizeBytes: bytes.byteLength,
		contentDigest: await sha256Hex(bytes),
		accessClassification: "runtime_private",
		publicationState: "ready",
		producerExecutionId: null,
		accessEnvelope: null,
		metadata: {},
		createdAt: "2026-09-23T10:00:00.000Z",
		...changes,
	} as TediArtifactRow;
}
function storage(bytes: Uint8Array) {
	const head = vi.fn(async () => ({ size: bytes.byteLength }));
	const get = vi.fn(async () => ({
		body: new Response(bytes).body!,
		size: bytes.byteLength,
	}));
	const put = vi.fn(async () => ({}));
	return { head, get, put, bucket: { head, get, put } as unknown as R2Bucket };
}

beforeEach(() => vi.resetAllMocks());

describe("complete private text review", () => {
	it("returns the same verified bytes and preserves a UTF-8 BOM in preview", async () => {
		const bytes = encode("\uFEFFReviewed text: café\n");
		const store = storage(bytes);
		const result = await readVerifiedPrivateTextArtifact(
			store.bucket,
			await artifact(bytes),
		);
		expect(result.bytes).toEqual(bytes);
		expect(result.text).toBe("\uFEFFReviewed text: café\n");
		expect(store.get).toHaveBeenCalledTimes(1);
	});

	it.each([
		["pending", { publicationState: "pending" }],
		["legacy", { accessClassification: null }],
		["bundle", { metadata: { bundle: true } }],
		["PDF", { mimeType: "application/pdf" }],
		["unknown MIME", { mimeType: null }],
		[
			"foreign tedi key",
			{ uri: "r2://tedix-tedi-production/another-tedi/artifacts/secret.txt" },
		],
		["foreign bucket", { uri: "r2://other/tedi-1/artifacts/secret.txt" }],
		[
			"unsafe key",
			{ uri: "r2://tedix-tedi-production/tedi-1/artifacts/../secret.txt" },
		],
		["missing digest", { contentDigest: null }],
	] as const)("rejects %s before reading storage", async (_name, changes) => {
		const bytes = encode(
			"%PDF-1.7 ASCII is still not a supported text artifact",
		);
		const store = storage(bytes);
		await expect(
			readVerifiedPrivateTextArtifact(
				store.bucket,
				await artifact(bytes, changes),
			),
		).rejects.toThrow();
		expect(store.head).not.toHaveBeenCalled();
		expect(store.get).not.toHaveBeenCalled();
	});

	it("rejects hash and actual size changes after a plausible HEAD response", async () => {
		const bytes = encode("reviewed");
		for (const replacement of [
			encode("modified"),
			encode("reviewed plus hidden tail"),
		]) {
			const store = storage(replacement);
			store.head.mockResolvedValue({ size: bytes.byteLength });
			await expect(
				readVerifiedPrivateTextArtifact(store.bucket, await artifact(bytes)),
			).rejects.toThrow("changed");
		}
	});

	it("rejects invalid UTF-8 even when its byte hash matches", async () => {
		const bytes = new Uint8Array([0xc3, 0x28]);
		await expect(
			readVerifiedPrivateTextArtifact(
				storage(bytes).bucket,
				await artifact(bytes),
			),
		).rejects.toThrow("UTF-8");
	});

	it("cancels a body that exceeds the limit despite a lying HEAD", async () => {
		const bytes = new Uint8Array(MAX_REDACTED_ARTIFACT_BYTES).fill(65);
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_REDACTED_ARTIFACT_BYTES + 1));
			},
			cancel,
		});
		const store = storage(bytes);
		store.get.mockResolvedValue({ body: stream, size: bytes.byteLength });
		await expect(
			readVerifiedPrivateTextArtifact(store.bucket, await artifact(bytes)),
		).rejects.toThrow("limit");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("accepts exactly the byte ceiling and refuses an oversized HEAD without GET", async () => {
		const bytes = new Uint8Array(MAX_REDACTED_ARTIFACT_BYTES).fill(65);
		const store = storage(bytes);
		expect(
			(
				await readVerifiedPrivateTextArtifact(
					store.bucket,
					await artifact(bytes),
				)
			).bytes.byteLength,
		).toBe(MAX_REDACTED_ARTIFACT_BYTES);
		store.get.mockClear();
		store.head.mockResolvedValue({ size: MAX_REDACTED_ARTIFACT_BYTES + 1 });
		await expect(
			readVerifiedPrivateTextArtifact(store.bucket, await artifact(bytes)),
		).rejects.toThrow();
		expect(store.get).not.toHaveBeenCalled();
	});
});

describe("immutable private candidate publication", () => {
	async function setup(content = "Reviewed child\n") {
		const bytes = encode(content);
		const row = await artifact(bytes);
		const store = storage(bytes);
		dbMocks.claim.mockResolvedValue({
			artifact: { ...row, publicationState: "pending" },
			created: true,
		});
		dbMocks.mark.mockResolvedValue(row);
		const input = {
			db: {} as DbClient,
			bucket: store.bucket,
			id: row.id,
			organizationId: row.organizationId,
			tediId: row.tediId,
			conversationId: row.conversationId,
			runId: row.runId,
			kind: row.kind,
			name: row.name,
			content,
			createdAt: row.createdAt,
		};
		return { row, store, input };
	}

	it("claims private immutable identity before create-only object publication and ready CAS", async () => {
		const { input, row, store } = await setup();
		expect(await publishImmutablePrivateTextArtifact(input)).toEqual(row);
		expect(dbMocks.claim).toHaveBeenCalledWith(
			input.db,
			expect.objectContaining({
				accessClassification: "runtime_private",
				publicationState: "pending",
				contentDigest: row.contentDigest,
			}),
		);
		expect(store.put).toHaveBeenCalledWith(
			expect.stringContaining(`/redacted/${row.contentDigest}/`),
			encode(input.content),
			expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
		);
		expect(dbMocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
			store.put.mock.invocationCallOrder[0]!,
		);
		expect(store.put.mock.invocationCallOrder[0]).toBeLessThan(
			dbMocks.mark.mock.invocationCallOrder[0]!,
		);
	});

	it("does not overwrite an already ready immutable replay", async () => {
		const { input, row, store } = await setup();
		dbMocks.claim.mockResolvedValue({ artifact: row, created: false });
		expect(await publishImmutablePrivateTextArtifact(input)).toEqual(row);
		expect(store.put).not.toHaveBeenCalled();
		expect(dbMocks.mark).not.toHaveBeenCalled();
	});

	it("verifies an existing object's bytes after a create-only collision", async () => {
		const { input, store, row } = await setup();
		store.put.mockResolvedValue(null as unknown as object);
		expect(await publishImmutablePrivateTextArtifact(input)).toEqual(row);
		expect(store.get).toHaveBeenCalledTimes(1);
		expect(dbMocks.mark).toHaveBeenCalledTimes(1);
	});

	it("does not mark a conflicting object or a failed write ready", async () => {
		const { input, store } = await setup();
		store.put.mockResolvedValue(null as unknown as object);
		store.get.mockResolvedValue({
			body: new Response("different").body!,
			size: 9,
		});
		await expect(publishImmutablePrivateTextArtifact(input)).rejects.toThrow(
			"conflicts",
		);
		expect(dbMocks.mark).not.toHaveBeenCalled();
		store.put.mockRejectedValue(new Error("storage unavailable"));
		await expect(publishImmutablePrivateTextArtifact(input)).rejects.toThrow(
			"storage unavailable",
		);
		expect(dbMocks.mark).not.toHaveBeenCalled();
	});

	it("enforces UTF-8 byte size, not JavaScript character count, before claiming", async () => {
		const { input, store } = await setup();
		for (const content of [
			"",
			"é".repeat(MAX_REDACTED_ARTIFACT_BYTES / 2 + 1),
		]) {
			await expect(
				publishImmutablePrivateTextArtifact({ ...input, content }),
			).rejects.toThrow("KiB");
		}
		expect(dbMocks.claim).not.toHaveBeenCalled();
		expect(store.put).not.toHaveBeenCalled();
	});
});
