/** Canonical legacy audit markers for a permanently retired Workflow run. */
export function isWorkflowRetirementError(
	error: string | null | undefined,
): boolean {
	return error === "REVOKED" || error?.startsWith("REVOKED:") === true;
}
