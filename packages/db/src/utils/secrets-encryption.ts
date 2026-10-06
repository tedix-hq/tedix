/**
 * Organization Secrets Encryption Utilities
 *
 * Uses Web Crypto API (available in Cloudflare Workers) for:
 * - Per-org key derivation via HKDF
 * - AES-256-GCM encryption/decryption
 *
 * Security model:
 * - Master key: 32-byte key stored in Cloudflare Secrets Store. During a
 *   rotation it may hold a comma-separated LIST of keys: encryption always
 *   uses the first, decryption tries each in order. That lets a rotation run
 *   with no downtime and no change at any decrypt call site.
 * - Per-org keys: Derived using HKDF(master, orgId, "org-secrets")
 * - Encryption: AES-256-GCM with random 12-byte IV per operation
 * - Storage format: base64(iv[12] + ciphertext + authTag[16])
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for GCM
const ORG_INFO = new TextEncoder().encode("org-secrets");
const APP_INFO = new TextEncoder().encode("app-secrets");
const TEDI_INFO = new TextEncoder().encode("tedi-secrets");
const CATALOG_APP_INFO = new TextEncoder().encode("catalog-app-secrets");

/**
 * Timing-safe string comparison for Cloudflare Workers
 * Prevents timing attacks by ensuring constant-time comparison
 */
export function timingSafeCompare(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	// If lengths differ, return false but still do constant-time comparison
	// to prevent timing attacks based on early return
	const lengthsDiffer = aBytes.byteLength !== bBytes.byteLength;
	const maxLength = Math.max(aBytes.byteLength, bBytes.byteLength);

	let result = 0;

	// Compare byte by byte in constant time
	for (let i = 0; i < maxLength; i++) {
		const aByte = i < aBytes.byteLength ? aBytes[i]! : 0;
		const bByte = i < bBytes.byteLength ? bBytes[i]! : 0;
		result |= aByte ^ bByte;
	}

	// Return false if lengths differ OR if any bytes differ
	return !lengthsDiffer && result === 0;
}

/**
 * Decode base64 to Uint8Array
 */
function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Encode Uint8Array to base64
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		// The loop bound guarantees this indexed byte exists.
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

/**
 * Split a `SECRETS_MASTER_KEY` value into its ordered keys.
 *
 * A single key is the steady state. A comma-separated list is the rotation
 * window: index 0 is the key everything is encrypted with from now on, and the
 * rest are older keys still needed to read rows that have not been re-encrypted
 * yet. `scripts/secrets/rotate-master-key.ts` drains that backlog, after which
 * the older keys are dropped from the value.
 */
export function splitMasterKeys(masterKeyBase64: string): string[] {
	const keys = masterKeyBase64
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
	if (keys.length === 0) {
		throw new Error("Master key is empty; expected one or more base64 keys");
	}
	return keys;
}

/**
 * Import master key from base64 string for HKDF derivation
 */
async function importMasterKey(masterKeyBase64: string): Promise<CryptoKey> {
	let keyBytes: Uint8Array;
	try {
		keyBytes = base64ToBytes(masterKeyBase64);
	} catch (error) {
		// A rotation window puts two keys in one variable, so a typo in either
		// half lands here. Say which shape was expected rather than surfacing
		// atob's "Invalid character".
		throw new Error(
			"Master key is not valid base64. Generate with: openssl rand -base64 32",
			{ cause: error },
		);
	}

	if (keyBytes.length !== 32) {
		throw new Error(
			`Master key must be 32 bytes, got ${keyBytes.length}. Generate with: openssl rand -base64 32`,
		);
	}

	// Create a proper ArrayBuffer copy to satisfy Web Crypto API types
	const keyBuffer = new ArrayBuffer(keyBytes.length);
	new Uint8Array(keyBuffer).set(keyBytes);
	return crypto.subtle.importKey("raw", keyBuffer, "HKDF", false, [
		"deriveKey",
	]);
}

/**
 * Derive a per-organization encryption key using HKDF
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param orgId - Organization ID used as salt for key derivation
 * @returns AES-GCM CryptoKey for this organization
 */
export async function deriveOrgKey(
	masterKeyBase64: string,
	orgId: string,
): Promise<CryptoKey> {
	const masterKey = await importMasterKey(splitMasterKeys(masterKeyBase64)[0]!);
	const salt = new TextEncoder().encode(orgId);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: ORG_INFO,
		},
		masterKey,
		{
			name: ALGORITHM,
			length: KEY_LENGTH,
		},
		false, // Not extractable
		["encrypt", "decrypt"],
	);
}

