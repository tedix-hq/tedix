import { type CallerIdentity } from "./caller-identity";

/**
 * Forward the stable identity minted by the trusted skill-runtime bridge.
 *
 * `Idempotency-Key` is the provider-facing contract. The X-Tedix provenance
 * headers are useful inside Tedix service bindings, but are deliberately not
 * sent to arbitrary third-party REST/MCP origins. Forwarding a key proves only
 * that deduplication was requested; it does not prove that an upstream honored
 * it.
 */
export function applyWorkflowExecutionHeaders(
	headers: Record<string, string>,
	caller: CallerIdentity | undefined,
	options: { includeTedixProvenance: boolean },
): void {
	const key = caller?.workflowIdempotencyKey;
	if (key) {
		headers["Idempotency-Key"] = key;
		headers["X-Idempotency-Key"] = key;
	}
	if (!options.includeTedixProvenance || !caller) return;
	if (caller.skillRunId) {
		headers["X-Tedix-Skill-Run-Id"] = caller.skillRunId;
	}
	if (caller.skillId) {
		headers["X-Tedix-Skill-Id"] = caller.skillId;
	}
	if (caller.workflowStepId) {
		headers["X-Tedix-Workflow-Step-Id"] = caller.workflowStepId;
	}
	if (caller.workflowStepName) {
		// Preserve arbitrary Unicode/space-bearing step names as an ASCII-safe
		// header across multiple service-binding hops. The receiving Tedix edge
		// decodes this exactly once for audit metadata.
		headers["X-Tedix-Workflow-Step-Name"] = encodeURIComponent(
			caller.workflowStepName,
		);
	}
	if (caller.workflowStepCount !== undefined) {
		headers["X-Tedix-Workflow-Step-Count"] = String(caller.workflowStepCount);
	}
	if (caller.workflowStepAttempt !== undefined) {
		headers["X-Tedix-Workflow-Step-Attempt"] = String(
			caller.workflowStepAttempt,
		);
	}
	if (caller.workflowExecutionEpoch !== undefined) {
		headers["X-Tedix-Workflow-Execution-Epoch"] = String(
			caller.workflowExecutionEpoch,
		);
	}
	if (caller.workflowCallId) {
		headers["X-Tedix-Workflow-Call-Id"] = caller.workflowCallId;
	}
}
