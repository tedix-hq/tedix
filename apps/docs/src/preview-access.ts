import type { AppBindings } from "./types";

const PREVIEW_TTL_SECONDS = 5 * 60;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;

function base64Url(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function signature(
	env: AppBindings,
	orgSlug: string,
	buildId: string,
	expiresAt: number,
): Promise<string> {
	if (!env.PLATFORM_SERVICE_TOKEN) {
		throw new Error("Preview signing is unavailable");
	}
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.PLATFORM_SERVICE_TOKEN),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64Url(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`${orgSlug}\n${buildId}\n${expiresAt}`),
		),
	);
}

export async function createPreviewAccess(input: {
	buildId: string;
	env: AppBindings;
	orgSlug: string;
}): Promise<{ expiresAt: number; previewUrl: string }> {
	const expiresAt = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS;
	const signed = await signature(
		input.env,
		input.orgSlug,
		input.buildId,
		expiresAt,
	);
	const url = new URL(`/preview/${input.buildId}/`, input.env.DOCS_ADMIN_URL);
	url.searchParams.set("org", input.orgSlug);
	url.searchParams.set("expires", String(expiresAt));
	url.searchParams.set("signature", signed);
	return { expiresAt, previewUrl: url.toString() };
}

function cookieValue(request: Request): string | null {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return null;
	for (const pair of cookie.split(";")) {
		const [name, ...value] = pair.trim().split("=");
		if (name === "tedix_docs_preview") return value.join("=") || null;
	}
	return null;
}

export function previewAccessOrg(request: Request): string | null {
	const query = new URL(request.url).searchParams.get("org");
	const cookieOrg = cookieValue(request)?.split(".")[0];
	const value = query ?? cookieOrg ?? null;
	return value && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : null;
}

export async function authorizePreviewAccess(input: {
	buildId: string;
	env: AppBindings;
	orgSlug: string;
	request: Request;
}): Promise<{ setCookie: string | null } | null> {
	const url = new URL(input.request.url);
	const queryExpires = url.searchParams.get("expires");
	const querySignature = url.searchParams.get("signature");
	const cookie = cookieValue(input.request)?.split(".");
	const expiresRaw = queryExpires ?? cookie?.[1] ?? null;
	const provided = querySignature ?? cookie?.[2] ?? null;
	if (!expiresRaw || !provided || !SIGNATURE_RE.test(provided)) return null;
	const expiresAt = Number(expiresRaw);
	const now = Math.floor(Date.now() / 1000);
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= now ||
		expiresAt > now + PREVIEW_TTL_SECONDS + 30
	) {
		return null;
	}
	const expected = await signature(
		input.env,
		input.orgSlug,
		input.buildId,
		expiresAt,
	);
	let mismatch = provided.length ^ expected.length;
	for (let index = 0; index < expected.length; index += 1) {
		mismatch |=
			expected.charCodeAt(index) ^ provided.charCodeAt(index % provided.length);
	}
	if (mismatch !== 0) return null;
	const fromQuery = Boolean(queryExpires && querySignature);
	return {
		setCookie: fromQuery
			? [
					`tedix_docs_preview=${input.orgSlug}.${expiresAt}.${expected}`,
					`Max-Age=${Math.max(1, expiresAt - now)}`,
					`Path=/preview/${input.buildId}`,
					"HttpOnly",
					"Secure",
					"SameSite=Strict",
				].join("; ")
			: null,
	};
}
