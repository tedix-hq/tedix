import type {
	Workstation,
	WorkstationLease,
	WorkstationParticipant,
	WorkstationSession,
} from "@tedix/api-contract/schemas/workstation";
import {
	getWorkstationLeaseBundle as getWorkstationLeaseRowBundle,
	joinWorkstationLease as joinWorkstationLeaseRows,
	releaseWorkstationLease as releaseWorkstationLeaseRows,
	upsertWorkstationLeaseBundle as upsertWorkstationLeaseRowBundle,
} from "@tedix/db/queries/workstations";
import { toJsonRecord } from "@tedix/db/utils/json";

export type {
	WorkstationJoinContext,
	WorkstationJoinSeat,
} from "@tedix/db/queries/workstations";

import type {
	WorkstationLeaseRow,
	WorkstationParticipantRow,
	WorkstationRow,
	WorkstationSessionRow,
} from "@tedix/db/schema/workstations";

export type WorkstationLeaseBundle = {
	workstation: Workstation;
	workstationLease: WorkstationLease;
};

export function workstationRowToContract(row: WorkstationRow): Workstation {
	return {
		id: row.id,
		profileId: row.profileId,
		organizationId: row.orgId,
		status: row.status,
		seats: row.seats,
		capabilities: row.capabilities,
		adapters: row.adapters,
		artifactRefs: row.artifactRefs,
		metadata: row.metadata,
	};
}

export function workstationParticipantRowToContract(
	row: WorkstationParticipantRow,
): WorkstationParticipant {
	const { orgId, ...participant } = row;
	return {
		...participant,
		organizationId: orgId,
		slug: row.slug ?? undefined,
	};
}

export function workstationSessionRowToContract(
	row: WorkstationSessionRow,
): WorkstationSession {
	const { orgId, ...session } = row;
	return { ...session, organizationId: orgId };
}

export function workstationLeaseRowToContract(
	row: WorkstationLeaseRow,
	participants: WorkstationParticipant[] = [],
	sessions: WorkstationSession[] = [],
): WorkstationLease {
	return {
		id: row.id,
		workstationId: row.workstationId,
		profileId: row.profileId,
		organizationId: row.orgId,
		workItemId: row.workItemId,
		attemptId: row.attemptId,
		repositoryPath: row.repositoryPath,
		repoStartSha: row.repoStartSha,
		preparedStartSha: row.preparedStartSha,
		kernelRunId: row.kernelRunId,
		traceBundleId: row.traceBundleId,
		status: row.status,
		capabilities: row.capabilities,
		adapters: row.adapters,
		participants,
		sessions,
		approvalIds: row.approvalIds,
		artifactRefs: row.artifactRefs,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		expiresAt: row.expiresAt,
		releasedAt: row.releasedAt,
		metadata: row.metadata,
	};
}

function rowBundleToContract(
	bundle: NonNullable<Awaited<ReturnType<typeof getWorkstationLeaseRowBundle>>>,
): WorkstationLeaseBundle {
	return {
		workstation: workstationRowToContract(bundle.workstation),
		workstationLease: workstationLeaseRowToContract(
			bundle.workstationLease,
			bundle.workstationLease.participants.map(
				workstationParticipantRowToContract,
			),
			bundle.workstationLease.sessions.map(workstationSessionRowToContract),
		),
	};
}

function contractBundleToRows(bundle: WorkstationLeaseBundle) {
	const { workstation, workstationLease } = bundle;
	const workstationRow: WorkstationRow = {
		id: workstation.id,
		profileId: workstation.profileId,
		orgId: workstation.organizationId,
		status: workstation.status,
		seats: workstation.seats,
		capabilities: workstation.capabilities,
		adapters: workstation.adapters,
		artifactRefs: workstation.artifactRefs,
		metadata: toJsonRecord(workstation.metadata),
		createdAt: workstationLease.createdAt,
		updatedAt: workstationLease.updatedAt,
	};
	const leaseRow: WorkstationLeaseRow = {
		id: workstationLease.id,
		workstationId: workstationLease.workstationId,
		profileId: workstationLease.profileId,
		orgId: workstationLease.organizationId,
		workItemId: workstationLease.workItemId,
		attemptId: workstationLease.attemptId ?? null,
		repositoryPath: workstationLease.repositoryPath ?? null,
		repoStartSha: workstationLease.repoStartSha ?? null,
		preparedStartSha: workstationLease.preparedStartSha ?? null,
		kernelRunId: workstationLease.kernelRunId,
		traceBundleId: workstationLease.traceBundleId,
		status: workstationLease.status,
		capabilities: workstationLease.capabilities,
		adapters: workstationLease.adapters,
		approvalIds: workstationLease.approvalIds,
		artifactRefs: workstationLease.artifactRefs,
		metadata: toJsonRecord(workstationLease.metadata),
		bodyGenerationId: null,
		bodyGenerationKind: null,
		bodyGenerationStatus: null,
		bodyGenerationTokenHash: null,
		bodyGenerationTokenExpiresAt: null,
		bodyGenerationExternalId: null,
		bodyGenerationHeartbeatAt: null,
		// Body generation and container identity are owned by their own guarded
		// writes; the lease upsert never carries them, so these nulls only satisfy
		// the row type and are never persisted over a recorded value.
		bodyInstanceId: null,
		bodyInstanceName: null,
		bodyInstanceObservedAt: null,
		createdAt: workstationLease.createdAt,
		updatedAt: workstationLease.updatedAt,
		expiresAt: workstationLease.expiresAt,
		releasedAt: workstationLease.releasedAt,
	};
	return {
		workstation: workstationRow,
		workstationLease: {
			...leaseRow,
			participants: workstationLease.participants.map(
				(participant): WorkstationParticipantRow => {
					const { organizationId, ...persisted } = participant;
					return {
						...persisted,
						orgId: organizationId,
						slug: participant.slug ?? null,
						metadata: toJsonRecord(participant.metadata),
					};
				},
			),
			sessions: workstationLease.sessions.map(
				(session): WorkstationSessionRow => {
					const { organizationId, ...persisted } = session;
					return {
						...persisted,
						orgId: organizationId,
						metadata: toJsonRecord(session.metadata),
					};
				},
			),
		},
	};
}

export async function getWorkstationLeaseBundle(
	...args: Parameters<typeof getWorkstationLeaseRowBundle>
) {
	const bundle = await getWorkstationLeaseRowBundle(...args);
	return bundle ? rowBundleToContract(bundle) : null;
}

export async function upsertWorkstationLeaseBundle(
	db: Parameters<typeof upsertWorkstationLeaseRowBundle>[0],
	bundle: WorkstationLeaseBundle,
) {
	return rowBundleToContract(
		await upsertWorkstationLeaseRowBundle(db, contractBundleToRows(bundle)),
	);
}

export async function joinWorkstationLease(
	...args: Parameters<typeof joinWorkstationLeaseRows>
) {
	const result = await joinWorkstationLeaseRows(...args);
	return result.ok
		? { ...result, bundle: rowBundleToContract(result.bundle) }
		: result;
}

export async function releaseWorkstationLease(
	...args: Parameters<typeof releaseWorkstationLeaseRows>
) {
	const result = await releaseWorkstationLeaseRows(...args);
	return result.ok
		? { ...result, bundle: rowBundleToContract(result.bundle) }
		: result;
}
