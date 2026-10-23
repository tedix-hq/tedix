/**
 * A held Home delegation has no `tedi_approval_requests` row: the parent run
 * is the approval. This id names it on events and cards; answer it with
 * `kernelRuntime.respondApproval` on that run.
 */
export function homeDelegationApprovalId(runId: string): string {
	return `home-delegation:${runId}`;
}

export function isHomeDelegationApprovalId(approvalId: string): boolean {
	return approvalId.startsWith("home-delegation:");
}
