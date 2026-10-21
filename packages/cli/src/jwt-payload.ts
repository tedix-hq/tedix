/** Decode non-secret JWT claims for workspace naming and redacted status. */
export function decodeJwtPayload(
	token: string,
): Record<string, unknown> | null {
	const [, payload] = token.split(".");
	if (!payload) return null;
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const decoded: unknown = JSON.parse(
			Buffer.from(padded, "base64").toString("utf8"),
		);
		if (
			typeof decoded !== "object" ||
			decoded === null ||
			Array.isArray(decoded)
		)
			return null;
		return decoded as Record<string, unknown>;
	} catch {
		return null;
	}
}
