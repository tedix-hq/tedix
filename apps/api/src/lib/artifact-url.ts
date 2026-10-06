/**
 * Short-lived signed URLs for serving durable tedi deliverable artifacts
 * (`record_artifact` → `tedi_artifacts`) directly in a browser — the
 * "temporary shareable link" for a generated report / dashboard / PDF / CSV /
 * image / video.
 *
 * Unlike skill-media (base64-in-JSON), a `tedi_artifacts` row points at a RAW R2
 * object (`uri = r2://bucket/key`) written verbatim by
 * `recordDeliverableArtifact`. The serve route (`GET /artifacts/s/:tediId/:artifactId`)
 * streams that object with its stored `mimeType`.
 *
 * Only reviewed-release (`v=2`) links exist: each binds an approval id and
 * exact digest, and every byte read rechecks that approval, its reviewer's
 * active ownership, and the immutable body. Revocation therefore stops an
 * already-minted URL.
 *
 * Token = HMAC-SHA256 over (tediId, artifactId, approvalId, digest, exp) with
 * an HKDF-derived subkey of `SECRETS_MASTER_KEY` (the master key never directly
 * signs request-facing tokens — defense in depth). Every field is inside the
 * signed message, so none can be swapped or extended on a minted URL.
 */

import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";

// HKDF info label — bump the version suffix to rotate all artifact-URL signatures.
const ARTIFACT_RELEASE_URL_KEY_INFO = "tedix-artifact-release-url:v2";

/** Default share-link lifetime (1 hour). */
export const ARTIFACT_SHARE_DEFAULT_TTL_SECONDS = 3600;
/** Hard ceiling on a share-link lifetime (7 days) — a governed link is never indefinite. */
export const ARTIFACT_SHARE_MAX_TTL_SECONDS = 7 * 24 * 3600;

async function releaseHmac(secret: string, msg: string): Promise<string> {
	const key = await deriveHkdfHmacKey(secret, ARTIFACT_RELEASE_URL_KEY_INFO);
	return base64UrlEncode(await hmacSha256(key, msg));
}

/** Clamp a requested TTL into `[1s, ARTIFACT_SHARE_MAX_TTL_SECONDS]`. */
export function clampArtifactTtlSeconds(ttlSeconds?: number): number {
	if (!ttlSeconds || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
		return ARTIFACT_SHARE_DEFAULT_TTL_SECONDS;
	}
	return Math.min(Math.floor(ttlSeconds), ARTIFACT_SHARE_MAX_TTL_SECONDS);
}

function releaseTokenMessage(
	tediId: string,
	artifactId: string,
	approvalId: string,
	contentDigest: string,
	exp: number,
): string {
	return ["2", tediId, artifactId, approvalId, contentDigest, String(exp)]
		.map(encodeURIComponent)
		.join("|");
}

export async function signArtifactReleaseUrl(opts: {
	baseUrl: string;
	secret: string;
	tediId: string;
	artifactId: string;
	approvalId: string;
	contentDigest: string;
	nowMs: number;
	ttlSeconds?: number;
}): Promise<{ url: string; expiresAt: string }> {
	if (!/^[a-f0-9]{64}$/.test(opts.contentDigest))
		throw new Error("Invalid artifact release digest");
	const exp =
		Math.floor(opts.nowMs / 1000) + clampArtifactTtlSeconds(opts.ttlSeconds);
	const sig = await releaseHmac(
		opts.secret,
		releaseTokenMessage(
			opts.tediId,
			opts.artifactId,
			opts.approvalId,
			opts.contentDigest,
			exp,
		),
	);
	const url = new URL(
		`/artifacts/s/${encodeURIComponent(opts.tediId)}/${encodeURIComponent(opts.artifactId)}`,
		opts.baseUrl,
	);
	url.searchParams.set("v", "2");
	url.searchParams.set("approval", opts.approvalId);
	url.searchParams.set("digest", opts.contentDigest);
	url.searchParams.set("exp", String(exp));
	url.searchParams.set("sig", sig);
	return { url: url.toString(), expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyArtifactReleaseToken(opts: {
	secret: string;
	tediId: string;
	artifactId: string;
	approvalId: string;
	contentDigest: string;
	exp: number;
	sig: string;
	nowMs: number;
}): Promise<boolean> {
	if (
		!Number.isSafeInteger(opts.exp) ||
		opts.exp * 1000 <= opts.nowMs ||
		!/^[a-f0-9]{64}$/.test(opts.contentDigest)
	)
		return false;
	const expected = await releaseHmac(
		opts.secret,
		releaseTokenMessage(
			opts.tediId,
			opts.artifactId,
			opts.approvalId,
			opts.contentDigest,
			opts.exp,
		),
	);
	if (expected.length !== opts.sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ opts.sig.charCodeAt(i);
	return diff === 0;
}
