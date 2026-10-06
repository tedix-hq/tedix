/** The SDK restricts facet names to ASCII letters, digits, dots, and dashes.
 * Encode the complete JSON string so punctuation and lone surrogates retain
 * distinct durable identities instead of being replaced or truncated. Workerd
 * caps the complete facet name at 256 bytes, including the SDK's prefix. */
export async function durableCodemodeRuntimeName(
	name: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(name));
	const hex = (value: Uint8Array) =>
		Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const encoded = `tedix-${hex(bytes)}`;
	// Preserve existing valid facet identities. Only names that cannot have
	// created a facet under the provider limit use the full-input digest.
	if (`codemode:${encoded}`.length <= 256) return encoded;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return `tedix-sha256-${hex(digest)}`;
}
