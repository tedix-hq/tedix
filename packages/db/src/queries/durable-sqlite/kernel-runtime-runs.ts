import { and, desc, eq, sql } from "drizzle-orm";
import { kernelRuntimeRuns } from "../../schema/cognitive-runtime";
import type {
	KernelRuntimeRun,
	KernelRuntimeRunUpdate,
	NewKernelRuntimeRun,
	TransitionKernelRuntimeRunStatusParams,
} from "../kernel-runtime-runs";
import {
	insertKernelRuntimeEventInTransaction,
	type KernelRuntimeEvent,
	type NewKernelRuntimeEvent,
} from "./kernel-runtime-events";
import type { TenantStoreDb } from "./tenant-store";

export type { KernelRuntimeRun, KernelRuntimeRunUpdate, NewKernelRuntimeRun };

export async function getKernelRuntimeRun(
	db: TenantStoreDb,
	input: { id: string; organizationId: string },
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row;
}

export async function insertKernelRuntimeRunIfAbsent(
	db: TenantStoreDb,
	value: NewKernelRuntimeRun,
): Promise<void> {
	await db
		.insert(kernelRuntimeRuns)
		.values(value)
		.onConflictDoNothing({ target: kernelRuntimeRuns.id });
}

export async function getKernelRuntimeRunStatus(
	db: TenantStoreDb,
	input: { id: string; organizationId: string },
): Promise<KernelRuntimeRun["status"] | undefined> {
	const [row] = await db
		.select({ status: kernelRuntimeRuns.status })
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row?.status;
}

export async function listKernelRuntimeRuns(
	db: TenantStoreDb,
	input: {
		organizationId: string;
		conversationId?: string;
		childRunIds?: string[];
		orderBy?: "created" | "updated" | "none";
		limit: number;
		offset?: number;
	},
): Promise<KernelRuntimeRun[]> {
	if (input.childRunIds?.length === 0) return [];
	const base = db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				input.conversationId
					? eq(kernelRuntimeRuns.conversationId, input.conversationId)
					: undefined,
				input.childRunIds
					? sql`${kernelRuntimeRuns.childRunId} IN (SELECT value FROM json_each(${JSON.stringify(input.childRunIds)}))`
					: undefined,
			),
		);
	const ordered =
		input.orderBy === "none"
			? base
			: base.orderBy(
					desc(
						input.orderBy === "created"
							? kernelRuntimeRuns.createdAt
							: kernelRuntimeRuns.updatedAt,
					),
				);
	const query = ordered.limit(input.limit);
	return input.offset ? query.offset(input.offset) : query;
}

export async function findKernelRuntimeRunByChild(
	db: TenantStoreDb,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
	},
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.delegatedTediId, input.delegatedTediId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return row;
}

export async function getDurableKernelRuntimeRun(
	db: TenantStoreDb,
	input: {
		id: string;
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
	},
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.delegatedTediId, input.delegatedTediId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return row;
}

function preserveHomeDelegationClaims(patch: KernelRuntimeRunUpdate) {
	if (patch.metadata === undefined) return patch;
	let metadata = sql`${JSON.stringify(patch.metadata)}`;
	for (const key of ["homeDelegationResume", "homeDelegationResolutionClaim"]) {
		const path = `$.${key}`;
		metadata = sql`case when json_type(${kernelRuntimeRuns.metadata}, ${path}) = 'object' then json_set(case when json_type(${metadata}) = 'object' then ${metadata} else '{}' end, ${path}, json_extract(${kernelRuntimeRuns.metadata}, ${path})) else json_remove(${metadata}, ${path}) end`;
	}
	return { ...patch, metadata };
}

export async function updateKernelRuntimeRunForOrg(
	db: TenantStoreDb,
	input: {
		id: string;
		organizationId: string;
		patch: KernelRuntimeRunUpdate;
	},
): Promise<void> {
	await db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(input.patch))
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
			),
		);
}

export async function transitionKernelRuntimeRunStatus(
	db: TenantStoreDb,
	input: TransitionKernelRuntimeRunStatusParams,
): Promise<boolean> {
	const rows = await db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(input.patch))
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.fromStatus),
				input.expectedUpdatedAt === undefined
					? undefined
					: eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length > 0;
}

