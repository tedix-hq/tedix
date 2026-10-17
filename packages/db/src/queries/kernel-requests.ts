import type { KernelRequestSnapshot } from "@tedix/api-contract/schemas/kernel-request";
import { and, asc, eq, lte } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	kernelRequests,
	kernelRequestEvents,
	type KernelRequestRow,
} from "../schema/kernel-requests";

export interface KernelRequestScope {
	organizationId: string;
	ownerUserId: string;
	id: string;
}
const scoped = (s: KernelRequestScope) =>
	and(
		eq(kernelRequests.organizationId, s.organizationId),
		eq(kernelRequests.ownerUserId, s.ownerUserId),
		eq(kernelRequests.id, s.id),
	);

function requireNextAction(row: {
	snapshot: KernelRequestSnapshot;
	nextOwner: string;
	nextAction: string;
	nextDueAt?: string | null;
}) {
	const terminal =
		row.snapshot.state === "learned" || row.snapshot.state === "cancelled";
	if (
		!row.nextOwner.trim() ||
		!row.nextAction.trim() ||
		(!terminal &&
			(!row.nextDueAt || !Number.isFinite(Date.parse(row.nextDueAt))))
	)
		throw new Error(
			"Nonterminal requests require an owner, action and due time",
		);
}

export async function getKernelRequest(
	db: DbQueryClient,
	scope: KernelRequestScope,
) {
	return (
		await db.select().from(kernelRequests).where(scoped(scope)).limit(1)
	)[0];
}

/** Caller authorizes the source and supplies its durable id before recording intake. */
export async function receiveKernelRequest(
	db: DbQueryClient,
	row: typeof kernelRequests.$inferInsert,
) {
	requireNextAction(row);
	await db.batch([
		db.insert(kernelRequests).values(row).onConflictDoNothing(),
		db
			.insert(kernelRequestEvents)
			.select(
				db
					.select({
						id: kernelRequests.lastEventId,
						organizationId: kernelRequests.organizationId,
						ownerUserId: kernelRequests.ownerUserId,
						requestId: kernelRequests.id,
						version: kernelRequests.version,
						snapshot: kernelRequests.snapshot,
						createdAt: kernelRequests.updatedAt,
					})
					.from(kernelRequests)
					.where(
						and(scoped(row), eq(kernelRequests.lastEventId, row.lastEventId)),
					),
			)
			.onConflictDoNothing({
				target: [kernelRequestEvents.requestId, kernelRequestEvents.version],
			}),
	]);
	return (
		await db
			.select()
			.from(kernelRequests)
			.where(
				and(
					eq(kernelRequests.organizationId, row.organizationId),
					eq(kernelRequests.ownerUserId, row.ownerUserId),
					eq(kernelRequests.sourceKind, row.sourceKind),
					eq(kernelRequests.sourceId, row.sourceId),
				),
			)
			.limit(1)
	)[0];
}

export interface TransitionKernelRequestParams extends KernelRequestScope {
	expectedVersion: number;
	eventId: string;
	snapshot: KernelRequestSnapshot;
	nextOwner: string;
	nextAction: string;
	nextDueAt: string | null;
	now: string;
}

/** CAS and append are one D1 transaction. Losing writers cannot append an event. */
export async function transitionKernelRequest(
	db: DbQueryClient,
	p: TransitionKernelRequestParams,
): Promise<KernelRequestRow | undefined> {
	requireNextAction(p);
	const version = p.expectedVersion + 1;
	const [updated] = await db.batch([
		db
			.update(kernelRequests)
			.set({
				version,
				snapshot: p.snapshot,
				nextOwner: p.nextOwner,
				nextAction: p.nextAction,
				nextDueAt: p.nextDueAt,
				lastEventId: p.eventId,
				updatedAt: p.now,
			})
			.where(and(scoped(p), eq(kernelRequests.version, p.expectedVersion)))
			.returning(),
		db
			.insert(kernelRequestEvents)
			.select(
				db
					.select({
						id: kernelRequests.lastEventId,
						organizationId: kernelRequests.organizationId,
						ownerUserId: kernelRequests.ownerUserId,
						requestId: kernelRequests.id,
						version: kernelRequests.version,
						snapshot: kernelRequests.snapshot,
						createdAt: kernelRequests.updatedAt,
					})
					.from(kernelRequests)
					.where(
						and(
							scoped(p),
							eq(kernelRequests.version, version),
							eq(kernelRequests.lastEventId, p.eventId),
						),
					),
			)
			.onConflictDoNothing({
				target: [kernelRequestEvents.requestId, kernelRequestEvents.version],
			}),
	]);
	return updated[0];
}

/** Internal org coordinator scan only. Source readers still enforce user/conversation ACLs. */
export async function listDueKernelRequests(
	db: DbQueryClient,
	p: { organizationId: string; now: string; limit: number },
) {
	return db
		.select()
		.from(kernelRequests)
		.where(
			and(
				eq(kernelRequests.organizationId, p.organizationId),
				lte(kernelRequests.nextDueAt, p.now),
			),
		)
		.orderBy(asc(kernelRequests.nextDueAt), asc(kernelRequests.id))
		.limit(Math.min(50, Math.max(1, p.limit)));
}

export async function listKernelRequestEvents(
	db: DbQueryClient,
	s: KernelRequestScope,
) {
	return db
		.select()
		.from(kernelRequestEvents)
		.where(
			and(
				eq(kernelRequestEvents.organizationId, s.organizationId),
				eq(kernelRequestEvents.ownerUserId, s.ownerUserId),
				eq(kernelRequestEvents.requestId, s.id),
			),
		)
		.orderBy(asc(kernelRequestEvents.version))
		.limit(100);
}
