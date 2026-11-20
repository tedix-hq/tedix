import { base64UrlDecode, base64UrlEncode } from "./utils";

/**
 * The desktop app sends a fresh public key when it opens the browser to sign
 * in. The one-time sign-in token is sealed to that key, so the code that
 * travels back through the browser and the `tedix://` link is readable only
 * by the app instance that asked for it. P-256 key agreement with a one-off
 * sender key, HKDF-SHA-256, AES-256-GCM. The desktop app opens the code with
 * the same steps in `apps/desktop/src/main.ts`.
 */
export const DESKTOP_SIGN_IN_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;

const curve = { name: "ECDH", namedCurve: "P-256" } as const;
const info = new TextEncoder().encode("tedix-desktop-sign-in");

async function sealingKey(
	privateKey: CryptoKey,
	publicKey: CryptoKey,
): Promise<CryptoKey> {
	const shared = await crypto.subtle.deriveBits(
		// The Workers type spells this field differently from the web standard.
		{ name: "ECDH", public: publicKey } as Parameters<
			SubtleCrypto["deriveBits"]
		>[0],
		privateKey,
		256,
	);
	const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function sealDesktopSignInCode(
	appPublicKey: string,
	token: string,
): Promise<string> {
	const raw = DESKTOP_SIGN_IN_KEY_PATTERN.test(appPublicKey)
		? base64UrlDecode(appPublicKey)
		: null;
	if (!raw) throw new Error("Invalid desktop app key");
	const recipient = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(raw),
		curve,
		false,
		[],
	);
	const sender = (await crypto.subtle.generateKey(curve, false, [
		"deriveBits",
	])) as CryptoKeyPair;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await sealingKey(sender.privateKey, recipient),
		new TextEncoder().encode(token),
	);
	const senderKey = new Uint8Array(
		(await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer,
	);
	const code = new Uint8Array(65 + 12 + sealed.byteLength);
	code.set(senderKey, 0);
	code.set(iv, 65);
	code.set(new Uint8Array(sealed), 77);
	return base64UrlEncode(code);
}

/** Throws unless `privateKey` belongs to the key the code was sealed to. */
export async function openDesktopSignInCode(
	privateKey: CryptoKey,
	code: string,
): Promise<string> {
	const bytes = base64UrlDecode(code);
	if (!bytes || bytes.length < 78) throw new Error("Invalid sign-in code");
	const sender = await crypto.subtle.importKey(
		"raw",
		bytes.slice(0, 65),
		curve,
		false,
		[],
	);
	const opened = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(65, 77) },
		await sealingKey(privateKey, sender),
		bytes.slice(77),
	);
	return new TextDecoder().decode(opened);
}