/**
 * Derive a per-app encryption key using HKDF
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param appId - App ID used as salt for key derivation
 * @returns AES-GCM CryptoKey for this app
 */
export async function deriveAppKey(
	masterKeyBase64: string,
	appId: string,
): Promise<CryptoKey> {
	const masterKey = await importMasterKey(splitMasterKeys(masterKeyBase64)[0]!);
	const salt = new TextEncoder().encode(appId);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: APP_INFO,
		},
		masterKey,
		{
			name: ALGORITHM,
			length: KEY_LENGTH,
		},
		false, // Not extractable
		["encrypt", "decrypt"],
	);
}

/**
 * Derive a per-tedi encryption key using HKDF
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param tediId - Tedi ID used as salt for key derivation
 * @returns AES-GCM CryptoKey for this tedi
 */
export async function deriveTediKey(
	masterKeyBase64: string,
	tediId: string,
): Promise<CryptoKey> {
	const masterKey = await importMasterKey(splitMasterKeys(masterKeyBase64)[0]!);
	const salt = new TextEncoder().encode(tediId);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: TEDI_INFO,
		},
		masterKey,
		{
			name: ALGORITHM,
			length: KEY_LENGTH,
		},
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Encrypt a secret value for storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param orgId - Organization ID for key derivation
 * @param plaintext - Secret value to encrypt
 * @returns Base64 encoded string: iv[12] + ciphertext + authTag[16]
 */
export async function encryptSecret(
	masterKeyBase64: string,
	orgId: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveOrgKey(masterKeyBase64, orgId);

	// Generate random IV (never reuse with same key!)
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	// Encrypt with AES-GCM (includes authentication tag)
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: ALGORITHM,
			iv,
		},
		key,
		plaintextBytes,
	);

	// Combine: iv + ciphertext (includes auth tag)
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return bytesToBase64(combined);
}

/**
 * Decrypt with the first key that authenticates.
 *
 * AES-GCM verifies its tag, so a wrong key throws rather than returning
 * plausible bytes — trying keys in order is safe, and the ciphertext needs no
 * key id. Order matters only for cost: the primary key is tried first, so the
 * steady state is one attempt and a rotation window costs one extra derive per
 * not-yet-migrated row.
 */
