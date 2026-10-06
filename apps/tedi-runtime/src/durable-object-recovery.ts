const DURABLE_OBJECT_DEPLOYMENT_RESET_PATTERNS = [
	/durable object reset because its code was updated/i,
	/durable object (?:was )?reset.*code update/i,
	/disconnected because (?:the )?durable object was reset/i,
];

export function isDurableObjectDeploymentResetError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return DURABLE_OBJECT_DEPLOYMENT_RESET_PATTERNS.some((pattern) =>
		pattern.test(message),
	);
}

/**
 * Additional runtime-loss transients (beyond the deploy-reset patterns above)
 * that mean the DO hosting a turn vanished mid-flight rather than the turn
 * genuinely failing: an isolate OOM eviction and an internal Durable Object
 * storage reset. Kept separate from the deploy-reset set because the immediate
 * one-shot RPC recovery ({@link recoverDurableObjectDeploymentReset}) only makes
 * sense for the deploy-collision case; these broader transients are handled at
 * the workflow SETTLE path ({@link isTransientWorkflowRedriveError}).
 */
const RUNTIME_LOSS_TRANSIENT_PATTERNS = [
	/exceeded (?:its )?memory limit/i,
	/out of memory/i,
	/\bisolate\b.*\b(?:evicted|reset|exceeded)/i,
	/durable object.*(?:reset|internal error)/i,
	/storage.*(?:reset|reset because)/i,
];

/**
 * Whether a TERMINAL workflow error is a transient runtime loss that should
 * RE-DRIVE the workflow instead of sealing the run `failed` (fix (b)
 * DEPLOY-WINDOW DO RESETS). Covers the deploy-window `code was updated` reset —
 * the observed `objective-review` / `skill-development` failure when a cron
 * fired mid-deploy — plus isolate OOM and internal storage-reset losses. These
 * are NOT turn failures: the DO carrying the durable step was retired, so the
 * idempotent step re-drives cleanly on a fresh isolate (settled fast-path /
 * dedup-keyed writes make the re-drive exactly-once). A genuine turn error
 * (model/tool/timeout) does NOT match, so it still seals `lastSuccess:false`.
 */
export function isTransientWorkflowRedriveError(error: unknown): boolean {
	if (isDurableObjectDeploymentResetError(error)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return RUNTIME_LOSS_TRANSIENT_PATTERNS.some((pattern) =>
		pattern.test(message),
	);
}

/**
 * Reacquire and retry one idempotent Agent RPC immediately when Cloudflare
 * retires the target Durable Object during a code deployment. The surrounding
 * Workflow step still owns its delayed retry budget; this closes the common
 * one-reset gap without replaying arbitrary errors or side-effecting tools.
 */
export async function recoverDurableObjectDeploymentReset<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isDurableObjectDeploymentResetError(error)) throw error;
		return operation();
	}
}