export async function openKernelRuntimeTurn(
	db: TenantStoreDb,
	params: {
		run: NewKernelRuntimeRun;
		events: readonly [
			received: NewKernelRuntimeEvent,
			started: NewKernelRuntimeEvent,
		];
	},
): Promise<{
	events: Array<{ row: KernelRuntimeEvent; inserted: boolean }>;
}> {
	return db.transaction((tx) => {
		tx.insert(kernelRuntimeRuns)
			.values(params.run)
			.onConflictDoNothing({ target: kernelRuntimeRuns.id })
			.run();
		const events = params.events.map((event) =>
			insertKernelRuntimeEventInTransaction(tx, event),
		);
		if (events.some((event) => !event.row))
			throw new Error("Kernel runtime event was neither inserted nor found");
		return {
			events: events as Array<{ row: KernelRuntimeEvent; inserted: boolean }>,
		};
	});
}

export async function settleKernelRuntimeTurn(
	db: TenantStoreDb,
	params: {
		run: TransitionKernelRuntimeRunStatusParams;
		events: readonly NewKernelRuntimeEvent[];
	},
): Promise<{
	runTransitioned: boolean;
	events: Array<{ row: KernelRuntimeEvent; inserted: boolean }>;
}> {
	return db.transaction((tx) => {
		const runRows = tx
			.update(kernelRuntimeRuns)
			.set(preserveHomeDelegationClaims(params.run.patch))
			.where(
				and(
					eq(kernelRuntimeRuns.id, params.run.id),
					eq(kernelRuntimeRuns.organizationId, params.run.organizationId),
					eq(kernelRuntimeRuns.status, params.run.fromStatus),
					params.run.expectedUpdatedAt === undefined
						? undefined
						: eq(kernelRuntimeRuns.updatedAt, params.run.expectedUpdatedAt),
				),
			)
			.returning({ id: kernelRuntimeRuns.id })
			.all();
		const events = params.events.map((event) =>
			insertKernelRuntimeEventInTransaction(tx, event),
		);
		if (events.some((event) => !event.row))
			throw new Error("Kernel runtime event was neither inserted nor found");
		return {
			runTransitioned: runRows.length > 0,
			events: events as Array<{
				row: KernelRuntimeEvent;
				inserted: boolean;
			}>,
		};
	});
}

export async function compareAndTouchKernelRuntimeRun(
	db: TenantStoreDb,
	input: {
		id: string;
		organizationId: string;
		status: KernelRuntimeRun["status"];
		expectedUpdatedAt: string;
		updatedAt: string;
		requireNoDelegationResumeClaim?: boolean;
		delegationResolutionClaimId?: string;
		delegationApprovalEventId?: string;
		delegationWorkItemId?: string;
		delegationScopeDigest?: string;
	},
): Promise<boolean> {
	if (
		input.requireNoDelegationResumeClaim &&
		(!input.delegationResolutionClaimId?.trim() ||
			!input.delegationApprovalEventId?.trim())
	)
		return false;
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.updatedAt,
			...(input.requireNoDelegationResumeClaim
				? {
						metadata: sql`json_set(coalesce(${kernelRuntimeRuns.metadata}, '{}'), '$.homeDelegationResolutionClaim', json(${JSON.stringify({ version: 1, phase: "resolving", claimId: input.delegationResolutionClaimId, claimedAt: input.updatedAt, approvalEventId: input.delegationApprovalEventId, approvalResolvedAt: input.updatedAt, organizationId: input.organizationId, runId: input.id, workItemId: input.delegationWorkItemId ?? null, scopeDigest: input.delegationScopeDigest ?? null })}), '$.homeDelegationResolutionClaim.conversationId', ${kernelRuntimeRuns.conversationId})`,
					}
				: {}),
		})
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.status),
				eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt),
				input.requireNoDelegationResumeClaim
					? sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume') is null and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim') is null`
					: undefined,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length > 0;
}
