function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Project duplicated persistence envelopes out of model-facing readiness polls.
 * The adapter and canonical persistence retain their full state. Never derive
 * readiness here: false, null, errors and recovery instructions pass unchanged.
 */
export function compactWorkstationStatusReceipt(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const { workstation, workstationLease, ...receipt } = value;
	const persistedWorkstation = record(workstation);
	const lease = record(workstationLease);
	if (persistedWorkstation) {
		receipt.workstation = pick(persistedWorkstation, [
			"id",
			"status",
			"profileId",
			"organizationId",
			"rootPath",
		]);
	}
	if (lease) {
		receipt.workstationLease = pick(lease, [
			"id",
			"workstationId",
			"profileId",
			"organizationId",
			"workItemId",
			"attemptId",
			"kernelRunId",
			"traceBundleId",
			"status",
			"expiresAt",
			"releasedAt",
			"capabilities",
			"adapters",
		]);
	}
	return receipt;
}

function pick(value: Record<string, unknown>, keys: string[]) {
	return Object.fromEntries(
		keys
			.filter((key) => value[key] !== undefined)
			.map((key) => [key, value[key]]),
	);
}
