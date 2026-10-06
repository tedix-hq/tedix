/** Keep the fleet key in the parent Worker; tenant bundles receive only a derived key. */
export async function deriveTenantEmdashEncryptionKeys(
	masterKeys: string | undefined,
	siteId: string,
): Promise<string | undefined> {
	if (!masterKeys) return undefined;
	const encoder = new TextEncoder();
	const derived: string[] = [];
	for (const masterKey of masterKeys.split(",").map((key) => key.trim())) {
		if (!/^emdash_enc_v1_[A-Za-z0-9_-]{43}$/.test(masterKey)) {
			throw new Error("Invalid EMDASH_ENCRYPTION_KEY format");
		}
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(masterKey),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`tedix-emdash-settings:v1:${siteId}`),
		);
		const bytes = new Uint8Array(signature);
		derived.push(
			`emdash_enc_v1_${btoa(String.fromCharCode(...bytes))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replaceAll("=", "")}`,
		);
	}
	return derived.join(",");
}
