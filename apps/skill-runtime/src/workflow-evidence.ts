const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 2_147_483_647;

function isLogicalEvidenceConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.startsWith("WORKFLOW_RESTART_ABORTED:") ||
		message.startsWith("WORKFLOW_EPOCH_OUTCOME_CONFLICT:") ||
		message.startsWith("WORKFLOW_RUNTIME_DRIFT_BLOCKED:")
	);
}

/**
 * Retry critical idempotent D1 reads/writes made before a native WorkflowStep
 * exists. Once the tenant runner is available, native step.do retries remain
 * canonical for workflow work.
 */
export async function withWorkflowEvidenceRetry<T>(
	label: string,
	operation: () => Promise<T>,
	options: {
		/** Positive safe integer; defaults to 5 total calls, including the first. */
		attempts?: number;
		/** Integer in [0, 2_147_483_647]; defaults to 100. Backoff caps at that limit. */
		baseDelayMs?: number;
		onRetry?: (error: unknown, attempt: number, label: string) => void;
	} = {},
): Promise<T> {
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new RangeError("attempts must be a positive safe integer");
	}
	if (
		!Number.isSafeInteger(baseDelayMs) ||
		baseDelayMs < 0 ||
		baseDelayMs > MAX_DELAY_MS
	) {
		throw new RangeError(
			`baseDelayMs must be an integer between 0 and ${MAX_DELAY_MS}`,
		);
	}
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (isLogicalEvidenceConflict(error) || attempt >= attempts) throw error;
			options.onRetry?.(error, attempt, label);
			const delayMs =
				baseDelayMs === 0
					? 0
					: Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}
	throw lastError;
}
