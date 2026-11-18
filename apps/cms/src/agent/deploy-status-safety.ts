import { PROBE_ERROR_KINDS, PROBE_TARGETS } from "./deploy-health";
import { DEPLOY_FAILURE_CODES } from "./deploy-failure";

const NUMERIC_DETAIL_KEYS = new Set([
	"copied",
	"blockVersion",
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
	"retryable",
]);

/** Keep deploy progress useful without persisting arbitrary build or provider text. */
export function safeDeployDetails(
	details: Record<string, unknown> | undefined,
): Record<string, number | boolean | string> | undefined {
	if (!details) return undefined;
	const safe: Record<string, number | boolean | string> = {};
	for (const [key, value] of Object.entries(details)) {
		if (
			NUMERIC_DETAIL_KEYS.has(key) &&
			typeof value === "number" &&
			Number.isFinite(value)
		) {
			safe[key] = value;
		} else if (BOOLEAN_DETAIL_KEYS.has(key) && typeof value === "boolean") {
			safe[key] = value;
		} else if (
			typeof value === "string" &&
			((key === "blockType" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) ||
				(key === "probeTarget" &&
					(PROBE_TARGETS as readonly string[]).includes(value)) ||
				(key === "probeError" &&
					(PROBE_ERROR_KINDS as readonly string[]).includes(value)) ||
				(key === "code" &&
					(DEPLOY_FAILURE_CODES as readonly string[]).includes(value)) ||
				(key === "phase" &&
					[
						"preflight",
						"build-theme",
						"snapshot-theme",
						"publish-bundle",
						"health-check",
						"cleanup-staging",
						"cleanup-build-workspace",
					].includes(value)) ||
				(key === "rollback" &&
					[
						"not_required",
						"not_available",
						"succeeded",
						"conflict",
						"failed",
					].includes(value)) ||
				(key === "correlationId" && /^cms-[a-zA-Z0-9-]{1,180}$/.test(value)))
		)
			safe[key] = value;
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
