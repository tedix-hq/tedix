import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import { tedis } from "../schema/tedis";
import { workstationLeases } from "../schema/workstations";

export type RuntimeBodyGenerationStatus =
	| "armed"
	| "starting"
	| "ready"
	| "failed"
	| "terminated"
	| "expired";
export type RuntimeBodyKind = "agent" | "workstation";
export type RuntimeBodyGenerationRecord =
	| { kind: "tedi"; id: string; tediId: string }
	| { kind: "workstationLease"; id: string; tediId: string };

export interface RuntimeBodyGenerationRow {
	bodyGenerationId: string | null;
	bodyGenerationKind: RuntimeBodyKind | null;
	bodyGenerationStatus: RuntimeBodyGenerationStatus | null;
	bodyGenerationTokenHash: string | null;
	bodyGenerationTokenExpiresAt: string | null;
	bodyGenerationExternalId: string | null;
	bodyGenerationHeartbeatAt: string | null;
}

export interface RuntimeBodyGenerationWrite {
	generationId: string;
	bodyKind: RuntimeBodyKind;
	status: RuntimeBodyGenerationStatus;
	tokenHash: string;
	tokenExpiresAt: string;
	externalId: string;
}

export async function readRuntimeBodyGeneration(
	db: DbQueryClient,
	record: RuntimeBodyGenerationRecord,
): Promise<RuntimeBodyGenerationRow | null> {
	const table = coreTable(
		db,
		record.kind === "workstationLease" ? workstationLeases : tedis,
	);
	const [row] = await db
		.select({
			bodyGenerationId: table.bodyGenerationId,
			bodyGenerationKind: table.bodyGenerationKind,
			bodyGenerationStatus: table.bodyGenerationStatus,
			bodyGenerationTokenHash: table.bodyGenerationTokenHash,
			bodyGenerationTokenExpiresAt: table.bodyGenerationTokenExpiresAt,
			bodyGenerationExternalId: table.bodyGenerationExternalId,
			bodyGenerationHeartbeatAt: table.bodyGenerationHeartbeatAt,
		})
		.from(table)
		.where(eq(table.id, record.id))
		.limit(1);
	return row ?? null;
}

export async function armRuntimeBodyGeneration(
	db: DbQueryClient,
	record: RuntimeBodyGenerationRecord,
	generation: RuntimeBodyGenerationWrite,
	now: string,
): Promise<boolean> {
	const table = coreTable(
		db,
		record.kind === "workstationLease" ? workstationLeases : tedis,
	);
	const rows = await db
		.update(table)
		.set({
			bodyGenerationId: generation.generationId,
			bodyGenerationKind: generation.bodyKind,
			bodyGenerationStatus: generation.status,
			bodyGenerationTokenHash: generation.tokenHash,
			bodyGenerationTokenExpiresAt: generation.tokenExpiresAt,
			bodyGenerationExternalId: generation.externalId,
			bodyGenerationHeartbeatAt: null,
			updatedAt:
				record.kind === "workstationLease" ? now : sql`CURRENT_TIMESTAMP`,
		})
		.where(eq(table.id, record.id))
		.returning({ id: table.id });
	return rows.length > 0;
}

export async function updateRuntimeBodyGenerationStatus(
	db: DbQueryClient,
	record: RuntimeBodyGenerationRecord,
	input: {
		generationId: string;
		status: RuntimeBodyGenerationStatus;
		externalId: string;
		at: string;
	},
): Promise<boolean> {
	const table = coreTable(
		db,
		record.kind === "workstationLease" ? workstationLeases : tedis,
	);
	const rows = await db
		.update(table)
		.set({
			bodyGenerationStatus: input.status,
			bodyGenerationExternalId: input.externalId,
			bodyGenerationHeartbeatAt: input.at,
			...(record.kind === "tedi" && input.status === "ready"
				? { lastSeenAt: input.at }
				: {}),
			updatedAt:
				record.kind === "workstationLease" ? input.at : sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(table.id, record.id),
				eq(table.bodyGenerationId, input.generationId),
			),
		)
		.returning({ id: table.id });
	return rows.length > 0;
}

export async function touchRuntimeBodyGenerationHeartbeat(
	db: DbQueryClient,
	record: RuntimeBodyGenerationRecord,
	input: { generationId: string; externalId: string; at: string },
): Promise<boolean> {
	const table = coreTable(
		db,
		record.kind === "workstationLease" ? workstationLeases : tedis,
	);
	const rows = await db
		.update(table)
		.set({
			bodyGenerationExternalId: input.externalId,
			bodyGenerationHeartbeatAt: input.at,
			...(record.kind === "tedi" ? { lastSeenAt: input.at } : {}),
			updatedAt:
				record.kind === "workstationLease" ? input.at : sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(table.id, record.id),
				eq(table.bodyGenerationId, input.generationId),
				inArray(table.bodyGenerationStatus, ["armed", "starting", "ready"]),
			),
		)
		.returning({ id: table.id });
	return rows.length > 0;
}

export async function terminateRuntimeBodyGeneration(
	db: DbQueryClient,
	record: RuntimeBodyGenerationRecord,
	input: { generationId: string; at: string },
): Promise<void> {
	const table = coreTable(
		db,
		record.kind === "workstationLease" ? workstationLeases : tedis,
	);
	await db
		.update(table)
		.set({
			bodyGenerationStatus: "terminated",
			bodyGenerationTokenHash: null,
			bodyGenerationTokenExpiresAt: null,
			bodyGenerationHeartbeatAt: input.at,
			updatedAt:
				record.kind === "workstationLease" ? input.at : sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(table.id, record.id),
				eq(table.bodyGenerationId, input.generationId),
			),
		);
}
