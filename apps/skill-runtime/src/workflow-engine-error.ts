/**
 * One reading of a Cloudflare Workflow instance's terminal error.
 *
 * The engine exposes only `{ name, message }` for a failed instance, so the
 * thrown TYPE is the only signal that separates a deliberate refusal
 * (`NonRetryableError`, thrown by the runtime's permanent-error paths in
 * `runner.ts`/`skill-workflow.ts`) from a crash. Two writers project that
 * failure into `skill_runs.error` — the `/status` path in `index.ts` and the
 * cron reconciler — and they must persist the same text, or the class derived
 * downstream depends on which writer wrote last.
 *
 * The persisted text and the fingerprint input are two different values and
 * must not be conflated: the dispatcher fences a failed epoch with
 * `fingerprintWorkflowError(err.message)` before the engine reports it
 * (`skill-workflow.ts`), so the restart barrier only compares message against
 * message. `workflowEngineErrorMessage` is the fingerprint input;
 * `workflowEngineErrorText` is what gets persisted.
 */

export interface WorkflowEngineErrorSnapshot {
	name?: string;
	message?: string;
}

export type WorkflowEngineErrorValue =
	| WorkflowEngineErrorSnapshot
	| string
	| null
	| undefined;

/**
 * The raw engine-visible message, exactly as the dispatcher fingerprinted it.
 * Never name-prefixed: this value feeds `fingerprintWorkflowError` only.
 */
export function workflowEngineErrorMessage(
	error: WorkflowEngineErrorValue,
): string | null {
	if (!error) return null;
	if (typeof error === "string") return error;
	return error.message ?? JSON.stringify(error);
}

/**
 * The persisted failure text. Carries the thrown type name so the refusal
 * signal survives into D1 and the downstream classifier can read it.
 */
export function workflowEngineErrorText(
	error: WorkflowEngineErrorValue,
): string | null {
	const message = workflowEngineErrorMessage(error);
	if (message == null) return null;
	if (!error || typeof error === "string") return message;
	const name = error.name?.trim();
	if (!name) return message;
	return message.startsWith(`${name}:`) ? message : `${name}: ${message}`;
}
