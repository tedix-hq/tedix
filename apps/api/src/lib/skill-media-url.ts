/**
 * Short-lived signed URLs for serving skill-run media artifacts directly in a
 * browser.
 *
 * Skill workflows persist generated media as base64-in-JSON artifacts
 * (`outputs/{step}.json` → `{ value: { imageBase64 | bytesBase64Encoded, mimeType } }`).
 * `getRunArtifact({ mediaUrl: true })` mints a signed URL pointing at the public
 * `GET /skill-media/:runId/*path` route; that route verifies the token, fetches
 * the artifact, extracts + base64-decodes the bytes, and streams them with the
 * right Content-Type. The decode runs in a plain request handler (no workflow /
 * durable-step / bridge-RPC context), so the large-payload decode stall that
 * affects in-step bridge writes does not apply here.
 *
 * Token = HMAC-SHA256(`${runId}|${path}|${exp}`, key=<derived>), base64url, where
 * the HMAC key is an HKDF-derived subkey of `SECRETS_MASTER_KEY` (the master key
 * itself never directly signs request-facing tokens — defense in depth). The
 * `path` and `exp` are inside the signed message, so neither can be swapped or
 * extended on a minted URL. The key never leaves the server; tokens are opaque +
 * expiring.
 *
 * Capability model: the signed URL *is* the capability. Org-ownership is checked
 * at MINT time (in the authed getRunArtifact RPC); the public serve route is a
 * pure token-gate. Anyone the URL is forwarded to can view the media until it
 * expires (~15 min). Use only for non-sensitive generated assets.
 */

import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";

// HKDF info label — bump the version suffix to rotate all media-URL signatures.
const MEDIA_URL_KEY_INFO = "tedix-skill-media-url:v1";

async function hmac(secret: string, msg: string): Promise<string> {
	const key = await deriveHkdfHmacKey(secret, MEDIA_URL_KEY_INFO);
	return base64UrlEncode(await hmacSha256(key, msg));
}

const DOWNLOAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,159}$/;

function normalizedDownloadName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!DOWNLOAD_NAME_PATTERN.test(value)) {
		throw new Error("Invalid signed media download name");
	}
	return value;
}

function tokenMessage(
	runId: string,
	path: string,
	exp: number,
	downloadName?: string,
): string {
	return `${runId}|${path}|${exp}${downloadName ? `|download:${downloadName}` : ""}`;
}

/** Mint a signed media URL. `ttlSeconds` default 900 (15 min). */
export async function signMediaUrl(opts: {
	baseUrl: string;
	secret: string;
	runId: string;
	path: string;
	nowMs: number;
	ttlSeconds?: number;
	downloadName?: string;
}): Promise<{ url: string; expiresAt: string }> {
	const downloadName = normalizedDownloadName(opts.downloadName);
	const exp = Math.floor(opts.nowMs / 1000) + (opts.ttlSeconds ?? 900);
	const sig = await hmac(
		opts.secret,
		tokenMessage(opts.runId, opts.path, exp, downloadName),
	);
	const u = new URL(
		`/skill-media/${encodeURIComponent(opts.runId)}/${opts.path}`,
		opts.baseUrl,
	);
	u.searchParams.set("exp", String(exp));
	u.searchParams.set("sig", sig);
	if (downloadName) u.searchParams.set("download", downloadName);
	return { url: u.toString(), expiresAt: new Date(exp * 1000).toISOString() };
}

/** Constant-time-ish verify of a media token. */
export async function verifyMediaToken(opts: {
	secret: string;
	runId: string;
	path: string;
	exp: number;
	sig: string;
	nowMs: number;
	downloadName?: string;
}): Promise<boolean> {
	if (!Number.isFinite(opts.exp) || opts.exp * 1000 < opts.nowMs) return false;
	let downloadName: string | undefined;
	try {
		downloadName = normalizedDownloadName(opts.downloadName);
	} catch {
		return false;
	}
	const expected = await hmac(
		opts.secret,
		tokenMessage(opts.runId, opts.path, opts.exp, downloadName),
	);
	if (expected.length !== opts.sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ opts.sig.charCodeAt(i);
	return diff === 0;
}

/**
 * Locate the base64 media field + mime in a base64-in-JSON artifact's content,
 * WITHOUT decoding. The public serve route decodes to bytes for streaming; the
 * authed `getRunArtifact({ mediaInline: true })` RPC returns this base64 + mime
 * directly so a session-authenticated caller (e.g. Tedix OS) can render a `data:`
 * URL — no expiring token, survives transcript scrollback.
 * Recognizes the conventional fields our media skills emit; returns null when no
 * media field is present.
 */
export function extractMediaBase64(
	content: string,
): { base64: string; mimeType: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	// Artifact shape is { value: <step return>, durationMs } — unwrap value if present.
	const root = parsed as Record<string, unknown>;
	const val = (root?.value ?? root) as Record<string, unknown>;
	const b64 =
		(val?.imageBase64 as string) ??
		(val?.bytesBase64Encoded as string) ??
		(val?.audioBase64 as string) ??
		(val?.videoBase64 as string);
	if (typeof b64 !== "string" || b64.length === 0) return null;
	const mimeType = (val?.mimeType as string) ?? "application/octet-stream";
	return { base64: b64, mimeType };
}

/**
 * Extract decoded media bytes + mime from a base64-in-JSON artifact's content.
 * Returns null when no media field is present.
 */
export function extractMediaBytes(
	content: string,
): { bytes: Uint8Array; mimeType: string } | null {
	const media = extractMediaBase64(content);
	if (!media) return null;
	let bin: string;
	try {
		bin = atob(media.base64);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return { bytes, mimeType: media.mimeType };
}
