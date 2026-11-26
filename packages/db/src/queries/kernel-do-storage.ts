import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { jsonType } from "../core-store/dialect";
import {
	type KernelRuntimeRun,
	kernelRuntimeRuns,
	kernelRuntimeRunStoredColumns,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";

export async function hasPendingKernelWake(
	db: DbClient,
	organizationId: string,
): Promise<boolean> {
	const table = coreTable(db, kernelWakeQueue);
	const [row] = await db
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.organizationId, organizationId), isNull(table.ackedAt)))
		.limit(1);
	return row !== undefined;
}

export async function listPendingKernelWakes(
	db: DbClient,
	input: { organizationId: string; limit: number },
) {
	const table = coreTable(db, kernelWakeQueue);
	return db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				isNull(table.ackedAt),
			),
		)
		.limit(input.limit);
}

export async function acknowledgeKernelWake(
	db: DbClient,
	input: { id: string; ackedAt: string },
): Promise<void> {
	const table = coreTable(db, kernelWakeQueue);
	await db
		.update(table)
		.set({ ackedAt: input.ackedAt })
		.where(eq(table.id, input.id));
}

export async function failActiveKernelRun(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		progressDetail: string;
		now: string;
	},
): Promise<boolean> {
	const table = coreTable(db, kernelRuntimeRuns);
	const rows = await db
		.update(table)
		.set({
			status: "failed",
			progressLabel: "Model unavailable",
			progressDetail: input.progressDetail,
			completedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
				inArray(table.status, ["running", "queued"]),
			),
		)
		.returning({ id: table.id });
	return rows.length > 0;
}

export async function listKernelRunsByStatus(
	db: DbClient,
	input: {
		organizationId: string;
		statuses: KernelRuntimeRun["status"][];
		limit: number;
	},
) {
	const table = coreTable(db, kernelRuntimeRuns);
	return db
		.select(kernelRuntimeRunStoredColumns)
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				// bound-params: subset of the closed KernelRuntimeRun status enum
				inArray(table.status, input.statuses),
			),
		)
		.orderBy(asc(table.updatedAt))
		.limit(input.limit);
}

export async function getKernelRunForRecovery(
	db: DbClient,
	input: { id: string; organizationId: string },
) {
	const table = coreTable(db, kernelRuntimeRuns);
	const [row] = await db
		.select(kernelRuntimeRunStoredColumns)
		.from(table)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function transitionKernelRunForRecovery(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		expectedStatus: KernelRuntimeRun["status"];
		patch: Partial<typeof kernelRuntimeRuns.$inferInsert>;
	},
): Promise<boolean> {
	const table = coreTable(db, kernelRuntimeRuns);
	const rows = await db
		.update(table)
		.set(input.patch)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
				eq(table.status, input.expectedStatus),
			),
		)
		.returning({ id: table.id });
	return rows.length > 0;
}

/**
 * Claim a stale Home run for a same-run re-drive. Unlike the status-only
 * recovery transition, this refuses a run that was routed, delegated or held
 * for a delegation decision after the caller read it, so the patch can never
 * overwrite a route or delegation that settled concurrently.
 */
export async function claimUnroutedKernelRunForRedrive(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		expectedStatus: KernelRuntimeRun["status"];
		patch: Pick<
			typeof kernelRuntimeRuns.$inferInsert,
			"updatedAt" | "metadata"
		>;
	},
): Promise<boolean> {
	const table = coreTable(db, kernelRuntimeRuns);
	const rows = await db
		.update(table)
		.set(input.patch)
		.where(
			and(
				eq(table.id, input.id),
				eq(table.organizationId, input.organizationId),
				eq(table.status, input.expectedStatus),
				isNull(table.delegatedTediId),
				isNull(table.childRunId),
				// 'null' is the stored "route not decided yet" marker; an absent key proves nothing.
				sql`${jsonType(db, table.metadata, ["kernelRoute"])} = 'null'`,
				sql`coalesce(${jsonType(db, table.metadata, ["homeDelegation"])}, 'null') = 'null'`,
			),
		)
		.returning({ id: table.id });
	return rows.length > 0;
}
