const NUMERIC_DETAIL_KEYS = new Set([
	"copied",
	"fileCount",
	"rolledBackTo",
	"skipped",
	"sourceFileCount",
	"staticCount",
	"staticSize",
	"status",
	"totalSize",
	"version",
]);

const BOOLEAN_DETAIL_KEYS = new Set([
	"hit",
	"patched",
	"privacyBannerEnabled",
	"rollbackConflict",
]);

/** Keep deploy progress useful without persisting arbitrary build or provider text. */
export function safeDeployDetails(
	details: Record<string, unknown> | undefined,
): Record<string, number | boolean> | undefined {
	if (!details) return undefined;
	const safe: Record<string, number | boolean> = {};
	for (const [key, value] of Object.entries(details)) {
		if (
			NUMERIC_DETAIL_KEYS.has(key) &&
			typeof value === "number" &&
			Number.isFinite(value)
		) {
			safe[key] = value;
		} else if (BOOLEAN_DETAIL_KEYS.has(key) && typeof value === "boolean") {
			safe[key] = value;
		}
	}
	return Object.keys(safe).length > 0 ? safe : undefined;
}

export function safeDeployMessage(
	status: string,
	message: string | undefined,
): string | undefined {
	return status === "failed" || status === "errored"
		? "Deploy failed; inspect server logs"
		: message;
}
