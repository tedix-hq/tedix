import type { D1Executor } from "../client";

type D1PrepareExecutor = Pick<D1Executor, "prepare">;

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

function rowsChanged(result: unknown): boolean {
	const changes = (result as { meta?: { changes?: unknown } })?.meta?.changes;
	return typeof changes === "number" && changes > 0;
}

export async function readRuntimeBodyGeneration(
	db: D1PrepareExecutor,
	record: RuntimeBodyGenerationRecord,
): Promise<RuntimeBodyGenerationRow | null> {
	const table =
		record.kind === "workstationLease" ? "workstation_leases" : "tedis";
	return db
		.prepare(
			`SELECT
				body_generation_id AS bodyGenerationId,
				body_generation_kind AS bodyGenerationKind,
				body_generation_status AS bodyGenerationStatus,
				body_generation_token_hash AS bodyGenerationTokenHash,
				body_generation_token_expires_at AS bodyGenerationTokenExpiresAt,
				body_generation_external_id AS bodyGenerationExternalId,
				body_generation_heartbeat_at AS bodyGenerationHeartbeatAt
			 FROM ${table}
			 WHERE id = ?
			 LIMIT 1`,
		)
		.bind(record.id)
		.first<RuntimeBodyGenerationRow>();
}

export async function armRuntimeBodyGeneration(
	db: D1PrepareExecutor,
	record: RuntimeBodyGenerationRecord,
	generation: RuntimeBodyGenerationWrite,
	now: string,
): Promise<boolean> {
	const table =
		record.kind === "workstationLease" ? "workstation_leases" : "tedis";
	const updatedAt =
		record.kind === "workstationLease" ? "?" : "CURRENT_TIMESTAMP";
	const statement = db.prepare(
		`UPDATE ${table}
		 SET body_generation_id = ?,
			body_generation_kind = ?,
			body_generation_status = ?,
			body_generation_token_hash = ?,
			body_generation_token_expires_at = ?,
			body_generation_external_id = ?,
			body_generation_heartbeat_at = NULL,
			updated_at = ${updatedAt}
		 WHERE id = ?`,
	);
	const result =
		record.kind === "workstationLease"
			? await statement
					.bind(
						generation.generationId,
						generation.bodyKind,
						generation.status,
						generation.tokenHash,
						generation.tokenExpiresAt,
						generation.externalId,
						now,
						record.id,
					)
					.run()
			: await statement
					.bind(
						generation.generationId,
						generation.bodyKind,
						generation.status,
						generation.tokenHash,
						generation.tokenExpiresAt,
						generation.externalId,
						record.id,
					)
					.run();
	return rowsChanged(result);
}

export async function updateRuntimeBodyGenerationStatus(
	db: D1PrepareExecutor,
	record: RuntimeBodyGenerationRecord,
	input: {
		generationId: string;
		status: RuntimeBodyGenerationStatus;
		externalId: string;
		at: string;
	},
): Promise<boolean> {
	const isOnline = input.status === "ready";
	const result =
		record.kind === "workstationLease"
			? await db
					.prepare(
						`UPDATE workstation_leases
						 SET body_generation_status = ?, body_generation_external_id = ?,
							body_generation_heartbeat_at = ?, updated_at = ?
						 WHERE id = ? AND body_generation_id = ?`,
					)
					.bind(
						input.status,
						input.externalId,
						input.at,
						input.at,
						record.id,
						input.generationId,
					)
					.run()
			: await db
					.prepare(
						`UPDATE tedis
						 SET body_generation_status = ?, body_generation_external_id = ?,
							body_generation_heartbeat_at = ?,
							last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END,
							updated_at = CURRENT_TIMESTAMP
						 WHERE id = ? AND body_generation_id = ?`,
					)
					.bind(
						input.status,
						input.externalId,
						input.at,
						isOnline ? 1 : 0,
						input.at,
						record.id,
						input.generationId,
					)
					.run();
	return rowsChanged(result);
}

export async function touchRuntimeBodyGenerationHeartbeat(
	db: D1PrepareExecutor,
	record: RuntimeBodyGenerationRecord,
	input: { generationId: string; externalId: string; at: string },
): Promise<boolean> {
	const result =
		record.kind === "workstationLease"
			? await db
					.prepare(
						`UPDATE workstation_leases
						 SET body_generation_external_id = ?, body_generation_heartbeat_at = ?, updated_at = ?
						 WHERE id = ? AND body_generation_id = ?`,
					)
					.bind(
						input.externalId,
						input.at,
						input.at,
						record.id,
						input.generationId,
					)
					.run()
			: await db
					.prepare(
						`UPDATE tedis
						 SET body_generation_external_id = ?, body_generation_heartbeat_at = ?,
							last_seen_at = ?, updated_at = CURRENT_TIMESTAMP
						 WHERE id = ? AND body_generation_id = ?`,
					)
					.bind(
						input.externalId,
						input.at,
						input.at,
						record.id,
						input.generationId,
					)
					.run();
	return rowsChanged(result);
}

export async function terminateRuntimeBodyGeneration(
	db: D1PrepareExecutor,
	record: RuntimeBodyGenerationRecord,
	input: { generationId: string; at: string },
): Promise<void> {
	const table =
		record.kind === "workstationLease" ? "workstation_leases" : "tedis";
	const updatedAt =
		record.kind === "workstationLease" ? "?" : "CURRENT_TIMESTAMP";
	const statement = db.prepare(
		`UPDATE ${table}
		 SET body_generation_status = 'terminated',
			body_generation_token_hash = NULL,
			body_generation_token_expires_at = NULL,
			body_generation_heartbeat_at = ?,
			updated_at = ${updatedAt}
		 WHERE id = ? AND body_generation_id = ?`,
	);
	if (record.kind === "workstationLease") {
		await statement
			.bind(input.at, input.at, record.id, input.generationId)
			.run();
	} else {
		await statement.bind(input.at, record.id, input.generationId).run();
	}
}
