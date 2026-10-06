/** Decode non-secret JWT claims for workspace naming and redacted status. */
export function decodeJwtPayload(
	token: string,
): Record<string, unknown> | null {
	const [, payload] = token.split(".");
	if (!payload) return null;
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return null;
	}
}
