/**
 * Shared ID generation utilities
 */

/**
 * Generate a URL-safe random ID using the nanoid alphabet.
 * Uses Web Crypto for secure randomness — works in Cloudflare Workers.
 */
export function nanoid(size = 21): string {
	const alphabet =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
	let id = "";
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	for (let i = 0; i < size; i++) {
		id += alphabet[bytes[i]! & 63];
	}
	return id;
}
