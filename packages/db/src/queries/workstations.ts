/**
 * Query helpers for durable workstation leases.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { chunkForBoundParams } from "../utils/batch";
import {
	type WorkstationLeaseRow,
	type WorkstationParticipantRow,
	type WorkstationRow,
	type WorkstationSessionRow,
	workstationLeases,
	workstationParticipants,
	workstationSessions,
	workstations,
} from "../schema/workstations";

type WorkstationProfileId = WorkstationRow["profileId"];
type WorkstationSeatRole = WorkstationParticipantRow["role"];
type WorkstationSeat = WorkstationRow["seats"][number];

const COMMIT_SHA = /^[a-f0-9]{40}$/;

export async function bindWorkstationLeaseRepositoryAuthority(
	db: DbClient,
	input: {
		leaseId: string;
		orgId: string;
		workItemId: string;
		attemptId: string;
		generationId: string;
		repositoryPath: string;
		repoStartSha: string;
		preparedStartSha?: string;
	},
): Promise<WorkstationLeaseRow> {
	const now = new Date().toISOString();
	if (!COMMIT_SHA.test(input.repoStartSha))
		throw new Error("invalid repo start");
	if (input.preparedStartSha && !COMMIT_SHA.test(input.preparedStartSha))
		throw new Error("invalid prepared start");
	if (!/^[^/]+\/[^/]+$/.test(input.repositoryPath))
		throw new Error("invalid repository path");
	await db
		.update(workstationLeases)
		.set({
			attemptId: input.attemptId,
			repositoryPath: input.repositoryPath,
			repoStartSha: input.repoStartSha,
			...(input.preparedStartSha
				? { preparedStartSha: input.preparedStartSha }
				: {}),
		})
		.where(
			and(
				eq(workstationLeases.id, input.leaseId),
				eq(workstationLeases.orgId, input.orgId),
				eq(workstationLeases.workItemId, input.workItemId),
				eq(workstationLeases.attemptId, input.attemptId),
				eq(workstationLeases.bodyGenerationId, input.generationId),
				inArray(workstationLeases.status, [
					"provisioning",
					"active",
					"degraded",
				]),
				or(
					isNull(workstationLeases.expiresAt),
					sql`${workstationLeases.expiresAt} > ${now}`,
				),
				or(
					isNull(workstationLeases.repositoryPath),
					eq(workstationLeases.repositoryPath, input.repositoryPath),
				),
				or(
					isNull(workstationLeases.repoStartSha),
					eq(workstationLeases.repoStartSha, input.repoStartSha),
				),
				input.preparedStartSha
					? or(
							isNull(workstationLeases.preparedStartSha),
							eq(workstationLeases.preparedStartSha, input.preparedStartSha),
						)
					: undefined,
			),
		);
	const row = (
		await db
			.select()
			.from(workstationLeases)
			.where(eq(workstationLeases.id, input.leaseId))
			.limit(1)
	)[0];
	if (
		!row ||
		row.attemptId !== input.attemptId ||
		row.orgId !== input.orgId ||
		row.workItemId !== input.workItemId ||
		row.bodyGenerationId !== input.generationId ||
		(row.status !== "provisioning" &&
			row.status !== "active" &&
			row.status !== "degraded") ||
		(row.expiresAt !== null && row.expiresAt <= now) ||
		row.repositoryPath !== input.repositoryPath ||
		row.repoStartSha !== input.repoStartSha ||
		(input.preparedStartSha && row.preparedStartSha !== input.preparedStartSha)
	)
		throw new Error("workstation repository authority changed");
	return row;
}

export async function getWorkstationInspectionAuthority(
	db: DbClient,
	input: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		tediId: string;
		at?: string;
	},
): Promise<WorkstationLeaseRowBundle | null> {
	const rows = await db
		.select({ id: workstationLeases.id })
		.from(workstationLeases)
		.innerJoin(
			workstationParticipants,
			and(
				eq(workstationParticipants.leaseId, workstationLeases.id),
				eq(workstationParticipants.tediId, input.tediId),
				eq(workstationParticipants.orgId, input.orgId),
				eq(workstationParticipants.status, "active"),
			),
		)
		.where(
			and(
				eq(workstationLeases.orgId, input.orgId),
				eq(workstationLeases.workItemId, input.workItemId),
				eq(workstationLeases.attemptId, input.attemptId),
				inArray(workstationLeases.status, ["active", "degraded"]),
				or(
					isNull(workstationLeases.expiresAt),
					sql`${workstationLeases.expiresAt} > ${input.at ?? new Date().toISOString()}`,
				),
				isNotNull(workstationLeases.bodyGenerationId),
				isNotNull(workstationLeases.bodyInstanceName),
				isNotNull(workstationLeases.repositoryPath),
				isNotNull(workstationLeases.preparedStartSha),
			),
		)
		.limit(2);
	if (rows.length !== 1) return null;
	return getWorkstationLeaseBundle(db, rows[0]!.id);
}

export type WorkstationLeaseRowBundle = {
	workstation: WorkstationRow;
	workstationLease: WorkstationLeaseRow & {
		participants: WorkstationParticipantRow[];
		sessions: WorkstationSessionRow[];
	};
};

export async function getWorkstationLeaseBundle(
	db: DbClient,
	leaseId: string,
	options: { sessionLimit?: number } = {},
): Promise<WorkstationLeaseRowBundle | null> {
	const leaseRows = await db
		.select()
		.from(workstationLeases)
		.where(eq(workstationLeases.id, leaseId))
		.limit(1);
	const leaseRow = leaseRows[0];
	if (!leaseRow) return null;

	const workstationRows = await db
		.select()
		.from(workstations)
		.where(eq(workstations.id, leaseRow.workstationId))
		.limit(1);
	const workstationRow = workstationRows[0];
	if (!workstationRow) return null;

	const sessionLimit = Math.max(1, Math.min(options.sessionLimit ?? 25, 100));
	const [participantRows, newestSessionRows] = await Promise.all([
		db
			.select()
			.from(workstationParticipants)
			.where(eq(workstationParticipants.leaseId, leaseRow.id))
			.orderBy(
				asc(workstationParticipants.joinedAt),
				asc(workstationParticipants.id),
			),
		db
			.select()
			.from(workstationSessions)
			.where(eq(workstationSessions.leaseId, leaseRow.id))
			.orderBy(
				desc(workstationSessions.startedAt),
				desc(workstationSessions.id),
			)
			.limit(sessionLimit),
	]);

	const sessions = newestSessionRows.reverse();
	return {
		workstation: workstationRow,
		workstationLease: {
			...leaseRow,
			participants: participantRows,
			sessions,
		},
	};
}

export async function upsertWorkstationLeaseBundle(
	db: DbClient,
	bundle: WorkstationLeaseRowBundle,
): Promise<WorkstationLeaseRowBundle> {
	const { workstation, workstationLease } = bundle;
	const now = new Date().toISOString();
	if (
		workstation.id !== workstationLease.workstationId ||
		workstation.orgId !== workstationLease.orgId
	)
		throw new Error("workstation bundle parent authority mismatch");
	const ownerPredicate = and(
		workstationLease.orgId === null
			? isNull(workstationLeases.orgId)
			: eq(workstationLeases.orgId, workstationLease.orgId),
		workstationLease.workItemId === null
			? isNull(workstationLeases.workItemId)
			: eq(workstationLeases.workItemId, workstationLease.workItemId),
		workstationLease.attemptId === null
			? isNull(workstationLeases.attemptId)
			: eq(workstationLeases.attemptId, workstationLease.attemptId),
	);
	const existingLease = (
		await db
			.select({
				orgId: workstationLeases.orgId,
				workItemId: workstationLeases.workItemId,
				attemptId: workstationLeases.attemptId,
				workstationId: workstationLeases.workstationId,
			})
			.from(workstationLeases)
			.where(eq(workstationLeases.id, workstationLease.id))
			.limit(1)
	)[0];
	if (
		existingLease &&
		(existingLease.orgId !== workstationLease.orgId ||
			existingLease.workItemId !== workstationLease.workItemId ||
			existingLease.attemptId !== workstationLease.attemptId ||
			existingLease.workstationId !== workstationLease.workstationId)
	)
		throw new Error("workstation lease owner authority changed");
	const existingWorkstation = (
		await db
			.select({ orgId: workstations.orgId })
			.from(workstations)
			.where(eq(workstations.id, workstation.id))
			.limit(1)
	)[0];
	if (existingWorkstation && existingWorkstation.orgId !== workstation.orgId)
		throw new Error("workstation parent authority changed");

	const workstationClaim = db
		.insert(workstations)
		.values({
			id: workstation.id,
			profileId: workstation.profileId,
			orgId: workstation.orgId,
			status: workstation.status,
			seats: workstation.seats,
			capabilities: workstation.capabilities,
			adapters: workstation.adapters,
			artifactRefs: workstation.artifactRefs,
			metadata: workstation.metadata,
			createdAt: workstation.createdAt,
			updatedAt: workstation.updatedAt ?? now,
		})
		.onConflictDoNothing();
	const leaseClaim = db
		.insert(workstationLeases)
		.values({
			id: workstationLease.id,
			workstationId: workstationLease.workstationId,
			profileId: workstationLease.profileId,
			orgId: workstationLease.orgId,
			workItemId: workstationLease.workItemId,
			attemptId: workstationLease.attemptId,
			repositoryPath: workstationLease.repositoryPath,
			repoStartSha: workstationLease.repoStartSha,
			preparedStartSha: workstationLease.preparedStartSha,
			kernelRunId: workstationLease.kernelRunId,
			traceBundleId: workstationLease.traceBundleId,
			status: workstationLease.status,
			capabilities: workstationLease.capabilities,
			adapters: workstationLease.adapters,
			approvalIds: workstationLease.approvalIds,
			artifactRefs: workstationLease.artifactRefs,
			metadata: workstationLease.metadata,
			createdAt: workstationLease.createdAt,
			updatedAt: workstationLease.updatedAt,
			expiresAt: workstationLease.expiresAt,
			releasedAt: workstationLease.releasedAt,
		})
		.onConflictDoUpdate({
			target: workstationLeases.id,
			setWhere: ownerPredicate,
			set: {
				profileId: workstationLease.profileId,
				orgId: workstationLease.orgId,
				workItemId: workstationLease.workItemId,
				kernelRunId: workstationLease.kernelRunId,
				traceBundleId: workstationLease.traceBundleId,
				status: workstationLease.status,
				capabilities: workstationLease.capabilities,
				adapters: workstationLease.adapters,
				approvalIds: workstationLease.approvalIds,
				artifactRefs: workstationLease.artifactRefs,
				metadata: workstationLease.metadata,
				updatedAt: workstationLease.updatedAt,
				expiresAt: workstationLease.expiresAt,
				releasedAt: workstationLease.releasedAt,
			},
		});
	// D1 batch is the transaction primitive. The parent workstation must exist
	// in the same atomic unit as the FK-bearing lease claim.
	await db.batch([workstationClaim, leaseClaim]);
	const persistedOwner = (
		await db
			.select({
				orgId: workstationLeases.orgId,
				workItemId: workstationLeases.workItemId,
				attemptId: workstationLeases.attemptId,
				workstationId: workstationLeases.workstationId,
			})
			.from(workstationLeases)
			.where(eq(workstationLeases.id, workstationLease.id))
			.limit(1)
	)[0];
	if (
		!persistedOwner ||
		persistedOwner.orgId !== workstationLease.orgId ||
		persistedOwner.workItemId !== workstationLease.workItemId ||
		persistedOwner.attemptId !== workstationLease.attemptId ||
		persistedOwner.workstationId !== workstationLease.workstationId
	)
		throw new Error("workstation lease owner authority changed");
	const persistedParent = (
		await db
			.select({ orgId: workstations.orgId })
			.from(workstations)
			.where(eq(workstations.id, workstation.id))
			.limit(1)
	)[0];
	if (!persistedParent || persistedParent.orgId !== workstation.orgId)
		throw new Error("workstation parent authority changed");

	// The lease row is the ownership fence for the whole bundle. Do not mutate
	// the shared workstation or child rows until that fence has accepted this
	// exact immutable org/work/attempt tuple.
	await db
		.update(workstations)
		.set({
			profileId: workstation.profileId,
			status: workstation.status,
			seats: workstation.seats,
			capabilities: workstation.capabilities,
			adapters: workstation.adapters,
			artifactRefs: workstation.artifactRefs,
			metadata: workstation.metadata,
			updatedAt: workstation.updatedAt ?? now,
		})
		.where(
			and(
				eq(workstations.id, workstation.id),
				workstation.orgId === null
					? isNull(workstations.orgId)
					: eq(workstations.orgId, workstation.orgId),
			),
		);

	for (const participant of workstationLease.participants) {
		await db
			.insert(workstationParticipants)
			.values({
				id: participant.id,
				leaseId: participant.leaseId,
				orgId: participant.orgId,
				tediId: participant.tediId,
				slug: participant.slug ?? null,
				role: participant.role,
				status: participant.status,
				permissionScopes: participant.permissionScopes,
				joinedAt: participant.joinedAt,
				leftAt: participant.leftAt,
				metadata: participant.metadata,
			})
			.onConflictDoUpdate({
				target: workstationParticipants.id,
				set: {
					leaseId: participant.leaseId,
					orgId: participant.orgId,
					tediId: participant.tediId,
					slug: participant.slug ?? null,
					role: participant.role,
					status: participant.status,
					permissionScopes: participant.permissionScopes,
					leftAt: participant.leftAt,
					metadata: participant.metadata,
				},
			});
	}

	for (const session of workstationLease.sessions) {
		await db
			.insert(workstationSessions)
			.values({
				id: session.id,
				leaseId: session.leaseId,
				orgId: session.orgId,
				participantId: session.participantId,
				kind: session.kind,
				adapter: session.adapter,
				status: session.status,
				sessionKey: session.sessionKey,
				externalId: session.externalId,
				artifactRefs: session.artifactRefs,
				startedAt: session.startedAt,
				endedAt: session.endedAt,
				metadata: session.metadata,
			})
			.onConflictDoUpdate({
				target: workstationSessions.id,
				set: {
					leaseId: session.leaseId,
					orgId: session.orgId,
					participantId: session.participantId,
					kind: session.kind,
					adapter: session.adapter,
					status: session.status,
					sessionKey: session.sessionKey,
					externalId: session.externalId,
					artifactRefs: session.artifactRefs,
					endedAt: session.endedAt,
					metadata: session.metadata,
				},
			});
	}

	// Return the operation-scoped bundle the caller supplied. Re-reading the
	// complete lease after every command made latency and response size grow with
	// the lifetime session count. Historical sessions remain queryable through
	// getWorkstationLeaseBundle's bounded window.
	return bundle;
}

/**
 * A participant seat to add to a workstation lease (join contract input).
 */
