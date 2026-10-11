/**
 * Fleet-scoped `GET /__internal/master-key-fingerprint`.
 *
 * `SECRETS_MASTER_KEY` is set by hand on every Worker that decrypts tedi
 * secrets. When this Worker's copy drifts from apps/api's, every secret here
 * silently fails to decrypt (the resolve cache swallows the error), and nothing
 * short of reading both secrets says which one is wrong. This route answers
 * with a non-reversible fingerprint per key in the rotation window so apps/api
 * can compare the fleet without any Worker revealing key material.
 *
 * Mounted before tedi resolution: the answer is per Worker, not per tedi. The
 * caller must arrive over a service binding; the index.ts dispatch owns that
 * check so a public request falls through to the ordinary 404.
 */

import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";

export const MASTER_KEY_FINGERPRINT_PATH = "/__internal/master-key-fingerprint";

export interface WorkerMasterKeyFingerprint {
	worker: string;
	/** Window order: index 0 is the key that encrypts. Empty when `error` is set. */
	fingerprints: string[];
	error?: string;
}

/** Fingerprint one Worker's master key value; never throws and never echoes the value. */
export async function describeMasterKey(
	worker: string,
	masterKeyValue: string | undefined,
): Promise<WorkerMasterKeyFingerprint> {
	if (!masterKeyValue) return { worker, fingerprints: [], error: "unset" };
	try {
		return {
			worker,
			fingerprints: await masterKeyFingerprints(masterKeyValue),
		};
	} catch (error) {
		return {
			worker,
			fingerprints: [],
			error: error instanceof Error ? error.message : "malformed",
		};
	}
}

export async function handleMasterKeyFingerprint(
	env: Pick<Cloudflare.Env, "SECRETS_MASTER_KEY">,
): Promise<Response> {
	return Response.json(
		await describeMasterKey("tedi-runtime", env.SECRETS_MASTER_KEY),
	);
}
