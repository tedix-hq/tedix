/**
 * The Ed25519 key that signs gateway change record checkpoints.
 *
 * Read from two optional Worker secrets, set by the operator and declared in
 * no checked-in config:
 * - CHANGE_RECORD_SIGNING_KEY: the private key, base64 PKCS#8 DER.
 * - CHANGE_RECORD_SIGNING_KEY_ID: the DSSE `keyid` to write; defaults to
 *   "sha256:" + SHA-256 hex of the public key's SPKI bytes.
 * Without the key the sealer still chains records and writes unsigned
 * checkpoints. Never log the secret or anything derived from the private key.
 */

import {
	importSigningKey,
	type SigningKey,
} from "@tedix/agent-governance/seal";

/** The two secrets, read through this one narrow view of the Worker env. */
interface ChangeRecordSigningSecrets {
	CHANGE_RECORD_SIGNING_KEY?: unknown;
	CHANGE_RECORD_SIGNING_KEY_ID?: unknown;
}

function readSecret(env: object, name: keyof ChangeRecordSigningSecrets) {
	const value = (env as ChangeRecordSigningSecrets)[name];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface ChangeRecordSigningKey {
	privateKey: CryptoKey;
	keyId: string;
	/** Base64 SPKI DER of the public key, safe to publish. */
	publicKeySpki: string;
}

let cached:
	| {
			secret: string;
			keyId: string | null;
			key: Promise<SigningKey>;
	  }
	| undefined;

/**
 * The configured signing key, or null when signing is off. Throws a message
 * without key material when the secret is not an Ed25519 PKCS#8 key.
 */
export async function loadChangeRecordSigningKey(
	env: object,
): Promise<ChangeRecordSigningKey | null> {
	const secret = readSecret(env, "CHANGE_RECORD_SIGNING_KEY");
	if (!secret) return null;
	const keyId = readSecret(env, "CHANGE_RECORD_SIGNING_KEY_ID");
	if (!cached || cached.secret !== secret || cached.keyId !== keyId)
		cached = { secret, keyId, key: importSigningKey(secret) };
	let key: SigningKey;
	try {
		key = await cached.key;
	} catch {
		cached = undefined;
		throw new Error(
			"CHANGE_RECORD_SIGNING_KEY is not a base64 PKCS#8 Ed25519 private key",
		);
	}
	return {
		privateKey: key.privateKey,
		keyId: keyId ?? key.fingerprint,
		publicKeySpki: key.publicKeySpki,
	};
}
