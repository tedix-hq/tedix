/**
 * Request headers for the Cloudflare R2 REST API. A bucket created in a
 * jurisdiction (for example "eu") is only found when the request names that
 * jurisdiction; without it Cloudflare answers "bucket does not exist".
 */
export function r2RestHeaders(
	token: string,
	jurisdiction: string | undefined,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...extra,
		Authorization: `Bearer ${token}`,
		...(jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
	};
}