export type WorkstationJoinSeat = {
	tediId: string;
	role?: WorkstationSeatRole;
	slug?: string;
	permissionScopes?: string[];
};

export type WorkstationJoinContext = {
	joinedBySlug?: string | null;
	joinedByTediId?: string | null;
	kernelRunId?: string | null;
	traceBundleId?: string | null;
	traceId?: string | null;
	workItemId?: string | null;
};

function participantSlugPart(value: string | null | undefined): string {
	return (
		(value || "global")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "global"
	);
}

/**
 * Build a stable participant id for a seat on a lease. Matches the id scheme
 * `createWorkstationLease` uses (`{leaseId}_participant_{slug-or-tedi}`) so the
 * same tedi resolves to the same row whether it was seated at request time or
 * appended later via `join_workstation`.
 */
function participantIdForSeat(
	leaseId: string,
	seat: WorkstationJoinSeat,
): string {
	return `${leaseId}_participant_${participantSlugPart(seat.slug ?? seat.tediId)}`;
}

/**
 * Append participant seats to an existing lease bundle in memory (idempotent on
 * tediId — an existing participant for the same tedi is left untouched, not
 * duplicated). Pure: callers persist the returned bundle via
 * `upsertWorkstationLeaseBundle`. Returns the merged bundle plus the list of
 * tediIds that were newly added (empty when every seat was already present).
 */
