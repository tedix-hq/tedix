import type { TurnImagePart } from "@tedix/voice/stt";

/** Private runtime objects deliberately live outside the Computer identity mount. */
export type WorkflowImageBucket = Pick<
	R2Bucket,
	"put" | "get" | "list" | "delete"
>;
export interface WorkflowImageRef {
	key: string;
	sha256: string;
	mediaType: string;
	fileName: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const MEDIA_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/gif",
]);

function invalid(): never {
	throw new Error("workflow_image_invalid");
}

function prefix(tediId: string, runId: string): string {
	if (!tediId || !runId || tediId.length > 512 || runId.length > 512) invalid();
	return `__runtime/workflow-images/${encodeURIComponent(tediId)}/${encodeURIComponent(runId)}/`;
}

function normalize(value: TurnImagePart): TurnImagePart {
	if (
		!value ||
		typeof value.data !== "string" ||
		typeof value.mediaType !== "string" ||
		typeof value.fileName !== "string"
	)
		invalid();
	const mediaType = value.mediaType.toLowerCase().split(";")[0]!.trim();
	if (!MEDIA_TYPES.has(mediaType) || value.fileName.length > 512) invalid();
	let data = value.data;
	let kind = value.kind;
	if (kind === "url" && data.startsWith("data:")) {
		const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(data);
		if (!match || match[1]!.toLowerCase() !== mediaType) invalid();
		data = match[2]!;
		kind = "base64";
	}
	if (kind === "base64") {
		if (data.length > Math.ceil(MAX_BYTES / 3) * 4 + 1024) invalid();
		data = data.replace(/\s/g, "");
		if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
			invalid();
		const bytes =
			(data.length / 4) * 3 -
			(data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
		if (bytes > MAX_BYTES) invalid();
	} else if (kind === "url") {
		if (data.length > 8192) invalid();
		let url: URL;
		try {
			url = new URL(data);
		} catch {
			return invalid();
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") invalid();
	} else invalid();
	return { kind, data, mediaType, fileName: value.fileName };
}

async function hash(body: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(body),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** An internal marker, never an HTTP URL or a public R2 access capability. */
export function workflowImageUri(ref: WorkflowImageRef): string {
	return `tedix-r2://workflow-image/${encodeURIComponent(ref.key)}?sha256=${ref.sha256}`;
}

/** Validate and describe every payload before any private storage mutation. */
export async function describeWorkflowImages(
	tediId: string,
	runId: string,
	images: readonly TurnImagePart[],
): Promise<WorkflowImageRef[]> {
	const owner = prefix(tediId, runId);
	if (images.length > MAX_IMAGES) invalid();
	// Validate the entire request before starting any writes.
	const bodies = images.map((image) => JSON.stringify(normalize(image)));
	const refs: WorkflowImageRef[] = [];
	for (const body of bodies) {
		const sha256 = await hash(body);
		const key = `${owner}${sha256}.json`;
		const image = JSON.parse(body) as TurnImagePart;
		refs.push({
			key,
			sha256,
			mediaType: image.mediaType,
			fileName: image.fileName,
		});
	}
	return refs;
}

/** A wire guard must complete synchronously before an external effect starts. */
function assertImageWireReady(guard: () => void): void {
	if (typeof guard !== "function" || guard() !== undefined)
		throw new Error("workflow_image_sync_guard_invalid");
}

/** Complete all private writes before dispatching the compact Workflow payload. */
export async function persistWorkflowImages(
	bucket: WorkflowImageBucket,
	tediId: string,
	runId: string,
	images: readonly TurnImagePart[],
	assertReady: () => Promise<() => void>,
): Promise<WorkflowImageRef[]> {
	const owner = prefix(tediId, runId);
	const refs = await describeWorkflowImages(tediId, runId, images);
	const bodies = images.map((image) => JSON.stringify(normalize(image)));
	const manifestKey = `${owner}manifest.json`;
	const manifest = JSON.stringify(refs);
	const validateManifest = async (object: R2ObjectBody | null) => {
		if (!object || object.size > 16384)
			throw new Error("workflow_image_manifest_invalid");
		if ((await object.text()) !== manifest)
			throw new Error("workflow_image_conflict");
	};
	const existing = await bucket.get(manifestKey);
	if (existing) await validateManifest(existing);
	else {
		// R2's atomic If-None-Match claim fixes this run's ordered payload.
		assertImageWireReady(await assertReady());
		const claimed = await bucket.put(manifestKey, manifest, {
			onlyIf: new Headers({ "If-None-Match": "*" }),
			httpMetadata: { contentType: "application/json" },
		});
		if (!claimed) await validateManifest(await bucket.get(manifestKey));
	}
	// A reset after the manifest claim is repaired by an identical retry.
	for (let index = 0; index < bodies.length; index++) {
		assertImageWireReady(await assertReady());
		await bucket.put(refs[index]!.key, bodies[index]!, {
			httpMetadata: { contentType: "application/json" },
		});
	}
	return refs;
}

/** Refs are capabilities only for this exact owning tedi/run, never arbitrary keys. */
export async function loadWorkflowImages(
	bucket: WorkflowImageBucket,
	tediId: string,
	runId: string,
	refs: readonly WorkflowImageRef[],
): Promise<TurnImagePart[]> {
	const owner = prefix(tediId, runId);
	if (refs.length > MAX_IMAGES) invalid();
	for (const ref of refs) {
		if (
			!ref ||
			!/^[a-f0-9]{64}$/.test(ref.sha256) ||
			ref.key !== `${owner}${ref.sha256}.json` ||
			!MEDIA_TYPES.has(ref.mediaType) ||
			typeof ref.fileName !== "string" ||
			ref.fileName.length > 512
		)
			invalid();
	}
	const images: TurnImagePart[] = [];
	for (const ref of refs) {
		const object = await bucket.get(ref.key);
		if (!object) throw new Error("workflow_image_missing");
		if (object.size > Math.ceil(MAX_BYTES / 3) * 4 + 2048) invalid();
		const body = await object.text();
		if ((await hash(body)) !== ref.sha256)
			throw new Error("workflow_image_integrity_failed");
		let value: TurnImagePart;
		try {
			value = JSON.parse(body) as TurnImagePart;
		} catch {
			return invalid();
		}
		const image = normalize(value);
		if (image.mediaType !== ref.mediaType || image.fileName !== ref.fileName)
			invalid();
		images.push(image);
	}
	return images;
}

export interface WorkflowImageDeletePage {
	keys: string[];
	cursor: string | null;
	nextCursor: string | null;
	truncated: boolean;
}
export interface WorkflowImageDeleteControl {
	cursor: string | null;
	allowedKeys: readonly string[];
	assertReady(): Promise<() => void>;
	issued(page: WorkflowImageDeletePage): Promise<void>;
	acknowledged(page: WorkflowImageDeletePage): Promise<void>;
}

/** Each actual delete has a durable issued record and a known acknowledgement. */
export async function cleanupWorkflowImages(
	bucket: WorkflowImageBucket,
	tediId: string,
	runId: string,
	control: WorkflowImageDeleteControl,
): Promise<void> {
	const owner = prefix(tediId, runId);
	let cursor = control.cursor ?? undefined;
	do {
		assertImageWireReady(await control.assertReady());
		const page = await bucket.list({ prefix: owner, cursor });
		const keys = page.objects.map((object) => object.key);
		if (
			new Set(keys).size !== keys.length ||
			keys.some(
				(key) => !key.startsWith(owner) || !control.allowedKeys.includes(key),
			)
		)
			invalid();
		if (page.truncated && (!page.cursor || !keys.length)) invalid();
		const descriptor = {
			keys,
			cursor: cursor ?? null,
			nextCursor: page.truncated ? page.cursor : null,
			truncated: page.truncated,
		};
		// The list await may revoke authority. Persist intent first, then check
		// at the last boundary immediately before the external delete.
		assertImageWireReady(await control.assertReady());
		await control.issued(descriptor);
		assertImageWireReady(await control.assertReady());
		if (keys.length) await bucket.delete(keys);
		// Receipt acknowledgement belongs to the issued operation even if held.
		await control.acknowledged(descriptor);
		cursor = descriptor.nextCursor ?? undefined;
	} while (cursor);
}
