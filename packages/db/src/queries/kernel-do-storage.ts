import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type KernelRuntimeRun,
	kernelRuntimeRuns,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";

export async function hasPendingKernelWake(
	db: DbClient,
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: kernelWakeQueue.id })
		.from(kernelWakeQueue)
		.where(
			and(
				eq(kernelWakeQueue.organizationId, organizationId),
				isNull(kernelWakeQueue.ackedAt),
			),
		)
		.limit(1);
	return row !== undefined;
}

export async function listPendingKernelWakes(
	db: DbClient,
	input: { organizationId: string; limit: number },
) {
	return db
		.select()
		.from(kernelWakeQueue)
		.where(
			and(
				eq(kernelWakeQueue.organizationId, input.organizationId),
				isNull(kernelWakeQueue.ackedAt),
			),
		)
		.limit(input.limit);
}

export async function acknowledgeKernelWake(
	db: DbClient,
	input: { id: string; ackedAt: string },
): Promise<void> {
	await db
		.update(kernelWakeQueue)
		.set({ ackedAt: input.ackedAt })
		.where(eq(kernelWakeQueue.id, input.id));
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
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			status: "failed",
			progressLabel: "Model unavailable",
			progressDetail: input.progressDetail,
			completedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				inArray(kernelRuntimeRuns.status, ["running", "queued"]),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
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
	return db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				// bound-params: subset of the closed KernelRuntimeRun status enum
				inArray(kernelRuntimeRuns.status, input.statuses),
			),
		)
		.orderBy(asc(kernelRuntimeRuns.updatedAt))
		.limit(input.limit);
}

export async function getKernelRunForRecovery(
	db: DbClient,
	input: { id: string; organizationId: string },
) {
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
	const rows = await db
		.update(kernelRuntimeRuns)
		.set(input.patch)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.expectedStatus),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length > 0;
}
