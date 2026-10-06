import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";

const KEY_INFO = "tedix-portable-snapshot:v1";
const TTL_SECONDS = 3_600;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function signature(secret: string, message: string): Promise<string> {
	const key = await deriveHkdfHmacKey(secret, KEY_INFO);
	return base64UrlEncode(await hmacSha256(key, message));
}

/** A short-lived bearer authorizes only one tedi's read-only bulk snapshot. */
export async function issuePortableSnapshotTicket(input: {
	secret: string;
	organizationId: string;
	tediId: string;
	nowMs: number;
}): Promise<{ token: string; expiresAt: string }> {
	if (!UUID.test(input.organizationId) || !UUID.test(input.tediId)) {
		throw new Error("Invalid portable snapshot identity");
	}
	const expires = Math.floor(input.nowMs / 1_000) + TTL_SECONDS;
	const message = `1.${input.organizationId}.${input.tediId}.${expires}`;
	return {
		token: `${message}.${await signature(input.secret, message)}`,
		expiresAt: new Date(expires * 1_000).toISOString(),
	};
}

export async function verifyPortableSnapshotTicket(input: {
	secret: string;
	token: string;
	nowMs: number;
}): Promise<{ organizationId: string; tediId: string } | null> {
	const parts = input.token.split(".");
	if (parts.length !== 5 || parts[0] !== "1") return null;
	const [, organizationId, tediId, expiresText, supplied] = parts;
	if (
		!organizationId ||
		!UUID.test(organizationId) ||
		!tediId ||
		!UUID.test(tediId) ||
		!expiresText ||
		!/^\d{10}$/.test(expiresText) ||
		!supplied ||
		!Number.isSafeInteger(Number(expiresText)) ||
		Number(expiresText) * 1_000 <= input.nowMs
	) {
		return null;
	}
	const message = parts.slice(0, 4).join(".");
	const expected = await signature(input.secret, message);
	if (expected.length !== supplied.length) return null;
	let difference = 0;
	for (let index = 0; index < expected.length; index++) {
		difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
	}
	return difference === 0 ? { organizationId, tediId } : null;
}