export function appendParticipantsToLeaseBundle(
	bundle: WorkstationLeaseRowBundle,
	seats: WorkstationJoinSeat[],
	options: { joinContext?: WorkstationJoinContext; now?: string } = {},
): { bundle: WorkstationLeaseRowBundle; added: string[] } {
	const now = options.now ?? new Date().toISOString();
	const lease = bundle.workstationLease;
	const existingByTedi = new Map(
		lease.participants.map((participant) => [participant.tediId, participant]),
	);
	const participants = [...lease.participants];
	const added: string[] = [];
	let nextIndex = participants.length;

	for (const seat of seats) {
		if (!seat.tediId || existingByTedi.has(seat.tediId)) continue;
		const participant: WorkstationParticipantRow = {
			id: participantIdForSeat(lease.id, seat),
			leaseId: lease.id,
			orgId: lease.orgId,
			tediId: seat.tediId,
			slug: seat.slug ?? null,
			role: seat.role ?? "collaborator",
			status: "active",
			permissionScopes: seat.permissionScopes ?? [],
			joinedAt: now,
			leftAt: null,
			metadata: {
				seatIndex: nextIndex,
				...joinContextMetadata(options.joinContext),
			},
		};
		participants.push(participant);
		existingByTedi.set(seat.tediId, participant);
		added.push(seat.tediId);
		nextIndex += 1;
	}

	if (added.length === 0) {
		return { bundle, added };
	}

	return {
		bundle: {
			workstation: {
				...bundle.workstation,
				seats: participantsToSeats(participants),
			},
			workstationLease: {
				...lease,
				participants,
				metadata: joinLeaseMetadata(lease.metadata, seats, added, now, options),
				updatedAt: now,
			},
		},
		added,
	};
}

function participantsToSeats(
	participants: WorkstationParticipantRow[],
): WorkstationSeat[] {
	return participants.map((participant) => ({
		permissionScopes: participant.permissionScopes,
		role: participant.role,
		slug: participant.slug ?? undefined,
		tediId: participant.tediId,
	}));
}

function joinContextMetadata(
	context: WorkstationJoinContext | undefined,
): Record<string, JsonValue> {
	return {
		...(context?.joinedByTediId
			? { joinedByTediId: context.joinedByTediId }
			: {}),
		...(context?.joinedBySlug ? { joinedBySlug: context.joinedBySlug } : {}),
		...(context?.kernelRunId ? { kernelRunId: context.kernelRunId } : {}),
		...(context?.traceBundleId ? { traceBundleId: context.traceBundleId } : {}),
		...(context?.traceId ? { traceId: context.traceId } : {}),
		...(context?.workItemId ? { workItemId: context.workItemId } : {}),
	};
}

function joinLeaseMetadata(
	metadata: Record<string, JsonValue>,
	seats: WorkstationJoinSeat[],
	added: string[],
	joinedAt: string,
	options: { joinContext?: WorkstationJoinContext },
): Record<string, JsonValue> {
	const event = {
		...joinContextMetadata(options.joinContext),
		addedTediIds: added,
		joinedAt,
		requestedTediIds: seats
			.map((seat) => seat.tediId)
			.filter((tediId): tediId is string => Boolean(tediId)),
	};
	const previousEvents = Array.isArray(metadata.participantJoinEvents)
		? metadata.participantJoinEvents.filter(
				(value): value is Record<string, JsonValue> =>
					Boolean(value) && typeof value === "object" && !Array.isArray(value),
			)
		: [];
	return {
		...metadata,
		collaborationMode: "collaborative",
		lastParticipantJoin: event,
		participantJoinEvents: [...previousEvents, event].slice(-25),
	};
}

