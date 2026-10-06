/** Passive status and cleanup never reactivate a participant or grant command/file access. */
export function canAccessInactiveWorkstation(input: {
	path: string;
	leaseStatus: string;
	participantRole: string;
	participantStatus: string;
	preserveChanges: boolean;
}): boolean {
	if (input.leaseStatus === "released")
		return (
			input.path.endsWith("/workstation/process/status") ||
			(input.path.endsWith("/workstation/release") &&
				input.participantRole === "lead")
		);
	return (
		(input.path.endsWith("/workstation/status") ||
			(input.path.endsWith("/workstation/release") && input.preserveChanges)) &&
		input.participantRole === "lead" &&
		input.participantStatus === "left" &&
		["blocked", "failed", "expired", "canceled"].includes(input.leaseStatus)
	);
}
