import { Buffer } from "node:buffer";
import { ORPCError } from "@orpc/server";
import {
	OS_OUTPUT_ASSET_MAX_BYTES,
	isLargeEmbeddedImage,
	listOutputImageSources,
	outputAssetDigest,
	outputAssetReference,
	visitOutputImageSources,
} from "@tedix/api-contract/utils/os-output-assets";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { env } from "cloudflare:workers";
import { decodeOsExportImage } from "../lib/os-export-images";

/**
 * Images of a file live beside its revision bodies, one object per image,
 * under the file's own prefix. The content names an image by the digest of
 * its bytes, so the same image saved twice is stored once and every revision
 * of the file can keep pointing at it. Nothing is removed while the file
 * exists; the prefix goes when the file is deleted.
 */

export interface OutputAssetBucket {
	get(key: string): Promise<{
		arrayBuffer(): Promise<ArrayBuffer>;
		httpMetadata?: { contentType?: string };
	} | null>;
	put(
		key: string,
		value: ArrayBuffer,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>;
	head(key: string): Promise<unknown>;
	list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
		objects: { key: string }[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string[]): Promise<unknown>;
}

export interface OutputAssetScope {
	organizationId: string;
	outputId: string;
}

function outputAssetPrefix(scope: OutputAssetScope) {
	for (const part of [scope.organizationId, scope.outputId])
		if (!part || /[/\\\u0000-\u001f]/.test(part))
			throw new Error("Invalid output asset scope");
	return `os-output-assets/v1/${scope.organizationId}/${scope.outputId}/`;
}

export function outputAssetKey(scope: OutputAssetScope, sha256: string) {
	if (!/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("Invalid output asset digest");
	return `${outputAssetPrefix(scope)}${sha256}`;
}

/** Keys this isolate has written or seen; an asset is never removed while its file exists. */
const known = new Set<string>();
function remember(key: string) {
	if (known.size >= 10_000) known.clear();
	known.add(key);
}

function refuse(message: string): never {
	throw new ORPCError("BAD_REQUEST", { message });
}

/** Store one embedded image as an asset of the file and return its reference. */
export async function storeOutputAsset(
	scope: OutputAssetScope,
	dataUrl: string,
	bucket: Pick<OutputAssetBucket, "put"> = env.R2_BUCKET,
): Promise<string> {
	let image: ReturnType<typeof decodeOsExportImage>;
	try {
		image = decodeOsExportImage(dataUrl);
	} catch {
		refuse(
			"An embedded image is not a PNG, JPEG, GIF, WebP or self-contained SVG image.",
		);
	}
	if (image.bytes.byteLength > OS_OUTPUT_ASSET_MAX_BYTES)
		refuse(
			`An image is over the ${OS_OUTPUT_ASSET_MAX_BYTES / (1024 * 1024)} MB limit.`,
		);
	const sha256 = await sha256Hex(image.bytes);
	const key = outputAssetKey(scope, sha256);
	if (!known.has(key)) {
		const bytes = new Uint8Array(image.bytes.byteLength);
		bytes.set(image.bytes);
		await bucket.put(key, bytes.buffer, {
			httpMetadata: { contentType: image.type },
		});
		remember(key);
	}
	return outputAssetReference(sha256);
}

/** One stored image of the file as a data URL, or null when the file holds no such image. */
export async function readOutputAsset(
	scope: OutputAssetScope,
	reference: string,
	bucket: Pick<OutputAssetBucket, "get"> = env.R2_BUCKET,
): Promise<string | null> {
	const sha256 = outputAssetDigest(reference);
	if (!sha256) return null;
	const object = await bucket.get(outputAssetKey(scope, sha256));
	const type = object?.httpMetadata?.contentType;
	if (!object || !type) return null;
	return `data:${type};base64,${Buffer.from(await object.arrayBuffer()).toString("base64")}`;
}

/** A reader for exports and read views: a missing image is an error, not a blank. */
export function outputAssetReader(
	scope: OutputAssetScope,
	bucket: Pick<OutputAssetBucket, "get"> = env.R2_BUCKET,
) {
	return async (reference: string) => {
		const dataUrl = await readOutputAsset(scope, reference, bucket);
		if (!dataUrl) throw new Error("A stored image of this file is missing");
		return dataUrl;
	};
}

/**
 * A revision body for a reader that cannot ask for images one by one, such as
 * a share link: each stored image is embedded in the returned copy. An image
 * that cannot be read keeps its reference, which draws nothing.
 */
export async function parseOutputContentWithImages(
	revision: { organizationId: string; outputId: string; content: string },
	bucket: Pick<OutputAssetBucket, "get"> = env.R2_BUCKET,
): Promise<unknown> {
	const body: unknown = JSON.parse(revision.content);
	if (!revision.content.includes("tedix-asset:")) return body;
	const embedded = new Map<string, string>();
	for (const reference of listOutputImageSources(
		body,
		(source) => outputAssetDigest(source) !== null,
	)) {
		const dataUrl = await readOutputAsset(revision, reference, bucket);
		if (dataUrl) embedded.set(reference, dataUrl);
	}
	visitOutputImageSources(body, (source) => embedded.get(source));
	return body;
}

/**
 * The one step every writer's content passes before its body is stored:
 * embedded images above the inline bound become assets of the file, and a
 * reference must name an image the file already holds. Writers may send
 * either form; a stored body carries references only.
 */
export async function externalizeOutputAssets(
	scope: OutputAssetScope,
	content: string,
	bucket: Pick<OutputAssetBucket, "put" | "head"> = env.R2_BUCKET,
): Promise<string> {
	if (!content.includes("data:") && !content.includes("tedix-asset:"))
		return content;
	const body: unknown = JSON.parse(content);
	const sources = listOutputImageSources(
		body,
		(source) =>
			isLargeEmbeddedImage(source) || source.startsWith("tedix-asset:"),
	);
	if (sources.length === 0) return content;
	const stored = new Map<string, string>();
	for (const source of sources) {
		if (isLargeEmbeddedImage(source)) {
			stored.set(source, await storeOutputAsset(scope, source, bucket));
			continue;
		}
		const sha256 = outputAssetDigest(source);
		const key = sha256 ? outputAssetKey(scope, sha256) : null;
		if (!key || (!known.has(key) && !(await bucket.head(key))))
			refuse(
				"The content names a stored image this file does not hold. Send the image embedded, or upload it to this file first.",
			);
		remember(key);
	}
	if (stored.size === 0) return content;
	visitOutputImageSources(body, (source) => stored.get(source));
	return JSON.stringify(body);
}

/** Remove every image of a deleted file. */
export async function deleteOutputAssets(
	scope: OutputAssetScope,
	bucket: Pick<OutputAssetBucket, "list" | "delete"> = env.R2_BUCKET,
): Promise<number> {
	const prefix = outputAssetPrefix(scope);
	let removed = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 500 });
		const keys = page.objects.map((object) => object.key);
		if (keys.some((key) => !key.startsWith(prefix)))
			throw new Error("Output asset list escaped the file prefix");
		if (keys.length) await bucket.delete(keys);
		for (const key of keys) known.delete(key);
		removed += keys.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}
