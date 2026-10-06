/**
 * Cloudflare Images (Hosted Images) helpers.
 *
 * Entity images (org/app/tedi logos + avatars) are stored in Cloudflare Images
 * via Direct Creator Upload: the browser uploads straight to the one-time
 * `uploadURL` minted here, avoiding Worker request-body limits. We persist only
 * the public delivery URL on the entity row and derive on-the-fly variants
 * (e.g. `w=64,format=auto`) from the stored original via Flexible Variants.
 *
 * Auth: `CF_IMAGES_TOKEN` is an account-scoped API token with
 * `Account → Cloudflare Images → Edit`. `CF_ACCOUNT_HASH` is the public-safe
 * delivery hash that appears in every imagedelivery.net URL.
 */

const IMAGES_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfImagesEnv {
	CF_ACCOUNT_ID: string;
	CF_IMAGES_TOKEN: string;
	CF_ACCOUNT_HASH: string;
}

/** Default delivery variant. Flexible Variants must be enabled for `w=…` URLs. */
const DEFAULT_VARIANT = "public";

interface CfApiResponse<T> {
	success: boolean;
	result: T;
	errors: Array<{ code: number; message: string }>;
}

function authHeaders(env: CfImagesEnv): HeadersInit {
	return { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` };
}

async function readCfJson<T>(res: Response, action: string): Promise<T> {
	const body = (await res.json()) as CfApiResponse<T>;
	if (!res.ok || !body.success) {
		const detail = body.errors
			?.map((e) => `${e.code}: ${e.message}`)
			.join("; ");
		throw new Error(
			`Cloudflare Images ${action} failed: ${detail || res.status}`,
		);
	}
	return body.result;
}

/**
 * Mint a one-time Direct Creator Upload URL. The browser POSTs the file to the
 * returned `uploadURL`; the resulting image's id equals the returned `id`.
 */
export async function requestDirectUpload(
	env: CfImagesEnv,
	opts: {
		/** Stored on the CF image; used to trace ownership and for cleanup. */
		metadata?: Record<string, string>;
		/** Public delivery by default (entity logos are public). */
		requireSignedURLs?: boolean;
	} = {},
): Promise<{ id: string; uploadURL: string }> {
	const form = new FormData();
	form.set("requireSignedURLs", String(opts.requireSignedURLs ?? false));
	if (opts.metadata) {
		form.set("metadata", JSON.stringify(opts.metadata));
	}

	const res = await fetch(
		`${IMAGES_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/images/v2/direct_upload`,
		{ method: "POST", headers: authHeaders(env), body: form },
	);
	return readCfJson<{ id: string; uploadURL: string }>(res, "direct_upload");
}

/**
 * Server-side upload of raw image bytes to Cloudflare Images (POST images/v1).
 * Used by the programmatic/MCP path; the browser uses Direct Creator Upload.
 */
export async function uploadImageBytes(
	env: CfImagesEnv,
	file: ArrayBuffer,
	opts: {
		filename: string;
		contentType: string;
		metadata?: Record<string, string>;
		requireSignedURLs?: boolean;
	},
): Promise<{ id: string }> {
	const form = new FormData();
	form.append(
		"file",
		new Blob([file], { type: opts.contentType }),
		opts.filename,
	);
	form.set("requireSignedURLs", String(opts.requireSignedURLs ?? false));
	if (opts.metadata) {
		form.set("metadata", JSON.stringify(opts.metadata));
	}

	const res = await fetch(
		`${IMAGES_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/images/v1`,
		{ method: "POST", headers: authHeaders(env), body: form },
	);
	return readCfJson<{ id: string }>(res, "upload");
}

/**
 * Import an image into Cloudflare Images directly from a public URL
 * (POST images/v1 with a `url` field). Used by the R2 → CF Images backfill;
 * Cloudflare fetches the source, so the Worker never streams the bytes.
 */
export async function importImageFromUrl(
	env: CfImagesEnv,
	url: string,
	opts: { metadata?: Record<string, string>; requireSignedURLs?: boolean } = {},
): Promise<{ id: string }> {
	const form = new FormData();
	form.set("url", url);
	form.set("requireSignedURLs", String(opts.requireSignedURLs ?? false));
	if (opts.metadata) {
		form.set("metadata", JSON.stringify(opts.metadata));
	}

	const res = await fetch(
		`${IMAGES_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/images/v1`,
		{ method: "POST", headers: authHeaders(env), body: form },
	);
	return readCfJson<{ id: string }>(res, "import from url");
}

/** Fetch image details — used to confirm a Direct Creator Upload actually landed. */
export async function getCfImage(
	env: CfImagesEnv,
	imageId: string,
): Promise<{
	id: string;
	uploaded: string;
	meta?: Record<string, string>;
} | null> {
	const res = await fetch(
		`${IMAGES_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/images/v1/${imageId}`,
		{ method: "GET", headers: authHeaders(env) },
	);
	if (res.status === 404) return null;
	return readCfJson<{
		id: string;
		uploaded: string;
		meta?: Record<string, string>;
	}>(res, "get image");
}

/** Delete an image and purge all its variants from cache. Idempotent on 404. */
export async function deleteCfImage(
	env: CfImagesEnv,
	imageId: string,
): Promise<void> {
	const res = await fetch(
		`${IMAGES_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/images/v1/${imageId}`,
		{ method: "DELETE", headers: authHeaders(env) },
	);
	if (res.status === 404) return;
	await readCfJson<unknown>(res, "delete image");
}

/** Build a public delivery URL: imagedelivery.net/<hash>/<id>/<variant>. */
export function buildDeliveryUrl(
	accountHash: string,
	imageId: string,
	variant: string = DEFAULT_VARIANT,
): string {
	return `https://imagedelivery.net/${accountHash}/${imageId}/${variant}`;
}

/**
 * Extract the Cloudflare image id from a stored delivery URL. Returns null for
 * URLs that aren't imagedelivery.net (e.g. legacy r2.dev URLs during migration),
 * so callers won't attempt to delete a non-CF asset.
 */
export function extractImageId(url: string | null | undefined): string | null {
	if (!url) return null;
	const match = url.match(
		/imagedelivery\.net\/[^/]+\/([0-9a-fA-F-]{16,})(?:\/|$)/,
	);
	return match?.[1] ?? null;
}