async function decryptWithKeys(
	keys: CryptoKey[],
	encryptedValue: string,
): Promise<string> {
	const combined = base64ToBytes(encryptedValue);
	if (combined.length < IV_LENGTH + 16) {
		// Minimum: IV + auth tag
		throw new Error("Invalid encrypted value: too short");
	}
	const iv = combined.slice(0, IV_LENGTH);
	const ciphertext = combined.slice(IV_LENGTH);

	let lastError: unknown;
	for (const key of keys) {
		try {
			const plaintextBytes = await crypto.subtle.decrypt(
				{ name: ALGORITHM, iv },
				key,
				ciphertext,
			);
			return new TextDecoder().decode(plaintextBytes);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Unable to decrypt with any of the ${String(keys.length)} configured master key(s)`,
		{ cause: lastError },
	);
}

/**
 * Decrypt a secret value from storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param orgId - Organization ID for key derivation
 * @param encryptedValue - Base64 encoded string from encryptSecret()
 * @returns Decrypted plaintext secret
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export async function decryptSecret(
	masterKeyBase64: string,
	orgId: string,
	encryptedValue: string,
): Promise<string> {
	const keys = await Promise.all(
		splitMasterKeys(masterKeyBase64).map((masterKey) =>
			deriveOrgKey(masterKey, orgId),
		),
	);
	return decryptWithKeys(keys, encryptedValue);
}

// =============================================================================
// APP-LEVEL ENCRYPTION (for app_secrets table)
// =============================================================================

/**
 * Encrypt a secret value for app-level storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param appId - App ID for key derivation
 * @param plaintext - Secret value to encrypt
 * @returns Base64 encoded string: iv[12] + ciphertext + authTag[16]
 */
export async function encryptAppSecret(
	masterKeyBase64: string,
	appId: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveAppKey(masterKeyBase64, appId);

	// Generate random IV (never reuse with same key!)
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	// Encrypt with AES-GCM (includes authentication tag)
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: ALGORITHM,
			iv,
		},
		key,
		plaintextBytes,
	);

	// Combine: iv + ciphertext (includes auth tag)
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return bytesToBase64(combined);
}

/**
 * Decrypt a secret value from app-level storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param appId - App ID for key derivation
 * @param encryptedValue - Base64 encoded string from encryptAppSecret()
 * @returns Decrypted plaintext secret
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export async function decryptAppSecret(
	masterKeyBase64: string,
	appId: string,
	encryptedValue: string,
): Promise<string> {
	const keys = await Promise.all(
		splitMasterKeys(masterKeyBase64).map((masterKey) =>
			deriveAppKey(masterKey, appId),
		),
	);
	return decryptWithKeys(keys, encryptedValue);
}

// =============================================================================
// TEDI-LEVEL ENCRYPTION (for tedi_secrets table)
// =============================================================================

/**
 * Encrypt a secret value for tedi-level storage
 */
export async function encryptTediSecret(
	masterKeyBase64: string,
	tediId: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveTediKey(masterKeyBase64, tediId);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		key,
		plaintextBytes,
	);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return bytesToBase64(combined);
}

/**
 * Decrypt a secret value from tedi-level storage
 */
export async function decryptTediSecret(
	masterKeyBase64: string,
	tediId: string,
	encryptedValue: string,
): Promise<string> {
	const keys = await Promise.all(
		splitMasterKeys(masterKeyBase64).map((masterKey) =>
			deriveTediKey(masterKey, tediId),
		),
	);
	return decryptWithKeys(keys, encryptedValue);
}

// =============================================================================
// CATALOG APP-LEVEL ENCRYPTION (for app_catalog.scan_auth_headers)
// =============================================================================

/**
 * Derive a per-catalog-app encryption key using HKDF
 */
async function deriveCatalogAppKey(
	masterKeyBase64: string,
	catalogAppId: string,
): Promise<CryptoKey> {
	const masterKey = await importMasterKey(splitMasterKeys(masterKeyBase64)[0]!);
	const salt = new TextEncoder().encode(catalogAppId);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: CATALOG_APP_INFO,
		},
		masterKey,
		{
			name: ALGORITHM,
			length: KEY_LENGTH,
		},
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Encrypt scan auth headers for catalog app storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param catalogAppId - Catalog app ID for key derivation
 * @param plaintext - JSON-stringified headers to encrypt
 * @returns Base64 encoded string: iv[12] + ciphertext + authTag[16]
 */
export async function encryptCatalogAppSecret(
	masterKeyBase64: string,
	catalogAppId: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveCatalogAppKey(masterKeyBase64, catalogAppId);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ALGORITHM, iv },
		key,
		plaintextBytes,
	);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return bytesToBase64(combined);
}

/**
 * Decrypt scan auth headers from catalog app storage
 *
 * @param masterKeyBase64 - Base64 encoded 32-byte master key
 * @param catalogAppId - Catalog app ID for key derivation
 * @param encryptedValue - Base64 encoded string from encryptCatalogAppSecret()
 * @returns Decrypted plaintext
 */
export async function decryptCatalogAppSecret(
	masterKeyBase64: string,
	catalogAppId: string,
	encryptedValue: string,
): Promise<string> {
	const keys = await Promise.all(
		splitMasterKeys(masterKeyBase64).map((masterKey) =>
			deriveCatalogAppKey(masterKey, catalogAppId),
		),
	);
	return decryptWithKeys(keys, encryptedValue);
}

/**
 * Generate a hint for UI display (last 4 characters)
 *
 * @param value - The secret value
 * @returns Hint string like "...4bfb" or "..." if too short
 */
export function generateSecretHint(value: string): string {
	if (value.length <= 4) {
		return "...";
	}
	return `...${value.slice(-4)}`;
}

/**
 * Generate a new master key (for initial setup)
 * Run this once and store in Cloudflare Secrets Store
 *
 * @returns Base64 encoded 32-byte key
 */
export function generateMasterKey(): string {
	const key = crypto.getRandomValues(new Uint8Array(32));
	return bytesToBase64(key);
}

/*
 * Usage example:
 *
 * // Setup (one-time): Generate master key and store in Cloudflare Secrets
 * const masterKey = generateMasterKey();
 * // Run: wrangler secret put SECRETS_MASTER_KEY
 * // Paste the base64 key when prompted
 *
 * // Encrypt a customer's API key
 * const encrypted = await encryptSecret(
 *   env.SECRETS_MASTER_KEY,
 *   "org_abc123",
 *   "sk_live_customer_api_key_here"
 * );
 * // Store `encrypted` in D1 organization_secrets.encrypted_value
 *
 * // Decrypt when needed
 * const apiKey = await decryptSecret(
 *   env.SECRETS_MASTER_KEY,
 *   "org_abc123",
 *   encrypted
 * );
 *
 * // Generate hint for UI
 * const hint = generateSecretHint("sk_live_customer_api_key_here");
 * // Returns: "...here"
 */
