import { sha256Hex } from "@tedix/worker-kit/crypto";
import { env } from "cloudflare:workers";
import type { OsOutputRevisionRow } from "@tedix/db/schema/os-workspaces";

export interface OutputBodyBucket {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer): Promise<unknown>;
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
	content: string,
) {
	const bytes = new TextEncoder().encode(content);
	const contentSha256 = await sha256Hex(bytes);
	const bodyR2Key = outputRevisionBodyKey(organizationId, contentSha256);
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	// Identical bytes in this organization always address the same object.
	await bucket.put(bodyR2Key, compressed);
	return { contentSha256, contentBytes: bytes.byteLength, bodyR2Key };
}

/** Backfill proof must read R2 even while the inline-first reader is enabled. */
export async function verifyStoredOutputRevisionBody(
	bucket: OutputBodyBucket,
	organizationId: string,
	content: string,
	metadata: { contentSha256: string; contentBytes: number; bodyR2Key: string },
) {
	if (
		metadata.bodyR2Key !==
		outputRevisionBodyKey(organizationId, metadata.contentSha256)
	)
		throw new Error("Output revision body key mismatch");
	const object = await bucket.get(metadata.bodyR2Key);
	if (!object) throw new Error("Output revision body object is missing");
	const bytes = new Uint8Array(
		await new Response(
			new Blob([await object.arrayBuffer()])
				.stream()
				.pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer(),
	);
	const expected = new TextEncoder().encode(content);
	if (
		(await sha256Hex(bytes)) !== metadata.contentSha256 ||
		bytes.byteLength !== metadata.contentBytes ||
		bytes.byteLength !== expected.byteLength ||
		bytes.some((byte, index) => byte !== expected[index])
	)
		throw new Error("Output revision body verification mismatch");
}

/** Inline-first during rollout; an absent inline body is read from R2. */
export async function hydrateOutputRevision(
	row: OsOutputRevisionRow,
	bucket: OutputBodyBucket | undefined = env.R2_BUCKET,
): Promise<OsOutputRevisionRow> {
	let content = row.content;
	if (content == null || (content === "" && row.bodyR2Key)) {
		if (!row.contentSha256 || !row.bodyR2Key || !bucket)
			throw new Error("Output revision body is unavailable");
		if (
			row.bodyR2Key !==
			outputRevisionBodyKey(row.organizationId, row.contentSha256)
		)
			throw new Error(
				"Output revision body key does not match its organization and digest",
			);
		const object = await bucket.get(row.bodyR2Key);
		if (!object) throw new Error("Output revision body object is missing");
		const bytes = await new Response(
			new Blob([await object.arrayBuffer()])
				.stream()
				.pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer();
		if ((await sha256Hex(bytes)) !== row.contentSha256)
			throw new Error("Output revision body digest mismatch");
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	}
	const bytes = new TextEncoder().encode(content);
	if (row.contentSha256 && (await sha256Hex(bytes)) !== row.contentSha256)
		throw new Error("Output revision body digest mismatch");
	if (row.contentBytes != null && bytes.byteLength !== row.contentBytes)
		throw new Error("Output revision body length mismatch");
	return { ...row, content };
}
