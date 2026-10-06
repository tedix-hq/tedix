/**
 * @tedix/auth - Utility Functions
 *
 * Cookie token extraction.
 */

// =============================================================================
// COOKIE EXTRACTION
// =============================================================================

/**
 * Extract token from cookie
 *
 * @param cookies - Cookie header value or parsed cookies object
 * @param cookieName - Name of the cookie containing the token
 * @returns Token string or null if not found
 */
export function extractTokenFromCookie(
	cookies: string | Record<string, string> | null | undefined,
	cookieName = "access_token",
): string | null {
	if (!cookies) {
		return null;
	}

	// If cookies is an object (already parsed)
	if (typeof cookies === "object") {
		return cookies[cookieName] || null;
	}

	// Parse cookie string
	const cookieMap = parseCookies(cookies);
	return cookieMap[cookieName] || null;
}

/**
 * Parse cookie header string into key-value pairs
 */
function parseCookies(cookieString: string): Record<string, string> {
	const cookies: Record<string, string> = {};

	for (const cookie of cookieString.split(";")) {
		const [name, ...valueParts] = cookie.split("=");
		if (name) {
			const trimmedName = name.trim();
			const value = valueParts.join("=").trim();
			if (trimmedName) {
				cookies[trimmedName] = value;
			}
		}
	}

	return cookies;
}

// =============================================================================
// BASE64URL
// =============================================================================

/** RFC 4648 §5 base64url without padding, for bytes carried in URLs and cookies. */
export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/**
 * Inverse of `base64UrlEncode`. Returns `null` for anything outside the
 * unpadded base64url alphabet or that `atob` rejects; callers that need to
 * throw wrap it themselves.
 */
export function base64UrlDecode(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}