/**
 * Result of a `join_workstation` lease mutation. `lease not found` is returned
 * as structured evidence rather than a throw so the tool surface can report it.
 */
export type JoinWorkstationLeaseResult =
	| {
			ok: true;
			added: string[];
			bundle: WorkstationLeaseRowBundle;
	  }
	| {
			ok: false;
			reason: "lease_not_found";
			leaseId: string;
	  }
	| {
			ok: false;
			leadTediId: string | null;
			leaseId: string;
			reason: "not_lease_lead";
	  }
	| {
			ok: false;
			actualOrganizationId: string | null;
			expectedOrganizationId: string | null;
			leaseId: string;
			reason: "organization_mismatch";
	  }
	| {
			ok: false;
			actualProfileId: WorkstationProfileId;
			expectedProfileId: WorkstationProfileId;
			leaseId: string;
			reason: "profile_mismatch";
	  };

/**
 * Append one or more participant seats to an EXISTING persisted lease.
 * Idempotent on tediId. Returns structured `lease_not_found` evidence when the
 * lease (or its workstation row) is not persisted — never throws for a missing
 * lease.
 */
export async function joinWorkstationLease(
	db: DbClient,
	leaseId: string,
	seats: WorkstationJoinSeat[],
	options: {
		expectedOrganizationId?: string | null;
		expectedProfileId?: WorkstationProfileId;
		joinContext?: WorkstationJoinContext;
		now?: string;
	} = {},
): Promise<JoinWorkstationLeaseResult> {
	const existing = await getWorkstationLeaseBundle(db, leaseId);
	if (!existing) {
		return { ok: false, reason: "lease_not_found", leaseId };
	}
	const leadTediId =
		existing.workstationLease.participants.find(
			(participant) => participant.role === "lead",
		)?.tediId ?? null;
	if (
		!options.joinContext?.joinedByTediId ||
		options.joinContext.joinedByTediId !== leadTediId
	) {
		return {
			ok: false,
			leadTediId,
			leaseId,
			reason: "not_lease_lead",
		};
	}
	if (
		options.expectedOrganizationId !== undefined &&
		existing.workstationLease.orgId !== options.expectedOrganizationId
	) {
		return {
			ok: false,
			actualOrganizationId: existing.workstationLease.orgId,
			expectedOrganizationId: options.expectedOrganizationId,
			leaseId,
			reason: "organization_mismatch",
		};
	}
	if (
		options.expectedProfileId &&
		existing.workstationLease.profileId !== options.expectedProfileId
	) {
		return {
			ok: false,
			actualProfileId: existing.workstationLease.profileId,
			expectedProfileId: options.expectedProfileId,
			leaseId,
			reason: "profile_mismatch",
		};
	}
	const { bundle: merged, added } = appendParticipantsToLeaseBundle(
		existing,
		seats,
		{ joinContext: options.joinContext, now: options.now },
	);
	if (added.length === 0) {
		// Every seat already present — nothing to persist; return the snapshot.
		return { ok: true, added, bundle: existing };
	}
	const persisted = await upsertWorkstationLeaseBundle(db, merged);
	return { ok: true, added, bundle: persisted };
}

export type WorkstationReleaseContext = {
	reason?: string | null;
	releasedBySlug?: string | null;
	releasedByTediId?: string | null;
	traceId?: string | null;
};

export type ReleaseWorkstationLeaseResult =
	| {
			alreadyReleased: boolean;
			bundle: WorkstationLeaseRowBundle;
			ok: true;
	  }
	| {
			leaseId: string;
			ok: false;
			reason: "lease_not_found";
	  }
	| {
			expectedOrganizationId: string | null;
			leaseId: string;
			ok: false;
			reason: "organization_mismatch";
	  }
	| {
			leadTediId: string | null;
			leaseId: string;
			ok: false;
			reason: "not_lease_lead";
	  };

export function releaseWorkstationLeaseBundle(
	bundle: WorkstationLeaseRowBundle,
	releaseContext: WorkstationReleaseContext,
	now: string,
): WorkstationLeaseRowBundle {
	const lastRelease = { ...releaseContext, releasedAt: now };
	return {
		workstation: {
			...bundle.workstation,
			metadata: { ...bundle.workstation.metadata, lastRelease },
			status: "archived",
		},
		workstationLease: {
			...bundle.workstationLease,
			metadata: { ...bundle.workstationLease.metadata, lastRelease },
			participants: bundle.workstationLease.participants.map((participant) => ({
				...participant,
				leftAt: now,
				status: "left",
			})),
			releasedAt: now,
			sessions: bundle.workstationLease.sessions.map((session) => ({
				...session,
				endedAt: now,
				status: "archived",
			})),
			status: "released",
			updatedAt: now,
		},
	};
}

/**
 * Release one task-scoped workstation lease and close every participant and
 * session attached to it. Only the lead tedi may release the lease. Repeated
 * calls are idempotent once the caller has already been authorized.
 */
export async function releaseWorkstationLease(
	db: DbClient,
	leaseId: string,
	options: {
		expectedOrganizationId?: string | null;
		now?: string;
		releaseContext: WorkstationReleaseContext;
	},
): Promise<ReleaseWorkstationLeaseResult> {
	const existing = await getWorkstationLeaseBundle(db, leaseId);
	if (!existing) {
		return { leaseId, ok: false, reason: "lease_not_found" };
	}
	if (
		options.expectedOrganizationId !== undefined &&
		existing.workstationLease.orgId !== options.expectedOrganizationId
	) {
		return {
			expectedOrganizationId: options.expectedOrganizationId,
			leaseId,
			ok: false,
			reason: "organization_mismatch",
		};
	}
	const leadTediId =
		existing.workstationLease.participants.find(
			(participant) => participant.role === "lead",
		)?.tediId ?? null;
	if (
		!options.releaseContext.releasedByTediId ||
		options.releaseContext.releasedByTediId !== leadTediId
	) {
		return {
			leadTediId,
			leaseId,
			ok: false,
			reason: "not_lease_lead",
		};
	}
	if (existing.workstationLease.status === "released") {
		return { alreadyReleased: true, bundle: existing, ok: true };
	}

	const now = options.now ?? new Date().toISOString();
	const releasedBundle = releaseWorkstationLeaseBundle(
		existing,
		options.releaseContext,
		now,
	);
	await db
		.update(workstationLeases)
		.set({
			metadata: releasedBundle.workstationLease.metadata,
			releasedAt: now,
			status: "released",
			updatedAt: now,
		})
		.where(eq(workstationLeases.id, leaseId));
	await db
		.update(workstations)
		.set({
			metadata: releasedBundle.workstation.metadata,
			status: "archived",
			updatedAt: now,
		})
		.where(eq(workstations.id, existing.workstation.id));
	await db
		.update(workstationParticipants)
		.set({ leftAt: now, status: "left" })
		.where(eq(workstationParticipants.leaseId, leaseId));
	await db
		.update(workstationSessions)
		.set({ endedAt: now, status: "archived" })
		.where(eq(workstationSessions.leaseId, leaseId));

	const released = await getWorkstationLeaseBundle(db, leaseId);
	if (!released) {
		throw new Error(`released workstation lease disappeared: ${leaseId}`);
	}
	return { alreadyReleased: false, bundle: released, ok: true };
}

