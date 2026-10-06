import { base64UrlEncode } from "@tedix/auth/utils";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";

const KEY_INFO = "tedix-portable-import:v1";
const TTL_SECONDS = 3_600;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

async function signature(secret: string, message: string): Promise<string> {
	const key = await deriveHkdfHmacKey(secret, KEY_INFO);
	return base64UrlEncode(await hmacSha256(key, message));
}

/** A write bearer is bound to one paused tedi and one validated manifest. */
export async function issuePortableImportTicket(input: {
	secret: string;
	organizationId: string;
	tediId: string;
	sourceTediId: string;
	manifestSha256: string;
	nowMs: number;
}): Promise<{ token: string; expiresAt: string }> {
	if (
		!UUID.test(input.organizationId) ||
		!UUID.test(input.tediId) ||
		!UUID.test(input.sourceTediId) ||
		!SHA256.test(input.manifestSha256)
	) {
		throw new Error("Invalid portable import identity");
	}
	const expires = Math.floor(input.nowMs / 1_000) + TTL_SECONDS;
	const message = `i1.${input.organizationId}.${input.tediId}.${input.sourceTediId}.${input.manifestSha256}.${expires}`;
	return {
		token: `${message}.${await signature(input.secret, message)}`,
		expiresAt: new Date(expires * 1_000).toISOString(),
	};
}

export async function verifyPortableImportTicket(input: {
	secret: string;
	token: string;
	nowMs: number;
}): Promise<{
	organizationId: string;
	tediId: string;
	sourceTediId: string;
	manifestSha256: string;
} | null> {
	const parts = input.token.split(".");
	if (parts.length !== 7 || parts[0] !== "i1") return null;
	const [
		,
		organizationId,
		tediId,
		sourceTediId,
		manifestSha256,
		expiresText,
		supplied,
	] = parts;
	if (
		!organizationId ||
		!UUID.test(organizationId) ||
		!tediId ||
		!UUID.test(tediId) ||
		!sourceTediId ||
		!UUID.test(sourceTediId) ||
		!manifestSha256 ||
		!SHA256.test(manifestSha256) ||
		!expiresText ||
		!/^\d{10}$/.test(expiresText) ||
		!supplied ||
		!Number.isSafeInteger(Number(expiresText)) ||
		Number(expiresText) * 1_000 <= input.nowMs
	) {
		return null;
	}
	const message = parts.slice(0, 6).join(".");
	const expected = await signature(input.secret, message);
	if (expected.length !== supplied.length) return null;
	let difference = 0;
	for (let index = 0; index < expected.length; index++) {
		difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
	}
	return difference === 0
		? { organizationId, tediId, sourceTediId, manifestSha256 }
		: null;
}
