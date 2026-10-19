export const CARD_SECRET_MESSAGE =
	"That looks like a secret. Remove it from your answer or comment and use connection settings instead.";

/** Detect credential formats, never return the matched value to the caller. */
export function containsCardSecret(value: unknown): boolean {
	if (typeof value === "string")
		return /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|fc-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_.~+/-]{20,}|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9_./+~-]{16,}/i.test(
			value,
		);
	if (Array.isArray(value)) return value.some(containsCardSecret);
	return Boolean(
		value &&
		typeof value === "object" &&
		Object.entries(value).some(
			([key, item]) =>
				containsCardSecret(item) ||
				(/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|token)$/i.test(
					key,
				) &&
					typeof item === "string" &&
					/^[A-Za-z0-9_./+~-]{16,}$/.test(item)),
		),
	);
}

export function credentialCard(
	text: string,
	metadata: Record<string, unknown> = {},
): boolean {
	return (
		Boolean(metadata.secureAction) ||
		/\b(?:replace|rotate|reconnect|renew|update|enter|paste|provide)\b[\s\S]{0,100}\b(?:api key|access token|credential|oauth|connection|firecrawl key)\b/i.test(
			text,
		)
	);
}