/**
 * Lease statuses that mean the workstation environment is provisioned / warm /
 * available (NOT terminal). A tedi seated on such a lease is durably
 * workstation-capable for routing purposes. Terminal/blocked statuses
 * (`released`, `expired`, `blocked`) are excluded — those leases no longer
 * confer capability.
 */
const WARM_WORKSTATION_LEASE_STATUSES = [
	"requested",
	"provisioning",
	"active",
	"degraded",
	"releasing",
] as const;

/** Whether one lease is still in a state that should keep its Sandbox warm. */
export async function hasActiveWorkstationLease(
	db: DbClient,
	leaseId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: workstationLeases.id })
		.from(workstationLeases)
		.where(
			and(
				eq(workstationLeases.id, leaseId),
				inArray(workstationLeases.status, [...WARM_WORKSTATION_LEASE_STATUSES]),
			),
		)
		.limit(1);
	return row !== undefined;
}

export async function updateWorkstationLeaseBodyGeneration(
	db: DbClient,
	input: {
		leaseId: string;
		generationId: string;
		status: "starting" | "ready" | "failed";
		tokenHash: string;
		tokenExpiresAt: string;
		externalId: string;
		heartbeatAt: string;
		updatedAt: string;
	},
): Promise<void> {
	await db
		.update(workstationLeases)
		.set({
			bodyGenerationId: input.generationId,
			bodyGenerationKind: "workstation",
			bodyGenerationStatus: input.status,
			bodyGenerationTokenHash: input.tokenHash,
			bodyGenerationTokenExpiresAt: input.tokenExpiresAt,
			bodyGenerationExternalId: input.externalId,
			bodyGenerationHeartbeatAt: input.heartbeatAt,
			updatedAt: input.updatedAt,
		})
		.where(eq(workstationLeases.id, input.leaseId));
}

/**
 * Participant statuses that mean the tedi is actively seated (NOT departed).
 */
const ACTIVE_WORKSTATION_PARTICIPANT_STATUSES = ["invited", "active", "paused"];

/**
 * Bounded org-scoped read: the set of tedi ids that currently hold a warm /
 * available workstation lease seat. This is the DURABLE workstation-capability
 * signal the kernel routing path consults to treat an isolate tedi as embodied
 * (decisions/workstations-over-bodies.md "Harness Contract": only OS/process
 * work attaches a workstation; the lease row is the durable stamp).
 *
 * Cost: two indexed read shapes, no per-tedi fan-out —
 *   1. active leases for the org (`idx_workstation_leases_org` + status filter),
 *   2. active participants for those leases (`idx_workstation_participants_*`),
 *      issued in ≤50-id chunks so the IN() list stays under D1's 100
 *      bound-parameter cap when an org holds many warm leases.
 * Fail-soft is the CALLER's responsibility (the kernel
 * wraps this in `safeRead`/`safeBatch`); a throw here propagates so the caller
 * degrades to an empty set rather than a wrong-positive capability.
 */
export async function getWorkstationCapableTediIds(
	db: DbClient,
	organizationId: string,
): Promise<Set<string>> {
	const leaseRows = await db
		.select({ id: workstationLeases.id })
		.from(workstationLeases)
		.where(
			and(
				eq(workstationLeases.orgId, organizationId),
				inArray(workstationLeases.status, [...WARM_WORKSTATION_LEASE_STATUSES]),
			),
		);
	const leaseIds = leaseRows.map((row) => row.id);
	if (leaseIds.length === 0) return new Set<string>();

	const capable = new Set<string>();
	for (const chunk of chunkForBoundParams(leaseIds, 50)) {
		const participantRows = await db
			.select({
				tediId: workstationParticipants.tediId,
				status: workstationParticipants.status,
			})
			.from(workstationParticipants)
			.where(inArray(workstationParticipants.leaseId, chunk));
		for (const row of participantRows) {
			if (
				row.tediId &&
				ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.includes(row.status)
			) {
				capable.add(row.tediId);
			}
		}
	}
	return capable;
}

/**
 * Live coding readiness for a workstation-seated tedi, projected from the lease
 * row. `depsReady`/`environmentReady`/`installStatus` are written onto the lease
 * `metadata` (and reflected in the lease `status`: environmentReady→"active",
 * deps-not-ready→"degraded") by the workstation edge each time it serves
 * `/wake`/`/status` (apps/tedi workstation `upsertWorkstationLeaseBundle`).
 */
export interface WorkstationReadiness {
	leaseStatus: string;
	environmentReady: boolean;
	depsReady: boolean;
	installStatus: string | null;
}

/**
 * Read coding-readiness flags off a lease `metadata` JSON blob, defensively.
 * Reads the flat fields first, falling back to a nested `bootstrapReadiness`
 * object. Absent/malformed ⇒ not ready (fail-safe).
 */
function extractLeaseReadiness(
	metadata: unknown,
): Omit<WorkstationReadiness, "leaseStatus"> {
	const m =
		metadata && typeof metadata === "object"
			? (metadata as Record<string, unknown>)
			: {};
	const nested =
		m.bootstrapReadiness && typeof m.bootstrapReadiness === "object"
			? (m.bootstrapReadiness as Record<string, unknown>)
			: {};
	const depsReady = m.depsReady === true || nested.depsReady === true;
	const environmentReady =
		m.environmentReady === true || nested.environmentReady === true;
	const installRaw = m.installStatus ?? nested.installStatus;
	const installStatus = typeof installRaw === "string" ? installRaw : null;
	return { depsReady, environmentReady, installStatus };
}

