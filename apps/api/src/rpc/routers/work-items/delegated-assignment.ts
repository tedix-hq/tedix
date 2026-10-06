export function isAssignedTediExecutor(input: {
	accountableOwnerType: string | null;
	accountableOwnerId: string | null;
	executorType: "tedi" | "external_agent";
	executorId: string;
}): boolean {
	return (
		input.executorType === "tedi" &&
		input.accountableOwnerType === "tedi" &&
		input.accountableOwnerId === input.executorId
	);
}

export function findAssignedActiveAttempt<
	T extends {
		executorType: string;
		executorId: string;
		runtimeState: string;
		expiresAt: string | null;
	},
>(attempts: T[], executorId: string, at: string): T | null {
	return (
		attempts.find(
			(attempt) =>
				attempt.executorType === "tedi" &&
				attempt.executorId === executorId &&
				["queued", "running", "waiting", "retrying"].includes(
					attempt.runtimeState,
				) &&
				attempt.expiresAt !== null &&
				attempt.expiresAt > at,
		) ?? null
	);
}
