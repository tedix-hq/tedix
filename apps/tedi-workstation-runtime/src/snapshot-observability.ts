export type SnapshotOperation = "create" | "restore" | "discard" | "fallback";
export type SnapshotOutcome = "success" | "failure" | "skipped";
export type SnapshotReason =
	| "none"
	| "expired"
	| "image_mismatch"
	| "fence_mismatch"
	| "provider_rejected"
	| "sync_failed"
	| "missing_fence"
	| "not_running";

export interface SnapshotMetric {
	operation: SnapshotOperation;
	outcome: SnapshotOutcome;
	reason: SnapshotReason;
	durationMs?: number;
	ageMs?: number;
	retainedReference: 0 | 1;
}

export function snapshotDataPoint(metric: SnapshotMetric) {
	return {
		blobs: [
			"workstation_snapshot",
			metric.operation,
			metric.outcome,
			metric.reason,
		],
		doubles: [
			metric.durationMs ?? 0,
			metric.ageMs ?? 0,
			metric.retainedReference,
		],
	};
}

export function emitSnapshotMetric(
	dataset: Pick<AnalyticsEngineDataset, "writeDataPoint"> | undefined,
	metric: SnapshotMetric,
): void {
	try {
		dataset?.writeDataPoint(snapshotDataPoint(metric));
	} catch {}
	console.info({
		component: "tedi.workstation.snapshot",
		event: `${metric.operation}.${metric.outcome}`,
		reason: metric.reason,
		durationMs: metric.durationMs ?? 0,
		ageMs: metric.ageMs ?? 0,
		retainedReference: metric.retainedReference,
	});
}