/**
 * Bounded org-scoped read of per-tedi CODING readiness — the same TWO indexed
 * reads as {@link getWorkstationCapableTediIds} (leases + participants), but it
 * also projects the lease `status` + `metadata` so the kernel can tell a warm
 * lease whose deps are READY from one still bootstrapping ("degraded",
 * `depsReady:false`). Without this, a deps-not-ready lease still counts as warm
 * (its status "degraded" is in {@link WARM_WORKSTATION_LEASE_STATUSES}) and the
 * kernel dispatches a coding task into a not-ready env (the "vitest not found"
 * mid-task failure). The capable SET is `new Set(map.keys())`.
 *
 * Fail-soft: absent readiness ⇒ not ready (a safe false-negative → the kernel
 * holds "warming" instead of dispatching into an unproven env).
 */
export async function getWorkstationReadinessByTedi(
	db: DbClient,
	organizationId: string,
): Promise<Map<string, WorkstationReadiness>> {
	const leaseRows = await db
		.select({
			id: workstationLeases.id,
			status: workstationLeases.status,
			metadata: workstationLeases.metadata,
		})
		.from(workstationLeases)
		.where(
			and(
				eq(workstationLeases.orgId, organizationId),
				inArray(workstationLeases.status, [...WARM_WORKSTATION_LEASE_STATUSES]),
			),
		);
	if (leaseRows.length === 0) return new Map();

	const readinessByLease = new Map<string, WorkstationReadiness>();
	for (const row of leaseRows) {
		readinessByLease.set(row.id, {
			leaseStatus: row.status,
			...extractLeaseReadiness(row.metadata),
		});
	}

	// D1 caps bound parameters at 100 per statement; chunk the lease IN() list.
	const participantRows: Array<{
		tediId: string | null;
		status: string;
		leaseId: string;
	}> = [];
	for (const chunk of chunkForBoundParams([...readinessByLease.keys()], 50)) {
		participantRows.push(
			...(await db
				.select({
					tediId: workstationParticipants.tediId,
					status: workstationParticipants.status,
					leaseId: workstationParticipants.leaseId,
				})
				.from(workstationParticipants)
				.where(inArray(workstationParticipants.leaseId, chunk))),
		);
	}

	const byTedi = new Map<string, WorkstationReadiness>();
	for (const row of participantRows) {
		if (
			!row.tediId ||
			!ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.includes(row.status)
		) {
			continue;
		}
		const leaseReadiness = readinessByLease.get(row.leaseId);
		if (!leaseReadiness) continue;
		const existing = byTedi.get(row.tediId);
		// A tedi may sit on more than one warm lease — keep the readiest.
		if (
			!existing ||
			(leaseReadiness.environmentReady && !existing.environmentReady) ||
			(leaseReadiness.depsReady && !existing.depsReady)
		) {
			byTedi.set(row.tediId, leaseReadiness);
		}
	}
	return byTedi;
}

/** One finished lease, with the container time it is accountable for. */
export interface WorkstationLeaseComputeWindow {
	leaseId: string;
	orgId: string;
	workItemId: string | null;
	profileId: WorkstationProfileId;
	/** Lead tedi, or null when the lease finished without one recorded. */
	leadTediId: string | null;
	startedAt: string;
	endedAt: string;
	/** Whole seconds of allocated container time. Always >= 1. */
	computeSeconds: number;
	terminalStatus: "released" | "expired";
}

/** Terminal states that stopped consuming container time. */
const WORKSTATION_LEASE_TERMINAL_STATUSES = ["released", "expired"] as const;

/**
 * Finished leases in a bounded window, shaped for provider-usage metering.
 *
 * Deliberately NOT anti-joined against `billing_provider_usage`: the caller
 * writes with a lease-derived `providerUsageId` under a partial unique index,
 * so re-metering an already-recorded lease is a no-op. Re-reading a settled
 * window is cheap; a cross-domain join here would put a billing table inside a
 * workstation query and risk the D1 duplicate-output-column rule for nothing.
 *
 * Participants are fetched in a second bounded query rather than joined, for
 * the same reason — `workstation_leases` and `workstation_participants` share
 * `id`, `org_id`, and `status` column names.
 */
export async function listWorkstationLeaseComputeWindows(
	db: DbClient,
	options: { since: string; until: string; limit: number },
): Promise<WorkstationLeaseComputeWindow[]> {
	const leases = await db
		.select({
			id: workstationLeases.id,
			orgId: workstationLeases.orgId,
			workItemId: workstationLeases.workItemId,
			profileId: workstationLeases.profileId,
			status: workstationLeases.status,
			createdAt: workstationLeases.createdAt,
			releasedAt: workstationLeases.releasedAt,
			expiresAt: workstationLeases.expiresAt,
		})
		.from(workstationLeases)
		.where(
			and(
				inArray(workstationLeases.status, [
					...WORKSTATION_LEASE_TERMINAL_STATUSES,
				]),
				gte(workstationLeases.updatedAt, options.since),
				lt(workstationLeases.updatedAt, options.until),
			),
		)
		.orderBy(asc(workstationLeases.updatedAt))
		.limit(options.limit);
	if (leases.length === 0) return [];

	const leadByLease = new Map<string, string>();
	// Chunked: D1 caps bound parameters at 100 per statement.
	for (let index = 0; index < leases.length; index += 50) {
		const chunk = leases.slice(index, index + 50);
		const participants = await db
			.select({
				leaseId: workstationParticipants.leaseId,
				tediId: workstationParticipants.tediId,
				role: workstationParticipants.role,
			})
			.from(workstationParticipants)
			.where(
				inArray(
					workstationParticipants.leaseId,
					chunk.map((lease) => lease.id),
				),
			);
		for (const participant of participants) {
			if (participant.role !== "lead" || !participant.tediId) continue;
			leadByLease.set(participant.leaseId, participant.tediId);
		}
	}

	const windows: WorkstationLeaseComputeWindow[] = [];
	for (const lease of leases) {
		// `expired` leases were reaped and never released, so they carry no
		// releasedAt — their container ran until the lease expiry.
		const endedAt = lease.releasedAt ?? lease.expiresAt;
		if (!endedAt || !lease.orgId) continue;
		const started = Date.parse(lease.createdAt);
		const ended = Date.parse(endedAt);
		if (!Number.isFinite(started) || !Number.isFinite(ended)) continue;
		const computeSeconds = Math.round((ended - started) / 1000);
		// A non-positive window means clock skew or a lease that never ran; both
		// are unmeterable rather than free, so skip instead of recording a zero.
		if (computeSeconds <= 0) continue;
		windows.push({
			computeSeconds,
			endedAt,
			leadTediId: leadByLease.get(lease.id) ?? null,
			leaseId: lease.id,
			orgId: lease.orgId,
			profileId: lease.profileId,
			startedAt: lease.createdAt,
			terminalStatus: lease.status === "expired" ? "expired" : "released",
			workItemId: lease.workItemId,
		});
	}
	return windows;
}

