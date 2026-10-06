/**
 * Web Crypto primitives shared by Tedix Workers. Each helper is the one owner
 * of a shape that used to be copied per file; keep them free of application
 * policy (key labels, error contracts, encodings other than hex/raw bytes).
 */

const encoder = new TextEncoder();

function toBytes(input: string | BufferSource): BufferSource {
	return typeof input === "string" ? encoder.encode(input) : input;
}

/** SHA-256 of UTF-8 text or the exact bytes of a buffer, as lowercase hex. */
export async function sha256Hex(input: string | BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", toBytes(input));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Constant-time string comparison. Length mismatch short-circuits, which is the
 * accepted contract for webhook signature checks (the length is not secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

/**
 * HKDF-SHA256 (empty salt, caller-supplied `info` label) from a UTF-8 master
 * secret to a non-extractable HMAC-SHA256 signing key. Bump the `info` label
 * to rotate every signature derived from it.
 */
export async function deriveHkdfHmacKey(
	masterSecret: string,
	info: string,
): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey(
		"raw",
		encoder.encode(masterSecret),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0),
			info: encoder.encode(info),
		},
		ikm,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"],
	);
}

/** HMAC-SHA256 of a UTF-8 message under `key`, as raw bytes. */
export async function hmacSha256(
	key: CryptoKey,
	message: string,
): Promise<Uint8Array> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(message),
	);
	return new Uint8Array(signature);
}
