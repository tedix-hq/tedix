import {
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	UnauthorizedError,
} from "@modelcontextprotocol/client";

export function isAuthRecoveryError(error: unknown): boolean {
	// beta.3 brands SDK errors across bundled copies. Prefer their structured
	// signals, while retaining the message fallback for third-party servers.
	if (UnauthorizedError.isInstance(error)) return true;
	if (SdkHttpError.isInstance(error)) {
		return error.status === 401;
	}
	if (SdkError.isInstance(error)) {
		return error.code === SdkErrorCode.ClientHttpAuthentication;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	const hasTokenSignal =
		normalized.includes("token") && normalized.includes("expired");
	return (
		hasTokenSignal ||
		normalized.includes("tenant_mismatch") ||
		normalized.includes("jwt has no tenant context") ||
		normalized.includes("different tenant") ||
		normalized.includes("insufficient scope") ||
		normalized.includes("missing scopes") ||
		(normalized.includes("required scopes") &&
			normalized.includes("missing")) ||
		normalized.includes("invalid token") ||
		normalized.includes("unauthorized") ||
		normalized.includes("unauthenticated") ||
		normalized.includes("authentication") ||
		normalized.includes("auth failed") ||
		normalized.includes(" 401") ||
		normalized.includes("status 401") ||
		normalized.includes(" 403 token") ||
		normalized.includes(" 403 auth")
	);
}

export function isTransportRecoveryError(error: unknown): boolean {
	if (SdkHttpError.isInstance(error)) {
		return error.status === 502 || error.status === 503 || error.status === 504;
	}
	if (SdkError.isInstance(error)) {
		return (
			error.code === SdkErrorCode.NotConnected ||
			error.code === SdkErrorCode.ConnectionClosed ||
			error.code === SdkErrorCode.SendFailed ||
			error.code === SdkErrorCode.RequestTimeout ||
			error.code === SdkErrorCode.EraNegotiationFailed
		);
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	return (
		normalized.includes("transport") ||
		normalized.includes("session") ||
		normalized.includes("connection") ||
		normalized.includes("network") ||
		normalized.includes("fetch failed") ||
		normalized.includes("socket") ||
		normalized.includes("terminated") ||
		normalized.includes("closed") ||
		normalized.includes("timeout") ||
		normalized.includes("timed out") ||
		normalized.includes("econnreset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("etimedout") ||
		normalized.includes("ehostunreach") ||
		normalized.includes("enotfound") ||
		normalized.includes("epipe") ||
		normalized.includes(" 502") ||
		normalized.includes("status 502") ||
		normalized.includes(" 503") ||
		normalized.includes("status 503") ||
		normalized.includes(" 504") ||
		normalized.includes("status 504")
	);
}

function collectResultText(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): string[] {
	if (depth > 6) return [];
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);

	if (Array.isArray(value)) {
		return value.flatMap((item) => collectResultText(item, depth + 1, seen));
	}

	const record = value as Record<string, unknown>;
	const directText =
		typeof record.text === "string"
			? [record.text]
			: typeof record.error === "string"
				? [record.error]
				: [];
	return directText.concat(
		Object.values(record).flatMap((item) =>
			collectResultText(item, depth + 1, seen),
		),
	);
}

export function authRecoveryMessageFromResult(result: unknown): string | null {
	for (const text of collectResultText(result)) {
		const normalized = text.toLowerCase();
		if (
			normalized.includes("insufficient scope") ||
			normalized.includes("missing scopes") ||
			(normalized.includes("required scopes") && normalized.includes("missing"))
		) {
			return text;
		}
	}
	return null;
}