/**
 * Hours a lease may sit untouched before it is considered abandoned.
 *
 * `updated_at` moves on every workstation operation, so idleness — not age — is
 * what separates a leaked lease from a long-running legitimate session. A fixed
 * TTL from creation would kill the second to reclaim the first.
 */
export const WORKSTATION_LEASE_IDLE_EXPIRY_HOURS = 6;

export interface ExpiredWorkstationLease {
	leaseId: string;
	orgId: string | null;
	previousStatus: string;
	/** Last time the lease showed any life; the honest end of its container. */
	lastAliveAt: string;
}

/**
 * Expire leases that stopped being touched, so they reach a terminal state.
 *
 * WHY THIS EXISTS: `createWorkstationLease()` defaults `expiresAt` to null and
 * NO caller anywhere passes one, so before this every lease was immortal.
 * Only an explicit release could end one, which left 137 of 159 production
 * leases permanently non-terminal — unreclaimed, and invisible to
 * `workstation_compute` metering because it reads `releasedAt ?? expiresAt`
 * and both were null.
 *
 * `expires_at` is set to the lease's LAST ALIVE time, not to now. The container
 * stopped doing work when the lease went quiet, so billing the idle gap would
 * invent consumption. This under-states rather than over-states, matching how
 * the container estimate itself is built.
 */
export async function expireIdleWorkstationLeases(
	db: DbClient,
	options: { idleBefore: string; now: string; limit: number },
): Promise<ExpiredWorkstationLease[]> {
	const stale = await db
		.select({
			id: workstationLeases.id,
			orgId: workstationLeases.orgId,
			status: workstationLeases.status,
			updatedAt: workstationLeases.updatedAt,
		})
		.from(workstationLeases)
		.where(
			and(
				notInArray(workstationLeases.status, [
					...WORKSTATION_LEASE_TERMINAL_STATUSES,
				]),
				lt(workstationLeases.updatedAt, options.idleBefore),
			),
		)
		.orderBy(asc(workstationLeases.updatedAt))
		.limit(options.limit);
	if (stale.length === 0) return [];

	const expired: ExpiredWorkstationLease[] = [];
	for (const lease of stale) {
		// Re-assert the idle predicate in the UPDATE so a lease that came back to
		// life between the read and the write is not stolen from under its owner.
		const updated = await db
			.update(workstationLeases)
			.set({
				expiresAt: lease.updatedAt,
				status: "expired",
				updatedAt: options.now,
			})
			.where(
				and(
					eq(workstationLeases.id, lease.id),
					eq(workstationLeases.updatedAt, lease.updatedAt),
				),
			)
			.returning({ id: workstationLeases.id });
		if (updated.length === 0) continue;
		expired.push({
			lastAliveAt: lease.updatedAt,
			leaseId: lease.id,
			orgId: lease.orgId,
			previousStatus: lease.status,
		});
	}
	return expired;
}

/**
 * Leases the reaper should already have expired.
 *
 * A non-zero count means the reaper is not running, not scheduled, or failing:
 * every one of these is past the idle threshold, so a healthy pipeline drains
 * them to zero. This is the "went dark" detector for lease reclamation and
 * container metering — without it, a broken reaper looks exactly like a quiet
 * week, which is the failure shape that historically hid here for days.
 */
export async function countStaleWorkstationLeases(
	db: DbClient,
	idleBefore: string,
): Promise<{ stale: number; oldestUpdatedAt: string | null }> {
	const [row] = await db
		.select({
			oldestUpdatedAt: sql<string | null>`MIN(${workstationLeases.updatedAt})`,
			stale: sql<number>`COUNT(*)`,
		})
		.from(workstationLeases)
		.where(
			and(
				notInArray(workstationLeases.status, [
					...WORKSTATION_LEASE_TERMINAL_STATUSES,
				]),
				lt(workstationLeases.updatedAt, idleBefore),
			),
		);
	return {
		oldestUpdatedAt: row?.oldestUpdatedAt ?? null,
		stale: Number(row?.stale ?? 0),
	};
}

/** Participant states that have stopped holding a seat. */
const WORKSTATION_PARTICIPANT_CLOSED_STATUSES = ["left", "removed"] as const;

export interface ClosedLeaseBundle {
	leaseId: string;
	endedAt: string;
	participants: number;
	sessions: number;
	workstationArchived: boolean;
}

/**
 * Close the participants, sessions, and workstation of leases already terminal.
 *
 * `expireIdleWorkstationLeases` reclaims the LEASE and nothing else: it flips
 * `status` and `expires_at` and stops. A real release
 * (`releaseWorkstationLeaseBundle`) also marks every participant `left`, every
 * session `archived`, and the workstation `archived`. So every reaped lease
 * stranded its children, and the two ways a lease can end left the database in
 * two different shapes: terminal leases with participants still `active`,
 * sessions still `ready`/`blocked`/`degraded`/`provisioning`, and workstations
 * unarchived.
 *
 * A SWEEP, NOT A PATCH TO EXPIRY. Fixing only the expiry path would leave every
 * lease that already went terminal stranded forever — the reaper never revisits
 * a terminal lease. This heals the existing backlog and any future gap with one
 * mechanism, and re-running it is a no-op once a bundle is closed.
 *
 * `ended_at`/`left_at` come from the LEASE's terminal time, not from `now`.
 * Stamping the moment this sweep happens to run would date a session that
 * stopped days ago to today and silently inflate every duration derived from
 * it — the same wall-clock mistake that made container cost unusable.
 */
