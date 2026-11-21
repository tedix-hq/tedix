import { sha256Hex, timingSafeEqual } from "@tedix/worker-kit/crypto";

export const THEME_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const THEME_PREVIEW_PATH = "/_tedix/theme-preview/";
export interface CmsThemeCandidate {
	ready: boolean;
	id: string;
	siteId: string;
	slug: string;
	restoreEpoch: number;
	sourceCommit: string;
	version: number;
	expectedActiveVersion: number | null;
	stagingAttemptId: string;
	r2Prefix: string;
	etag: string;
	createdAt: string;
	expiresAt: string;
	summary?: string;
}

export function themeCandidateKey(slug: string, id: string): string {
	if (!/^[a-z0-9-]+$/.test(slug) || !/^cms-[a-z0-9-]+$/.test(id))
		throw new Error("Invalid theme candidate identity");
	return `theme-candidates/${slug}/${id}.json`;
}

async function previewSignature(
	secret: string,
	candidate: CmsThemeCandidate,
	expires: number,
) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const message = JSON.stringify([
		"cms-theme-preview:v1",
		candidate.siteId,
		candidate.slug,
		candidate.restoreEpoch,
		candidate.id,
		candidate.etag,
		expires,
	]);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(message),
	);
	return Array.from(new Uint8Array(signature), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export async function signThemePreview(
	secret: string | undefined,
	candidate: CmsThemeCandidate,
	now = Date.now(),
) {
	if (!secret) throw new Error("CMS preview signing is unavailable");
	const expires = Math.min(
		now + 60 * 60 * 1000,
		Date.parse(candidate.expiresAt),
	);
	if (!candidate.ready || !Number.isFinite(expires) || expires <= now)
		throw new Error("Theme candidate expired");
	return `${expires}.${await previewSignature(secret, candidate, expires)}`;
}

export async function verifyThemePreview(
	secret: string | undefined,
	candidate: CmsThemeCandidate,
	token: string | null,
	now = Date.now(),
) {
	if (
		!candidate.ready ||
		!secret ||
		!token ||
		!/^[0-9]{13}\.[a-f0-9]{64}$/.test(token)
	)
		return false;
	const [expiry, presented] = token.split(".");
	const expires = Number(expiry);
	if (
		expires <= now ||
		expires > Date.parse(candidate.expiresAt) ||
		!Number.isFinite(Date.parse(candidate.expiresAt))
	)
		return false;
	const expected = await previewSignature(secret, candidate, expires);
	return timingSafeEqual(expected, presented!);
}

export async function themeCandidateEtag(
	modules: Record<string, { js: string }>,
) {
	const parts: string[] = [];
	for (const path of Object.keys(modules).sort())
		parts.push(`${path}:${await sha256Hex(modules[path]!.js)}`);
	return sha256Hex(parts.join("\n"));
}
