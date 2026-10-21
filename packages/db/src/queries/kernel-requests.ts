import type { KernelRequestSnapshot } from "@tedix/api-contract/schemas/kernel-request";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { agentSessionRequests } from "../schema/agent-session-requests";
import type { WorkAgentSessionHarness } from "../schema/work-agent-sessions";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import type { DbQueryClient } from "../query-client";
import { workAttempts } from "../schema/work-items";
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

/** Internal existing maintenance tick: discover bounded tenant coordinators with overdue state. */
export async function listDueKernelRequestOrganizations(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select({ organizationId: kernelRequests.organizationId })
		.from(kernelRequests)
		.where(lte(kernelRequests.nextDueAt, now))
		.groupBy(kernelRequests.organizationId)
		.orderBy(
			sql`min(${kernelRequests.nextDueAt})`,
			asc(kernelRequests.organizationId),
		)
		.limit(5);
}

/** Atomically fence source publication against cancellation, rebriefing and successor Attempts. */
export async function publishKernelRequestReport(
	db: DbQueryClient,
	p: KernelRequestScope & {
		expectedVersion: number;
		acceptanceKey: string;
		attemptId: string;
		workItemId: string;
		intentId: string;
		conversationId: string;
		runId: string;
		messageId: string;
		payload: Record<string, JsonValue>;
		now: string;
	},
) {
	await db
		.insert(kernelRuntimeEvents)
		.select(
			db
				.select({
					id: sql<string>`${p.intentId}`.as("id"),
					organizationId: kernelRequests.organizationId,
					kind: sql<"message.completed">`'message.completed'`.as("kind"),
					conversationId: sql<string>`${p.conversationId}`.as(
						"conversation_id",
					),
					runId: sql<string>`${p.runId}`.as("run_id"),
					messageId: sql<string>`${p.messageId}`.as("message_id"),
					payload: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(p.payload)}`.as("payload"),
					runtimeBackend: sql<"custom">`'custom'`.as("runtime_backend"),
					createdAt: sql<string>`${p.now}`.as("created_at"),
				})
				.from(kernelRequests)
				.where(
					and(
						scoped(p),
						eq(kernelRequests.version, p.expectedVersion),
						sql`json_extract(${kernelRequests.snapshot}, '$.acceptanceKey') = ${p.acceptanceKey}`,
						sql`json_extract(${kernelRequests.snapshot}, '$.delivery.intentId') = ${p.intentId}`,
						sql`json_extract(${kernelRequests.snapshot}, '$.delivery.status') = 'pending'`,
						sql`EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=${p.organizationId} AND m.descope_user_id=${p.ownerUserId} AND m.status='active')`,
						sql`(NOT EXISTS (SELECT 1 FROM kernel_conversation_grants g WHERE g.organization_id=${p.organizationId} AND g.conversation_id=${p.conversationId}) OR EXISTS (SELECT 1 FROM kernel_conversation_grants g WHERE g.organization_id=${p.organizationId} AND g.conversation_id=${p.conversationId} AND g.grantee_descope_user_id=${p.ownerUserId}))`,
						sql`EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${p.organizationId} AND w.id=${p.workItemId} AND w.disposition != 'cancelled')`,
						sql`EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=${p.organizationId} AND a.work_item_id=${p.workItemId} AND a.id=${p.attemptId} AND a.outcome='succeeded' AND NOT EXISTS (SELECT 1 FROM work_attempts n WHERE n.org_id=a.org_id AND n.work_item_id=a.work_item_id AND n.attempt_number > a.attempt_number))`,
					),
				),
		)
		.onConflictDoNothing({ target: kernelRuntimeEvents.id });
	return (
		await db
			.select()
			.from(kernelRuntimeEvents)
			.where(
				and(
					eq(kernelRuntimeEvents.id, p.intentId),
					eq(kernelRuntimeEvents.organizationId, p.organizationId),
					eq(kernelRuntimeEvents.conversationId, p.conversationId),
					eq(kernelRuntimeEvents.runId, p.runId),
					sql`json_extract(${kernelRuntimeEvents.payload}, '$.metadata.requestId') = ${p.id}`,
				),
			)
			.limit(1)
	)[0];
}

/** Internal source adapter; public reads continue through the Home conversation ACL. */
export async function getHomeKernelRequest(
	db: DbQueryClient,
	organizationId: string,
	runId: string,
) {
	return (
		await db
			.select()
			.from(kernelRequests)
			.where(
				and(
					eq(kernelRequests.id, `home:${runId}`),
					eq(kernelRequests.organizationId, organizationId),
					eq(kernelRequests.sourceKind, "home"),
					eq(kernelRequests.sourceId, runId),
				),
			)
			.limit(1)
	)[0];
}

/** Field-only projection preserves concurrent run metadata and never changes execution settlement. */
export async function projectKernelRequestOnHomeRun(
	db: DbQueryClient,
	row: KernelRequestRow,
) {
	await db
		.update(kernelRuntimeRuns)
		.set({
			metadata: sql`json_set(coalesce(${kernelRuntimeRuns.metadata}, '{}'), '$.kernelRequestAcceptance', json(${JSON.stringify(row.snapshot)}), '$.kernelRequestId', ${row.id})`,
		})
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, row.organizationId),
				eq(kernelRuntimeRuns.id, row.sourceId),
			),
		);
}

/** Replay lookup after extraction: exact private session and source time, never an org-wide prompt scan. */
export async function listLocalRequestsForKernelCapture(
	db: DbQueryClient,
	p: {
		organizationId: string;
		userId: string;
		harness: WorkAgentSessionHarness;
		sessionKey: string;
		sourceAt: string;
	},
) {
	return db
		.select()
		.from(agentSessionRequests)
		.where(
			and(
				eq(agentSessionRequests.organizationId, p.organizationId),
				eq(agentSessionRequests.userId, p.userId),
				eq(agentSessionRequests.harness, p.harness),
				eq(agentSessionRequests.sessionKey, p.sessionKey),
				eq(agentSessionRequests.sourceAt, p.sourceAt),
			),
		)
		.orderBy(asc(agentSessionRequests.sourceKey))
		.limit(200);
}

/** Private ledger receipt; this does not assert that a local chat resumed or read a reply. */
export async function publishLocalKernelRequestReport(
	db: DbQueryClient,
	p: KernelRequestScope & {
		sourceId: string;
		expectedVersion: number;
		acceptanceKey: string;
		attemptId: string;
		workItemId: string;
		intentId: string;
		evidence: string;
		now: string;
	},
) {
	const rows = await db
		.update(agentSessionRequests)
		.set({
			status: "done",
			evidence: p.evidence,
			statusChangedAt: p.now,
			updatedAt: p.now,
		})
		.where(
			and(
				eq(agentSessionRequests.organizationId, p.organizationId),
				eq(agentSessionRequests.userId, p.ownerUserId),
				eq(agentSessionRequests.id, p.sourceId),
				sql`${agentSessionRequests.status} != 'cancelled'`,
				sql`EXISTS (SELECT 1 FROM kernel_requests r WHERE r.organization_id=${p.organizationId} AND r.owner_user_id=${p.ownerUserId} AND r.id=${p.id} AND r.source_kind='agent_session_request' AND r.source_id=${p.sourceId} AND r.version=${p.expectedVersion} AND json_extract(r.snapshot,'$.acceptanceKey')=${p.acceptanceKey} AND json_extract(r.snapshot,'$.delivery.intentId')=${p.intentId} AND json_extract(r.snapshot,'$.delivery.status')='pending')`,
				sql`EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=${p.organizationId} AND m.descope_user_id=${p.ownerUserId} AND m.status='active')`,
				sql`EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${p.organizationId} AND w.id=${p.workItemId} AND w.disposition != 'cancelled')`,
				sql`EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id=${p.organizationId} AND a.work_item_id=${p.workItemId} AND a.id=${p.attemptId} AND a.outcome='succeeded' AND NOT EXISTS (SELECT 1 FROM work_attempts n WHERE n.org_id=a.org_id AND n.work_item_id=a.work_item_id AND n.attempt_number > a.attempt_number))`,
			),
		)
		.returning();
	return rows[0];
}

/** How far back the tick looks for dispatcher settlements not yet tracked. */
export const DISPATCHER_ATTEMPT_CAPTURE_LOOKBACK_MS = 6 * 3_600_000;

/**
 * Lane-serve settlements stamp `dispatchVersion`; each terminal one enters the
 * tracker once. `since` bounds the scan on `idx_work_attempt_expiry` (a settled
 * Attempt keeps its last lease expiry).
 */
function uncapturedDispatcherAttempts(since: string) {
	return and(
		inArray(workAttempts.runtimeState, ["finished", "failed", "expired"]),
		gte(workAttempts.expiresAt, since),
		sql`json_extract(${workAttempts.metadata}, '$.dispatchVersion') IS NOT NULL`,
		sql`NOT EXISTS (SELECT 1 FROM kernel_requests r WHERE r.organization_id = ${workAttempts.orgId} AND r.owner_user_id = ${workAttempts.executorId} AND r.source_kind = 'work_attempt' AND r.source_id = ${workAttempts.id})`,
	);
}

export async function listUncapturedDispatcherAttempts(
	db: DbQueryClient,
	p: { organizationId: string; since: string; limit: number },
) {
	return db
		.select()
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, p.organizationId),
				uncapturedDispatcherAttempts(p.since),
			),
		)
		.orderBy(asc(workAttempts.expiresAt), asc(workAttempts.id))
		.limit(Math.min(20, Math.max(1, p.limit)));
}

/**
 * Internal maintenance tick: tenants with dispatcher settlements not yet
 * tracked whose active policy pack opts into delivery verification. Tenants
 * that never capture must not fill the bounded page and starve those that do.
 */
export async function listDispatcherAttemptCaptureOrganizations(
	db: DbQueryClient,
	since: string,
) {
	return db
		.select({ organizationId: workAttempts.orgId })
		.from(workAttempts)
		.where(
			and(
				uncapturedDispatcherAttempts(since),
				sql`(SELECT json_extract(p.definition, '$.kernelRequestCoordinator.enabled') = 1
					AND json_type(p.definition, '$.kernelRequestCoordinator.workAttemptDelivery') = 'object'
					FROM policy_packs p
					WHERE p.organization_id = ${workAttempts.orgId} AND p.status = 'active'
					ORDER BY p.version DESC LIMIT 1) = 1`,
			),
		)
		.groupBy(workAttempts.orgId)
		.orderBy(asc(workAttempts.orgId))
		.limit(5);
}