export async function closeTerminalLeaseBundles(
	db: DbClient,
	options: { now: string; limit: number },
): Promise<ClosedLeaseBundle[]> {
	// Driven off leases with at least one OPEN child, so a settled bundle is
	// never re-read. Single-column projections throughout: `workstation_leases`,
	// `workstation_participants`, and `workstation_sessions` all carry `id`,
	// `org_id`, and `status`, and D1 batch results collapse duplicate output
	// names before Drizzle maps them.
	const candidates = await db
		.select({
			endedAt: sql<string>`COALESCE(${workstationLeases.releasedAt}, ${workstationLeases.expiresAt}, ${workstationLeases.updatedAt})`,
			id: workstationLeases.id,
			workstationId: workstationLeases.workstationId,
		})
		.from(workstationLeases)
		.where(
			and(
				inArray(workstationLeases.status, [
					...WORKSTATION_LEASE_TERMINAL_STATUSES,
				]),
				sql`(
					EXISTS (
						SELECT 1 FROM ${workstationParticipants}
						WHERE ${workstationParticipants.leaseId} = ${workstationLeases.id}
						  AND ${workstationParticipants.status} NOT IN ('left', 'removed')
					)
					OR EXISTS (
						SELECT 1 FROM ${workstationSessions}
						WHERE ${workstationSessions.leaseId} = ${workstationLeases.id}
						  AND ${workstationSessions.status} <> 'archived'
					)
					OR EXISTS (
						SELECT 1 FROM ${workstations}
						WHERE ${workstations.id} = ${workstationLeases.workstationId}
						  AND ${workstations.status} <> 'archived'
					)
				)`,
			),
		)
		.orderBy(asc(workstationLeases.updatedAt))
		.limit(options.limit);
	if (candidates.length === 0) return [];

	const closed: ClosedLeaseBundle[] = [];
	for (const lease of candidates) {
		const endedAt = lease.endedAt;
		const participants = await db
			.update(workstationParticipants)
			.set({ leftAt: endedAt, status: "left" })
			.where(
				and(
					eq(workstationParticipants.leaseId, lease.id),
					notInArray(workstationParticipants.status, [
						...WORKSTATION_PARTICIPANT_CLOSED_STATUSES,
					]),
				),
			)
			.returning({ id: workstationParticipants.id });
		const sessions = await db
			.update(workstationSessions)
			.set({
				// Preserve an end that was already recorded; only a session that
				// never closed inherits the lease's terminal time.
				endedAt: sql`COALESCE(${workstationSessions.endedAt}, ${endedAt})`,
				status: "archived",
			})
			.where(
				and(
					eq(workstationSessions.leaseId, lease.id),
					notInArray(workstationSessions.status, ["archived"]),
				),
			)
			.returning({ id: workstationSessions.id });
		const archived = await db
			.update(workstations)
			.set({ status: "archived", updatedAt: options.now })
			.where(
				and(
					eq(workstations.id, lease.workstationId),
					notInArray(workstations.status, ["archived"]),
				),
			)
			.returning({ id: workstations.id });
		closed.push({
			endedAt,
			leaseId: lease.id,
			participants: participants.length,
			sessions: sessions.length,
			workstationArchived: archived.length > 0,
		});
	}
	return closed;
}

/**
 * Record which container instance a lease is actually running on.
 *
 * Written when apps/tedi resolves the workstation body, so the lease row and
 * the Cloudflare instance listing share a key. Recorded once per body
 * resolution rather than derived on read: see the column comments on
 * `workstation_leases.body_instance_name`.
 */
export async function recordWorkstationLeaseBodyInstance(
	db: DbClient,
	input: {
		leaseId: string;
		instanceId: string;
		instanceName: string;
		observedAt: string;
	},
): Promise<void> {
	await db
		.update(workstationLeases)
		.set({
			bodyInstanceId: input.instanceId,
			bodyInstanceName: input.instanceName,
			bodyInstanceObservedAt: input.observedAt,
			updatedAt: input.observedAt,
		})
		.where(eq(workstationLeases.id, input.leaseId));
}

export interface ReapableWorkstationBody {
	/** 64-hex Durable Object id that owns the container. */
	instanceId: string;
	/** Sandbox DO name; the string the containers dashboard prints. */
	instanceName: string;
	/** An org seen on a lease for this body, for scoped reporting. */
	orgId: string | null;
	/** Last time any lease confirmed this body was resolved. */
	lastObservedAt: string | null;
	/** How many terminal leases point at this body. */
	leaseCount: number;
}

/**
 * Container bodies that no lease still claims — the only safely reapable set.
 *
 * "A Running instance whose lease is terminal" is NOT the predicate. A body is
 * named by its Durable Object, and one DO serves every lease that resolves to
 * the same sandbox name. Reaping on a single terminal lease would stop a
 * container another, still-live lease is executing in. The predicate is
 * therefore per BODY, not per lease: every lease naming this body is terminal.
 *
 * Grouped on the RECORDED name rather than on `workstation_id`, because
 * `workstationSandboxId()` truncates and hashes long workstation ids — two
 * workstations could in principle land on one name, and it is the name, not the
 * workstation, that decides which container gets stopped.
 *
 * Rows with no recorded body are excluded, not assumed dead: a lease written
 * before this column existed cannot prove which container it held, and stopping
 * a container on that guess is exactly the move that was refused in production.
 */
export async function listReapableWorkstationBodies(
	db: DbClient,
	options: { limit: number },
): Promise<ReapableWorkstationBody[]> {
	const live = alias(workstationLeases, "live_lease");
	const rows = await db
		.select({
			instanceId: sql<string | null>`MAX(${workstationLeases.bodyInstanceId})`,
			instanceName: workstationLeases.bodyInstanceName,
			lastObservedAt: sql<
				string | null
			>`MAX(${workstationLeases.bodyInstanceObservedAt})`,
			leaseCount: sql<number>`COUNT(*)`,
			orgId: sql<string | null>`MAX(${workstationLeases.orgId})`,
		})
		.from(workstationLeases)
		.where(
			and(
				isNotNull(workstationLeases.bodyInstanceId),
				isNotNull(workstationLeases.bodyInstanceName),
				inArray(workstationLeases.status, [
					...WORKSTATION_LEASE_TERMINAL_STATUSES,
				]),
				notExists(
					db
						.select({ live: sql`1` })
						.from(live)
						.where(
							and(
								eq(live.bodyInstanceName, workstationLeases.bodyInstanceName),
								notInArray(live.status, [
									...WORKSTATION_LEASE_TERMINAL_STATUSES,
								]),
							),
						),
				),
			),
		)
		.groupBy(workstationLeases.bodyInstanceName)
		.orderBy(asc(sql`MAX(${workstationLeases.bodyInstanceObservedAt})`))
		.limit(options.limit);
	const reapable: ReapableWorkstationBody[] = [];
	for (const row of rows) {
		if (!row.instanceId || !row.instanceName) continue;
		reapable.push({
			instanceId: row.instanceId,
			instanceName: row.instanceName,
			lastObservedAt: row.lastObservedAt ?? null,
			leaseCount: Number(row.leaseCount ?? 0),
			orgId: row.orgId ?? null,
		});
	}
	return reapable;
}
