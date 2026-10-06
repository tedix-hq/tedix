export const NATIVE_SNAPSHOT_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

export interface WorkstationSnapshotFence {
	leaseId: string;
	organizationId: string;
	tediId: string;
	workstationId: string;
	workItemId: string | null;
}

export interface WorkstationResumeSnapshot {
	createdAt: string;
	expiresAt: string;
	fence: WorkstationSnapshotFence;
	image: string;
	snapshot: ContainerSnapshot;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function snapshotFenceFromOutboundParams(
	value: unknown,
): WorkstationSnapshotFence | null {
	const params = record(value);
	if (!params) return null;
	const leaseId = params.leaseId;
	const organizationId = params.organizationId;
	const tediId = params.tediId;
	const workstationId = params.workstationId;
	const workItemId = params.workItemId;
	if (
		typeof leaseId !== "string" ||
		!leaseId ||
		typeof organizationId !== "string" ||
		!organizationId ||
		typeof tediId !== "string" ||
		!tediId ||
		typeof workstationId !== "string" ||
		!workstationId ||
		(workItemId !== undefined &&
			workItemId !== null &&
			typeof workItemId !== "string")
	)
		return null;
	return {
		leaseId,
		organizationId,
		tediId,
		workstationId,
		workItemId: typeof workItemId === "string" ? workItemId : null,
	};
}

export function snapshotMatches(
	record: WorkstationResumeSnapshot,
	input: {
		fence: WorkstationSnapshotFence;
		image: string;
		now?: number;
	},
): boolean {
	const expiresAt = Date.parse(record.expiresAt);
	return (
		Number.isFinite(expiresAt) &&
		expiresAt > (input.now ?? Date.now()) &&
		record.image === input.image &&
		record.fence.leaseId === input.fence.leaseId &&
		record.fence.organizationId === input.fence.organizationId &&
		record.fence.tediId === input.fence.tediId &&
		record.fence.workstationId === input.fence.workstationId &&
		record.fence.workItemId === input.fence.workItemId
	);
}

export function snapshotMismatchReason(
	record: WorkstationResumeSnapshot,
	input: {
		fence: WorkstationSnapshotFence | null;
		image: string;
		now?: number;
	},
): "expired" | "image_mismatch" | "fence_mismatch" | "missing_fence" | null {
	if (!input.fence) return "missing_fence";
	const expiresAt = Date.parse(record.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now()))
		return "expired";
	if (record.image !== input.image) return "image_mismatch";
	return snapshotMatches(record, { ...input, fence: input.fence })
		? null
		: "fence_mismatch";
}
