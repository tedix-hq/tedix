/** Only Google's official MCP service hosts select this provider adapter. */
export function isGoogleMcp(url: string): boolean {
	try {
		return /^[a-z][a-z0-9-]*mcp\.googleapis\.com$/.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

const REASONS: Record<string, string> = {
	UNAUTHENTICATED:
		"Google could not authenticate the connection. Reconnect the account.",
	PERMISSION_DENIED:
		"Google denied access. Check the account permissions and consent.",
	RESOURCE_EXHAUSTED:
		"Google is rate limiting requests or its quota is exhausted.",
	INVALID_ARGUMENT: "Google rejected the request parameters.",
	NOT_FOUND: "Google could not find the requested resource.",
	INTERNAL: "Google encountered an internal server error.",
	UNAVAILABLE: "Google is temporarily unavailable.",
	DEADLINE_EXCEEDED: "Google did not respond in time.",
};

/** Never echo provider messages, response bodies, URLs, or arbitrary codes. */
export function googleProviderFailure(value: unknown, readOnly: boolean) {
	const record =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	let detail = record;
	let providerStatus: number | undefined;
	let providerCode: string | undefined;
	for (let depth = 0; depth < 4; depth++) {
		for (const candidate of [detail.code, detail.statusCode, detail.status]) {
			if (
				typeof candidate === "number" &&
				Number.isInteger(candidate) &&
				candidate >= 400 &&
				candidate <= 599
			)
				providerStatus = candidate;
			if (typeof candidate === "string" && Object.hasOwn(REASONS, candidate))
				providerCode = candidate;
		}
		let nested = detail.error ?? detail.data;
		if (typeof nested === "string") {
			try {
				nested = JSON.parse(nested);
			} catch {
				break;
			}
		}
		if (!nested || typeof nested !== "object") break;
		detail = nested as Record<string, unknown>;
	}
	const transient =
		providerStatus === 429 ||
		(providerStatus !== undefined && providerStatus >= 500);
	const retrySafe = readOnly && transient;
	const reason = providerCode
		? REASONS[providerCode]
		: providerStatus === 401
			? REASONS.UNAUTHENTICATED
			: providerStatus === 403
				? REASONS.PERMISSION_DENIED
				: providerStatus === 429
					? REASONS.RESOURCE_EXHAUSTED
					: providerStatus !== undefined && providerStatus >= 500
						? REASONS.UNAVAILABLE
						: record.code === -32603
							? "Google's connector reported an internal error without a detailed reason."
							: "Google rejected the connector request without a detailed reason.";
	return {
		status: providerStatus ?? 502,
		providerStatus,
		providerCode,
		retrySafe,
		error: `${reason} Provider status: ${providerStatus ?? "unknown"}; code: ${providerCode ?? (typeof record.code === "number" && Number.isInteger(record.code) ? record.code : "unknown")}. ${retrySafe ? "Safe to retry this read after backoff." : readOnly ? "Automatic retry is unavailable without a transient provider status." : "Do not automatically retry: the write may have taken effect. Check its result first."}`,
	};
}
