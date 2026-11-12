import type { SnapshotManifest } from "./snapshot-proof";

export interface CaptureMark {
	rowid: number;
	updatedAt: string | null;
}

export interface CaptureManifest {
	kind: "paced-workspace-capture";
	version: 1;
	startedAt: string;
	endedAt: string;
	main: string;
	logs: string[];
	/** All configured partitions must have completed their conversation walk. */
	logDatabaseIds: string[];
	completedLogDatabaseIds: string[];
	highWater: Record<string, Record<string, CaptureMark>>;
	proof: SnapshotManifest;
	requests: number;
	backoffs: number;
	delayMs: number;
	assignments: import("./tables").WorkspaceAssignments;
}
