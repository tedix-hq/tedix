export const DEPLOY_FAILURE_CODES = [
	"DEPLOY_STEP_FAILED",
	"THEME_RELEASE_INVALID",
	"THEME_BLOCK_UNSUPPORTED",
	"THEME_CONTENT_UNAVAILABLE",
	"STATIC_MANIFEST_MISSING",
	"STATIC_ASSET_MISSING",
	"STATIC_ASSET_MISMATCH",
	"PROBE_HTTP_FAILED",
	"PROBE_NETWORK_FAILED",
	"PROBE_BUNDLE_MISMATCH",
	"PROBE_HTML_INVALID",
	"PROBE_ASSET_MISSING",
	"PROBE_ASSET_INVALID",
	"PROBE_IMAGE_INVALID",
	"ACTIVATION_CHANGED",
] as const;
export type DeployFailureCode = (typeof DEPLOY_FAILURE_CODES)[number];
export type DeployRollback =
	| "not_required"
	| "not_available"
	| "succeeded"
	| "conflict"
	| "failed";

export class CmsDeployFailure extends Error {
	constructor(
		public readonly code: DeployFailureCode,
		message: string,
		public readonly retryable = false,
		public readonly block?: { blockType: string; blockVersion: number },
	) {
		super(message);
	}
}
