const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 100;

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
		attempts?: number;
		baseDelayMs?: number;
		onRetry?: (error: unknown, attempt: number, label: string) => void;
	} = {},
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
	const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (isLogicalEvidenceConflict(error) || attempt >= attempts) throw error;
			options.onRetry?.(error, attempt, label);
			const delayMs = baseDelayMs * 2 ** (attempt - 1);
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}
	throw lastError;
}
