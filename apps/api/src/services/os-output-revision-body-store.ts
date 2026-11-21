import { sha256Hex } from "@tedix/worker-kit/crypto";
import { env } from "cloudflare:workers";
import type { OsOutputRevisionRow } from "@tedix/db/tenant-store/outputs-schema";

export interface OutputBodyBucket {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer): Promise<unknown>;
}

// Cache only verified immutable bytes, never revision metadata or access decisions.
const bodyCache = new Map<
	string,
	{ bucket: OutputBodyBucket; content: string; bytes: number }
>();
const BODY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const BODY_CACHE_MAX_ENTRIES = 16;
let bodyCacheBytes = 0;

function rememberBody(
	key: string,
	bucket: OutputBodyBucket,
	content: string,
	bytes: number,
) {
	const previous = bodyCache.get(key);
	if (previous) {
		bodyCacheBytes -= previous.content.length * 2;
		bodyCache.delete(key);
	}
	const size = content.length * 2;
	if (size > BODY_CACHE_MAX_BYTES) return;
	while (
		bodyCache.size &&
		(bodyCacheBytes + size > BODY_CACHE_MAX_BYTES ||
			bodyCache.size >= BODY_CACHE_MAX_ENTRIES)
	) {
		const oldest = bodyCache.keys().next().value!;
		bodyCacheBytes -= bodyCache.get(oldest)!.content.length * 2;
		bodyCache.delete(oldest);
	}
	bodyCache.set(key, { bucket, content, bytes });
	bodyCacheBytes += size;
}

export function outputRevisionBodyKey(organizationId: string, sha256: string) {
	if (!organizationId || /[/\\\u0000-\u001f]/.test(organizationId))
		throw new Error("Invalid output body organization");
	if (!/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("Invalid output body digest");
	return `os-output-revisions/v1/${organizationId}/${sha256}.gz`;
}

/** Complete the immutable body write before giving a caller a D1 pointer. */
export async function storeOutputRevisionBody(
	bucket: OutputBodyBucket,
	organizationId: string,
	content: string | Uint8Array,
) {
	const bytes =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	const contentSha256 = await sha256Hex(bytes);
	const bodyR2Key = outputRevisionBodyKey(organizationId, contentSha256);
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	// Identical bytes in this organization always address the same object.
	await bucket.put(bodyR2Key, compressed);
	return { contentSha256, contentBytes: bytes.byteLength, bodyR2Key };
}

/**
 * A row written since November 2026 keeps `content = ''` and a pointer; its
 * body is read from R2. A legacy row still carrying its inline body (until the
 * scheduled offload clears it) is served from that body without an R2 read.
 */
export async function hydrateOutputRevision(
	row: OsOutputRevisionRow,
	bucket: OutputBodyBucket | undefined = env.R2_BUCKET,
	lap?: (stage: string) => void,
): Promise<OsOutputRevisionRow> {
	let content = row.content;
	let bytes: Uint8Array;
	const offloaded = content == null || (content === "" && row.bodyR2Key);
	if (offloaded) {
		if (!row.contentSha256 || !row.bodyR2Key || !bucket)
			throw new Error("Output revision body is unavailable");
		if (
			row.bodyR2Key !==
			outputRevisionBodyKey(row.organizationId, row.contentSha256)
		)
			throw new Error(
				"Output revision body key does not match its organization and digest",
			);
		const cached = bodyCache.get(row.bodyR2Key);
		if (cached?.bucket === bucket) {
			if (row.contentBytes != null && cached.bytes !== row.contentBytes)
				throw new Error("Output revision body length mismatch");
			bodyCache.delete(row.bodyR2Key);
			bodyCache.set(row.bodyR2Key, cached);
			lap?.("bodyCacheHitMs");
			return { ...row, content: cached.content };
		}
		const object = await bucket.get(row.bodyR2Key);
		if (!object) throw new Error("Output revision body object is missing");
		bytes = new Uint8Array(
			await new Response(
				new Blob([await object.arrayBuffer()])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).arrayBuffer(),
		);
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} else {
		bytes = new TextEncoder().encode(content);
	}
	if (row.contentSha256 && (await sha256Hex(bytes)) !== row.contentSha256)
		throw new Error("Output revision body digest mismatch");
	if (row.contentBytes != null && bytes.byteLength !== row.contentBytes)
		throw new Error("Output revision body length mismatch");
	if (offloaded && row.bodyR2Key && bucket)
		rememberBody(row.bodyR2Key, bucket, content, bytes.byteLength);
	return { ...row, content };
}
