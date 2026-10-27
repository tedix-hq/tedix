/**
 * Sensitive-data latch on a run row (`skill_runs` or `kernel_runtime_runs`).
 *
 * The latch is set once, by the first sensitive read, and cleared only by a
 * person. It is read before public egress and before any grant or policy
 * auto-approval. See `@tedix/api-contract/schemas/sensitive-data-latch`.
 */

import type {
	RunRef,
	SensitiveDataLatch,
} from "@tedix/api-contract/schemas/sensitive-data-latch";
import { SensitiveDataLatchSchema } from "@tedix/api-contract/schemas/sensitive-data-latch";
import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import { skillRuns } from "../schema/cognitive";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { connectionInstances } from "../schema/connection-instances";
import { connectionProviders } from "../schema/connection-providers";

export interface RunSensitiveDataLatchParams {
	organizationId: string;
	runRef: RunRef;
}

export interface RunSensitiveDataLatchRow {
	/** False when no run row matches the reference inside the organization. */
	known: boolean;
	latch: SensitiveDataLatch | null;
}

function runTable(runRef: RunRef) {
	return runRef.kind === "skill_run"
		? {
				table: skillRuns,
				id: skillRuns.id,
				organizationId: skillRuns.organizationId,
				latch: skillRuns.sensitiveDataLatch,
			}
		: {
				table: kernelRuntimeRuns,
				id: kernelRuntimeRuns.id,
				organizationId: kernelRuntimeRuns.organizationId,
				latch: kernelRuntimeRuns.sensitiveDataLatch,
			};
}

function parseLatch(value: unknown): SensitiveDataLatch | null {
	const parsed = SensitiveDataLatchSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export async function getRunSensitiveDataLatch(
	db: DbClient,
	params: RunSensitiveDataLatchParams,
): Promise<RunSensitiveDataLatchRow> {
	const run = runTable(params.runRef);
	const rows = await db
		.select({ runLatch: run.latch })
		.from(run.table)
		.where(
			and(
				eq(run.id, params.runRef.id),
				eq(run.organizationId, params.organizationId),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return { known: false, latch: null };
	return { known: true, latch: parseLatch(row.runLatch) };
}

/**
 * Set the latch unless one is already set. The first sensitive read wins, so
 * a later read never rewrites the recorded source. Returns the latch now on
 * the row, or `known: false` when the run does not exist in the organization.
 */
export async function latchRunSensitiveData(
	db: DbClient,
	params: RunSensitiveDataLatchParams & { latch: SensitiveDataLatch },
): Promise<RunSensitiveDataLatchRow> {
	const run = runTable(params.runRef);
	await db
		.update(run.table)
		.set({ sensitiveDataLatch: params.latch })
		.where(
			and(
				eq(run.id, params.runRef.id),
				eq(run.organizationId, params.organizationId),
				isNull(run.latch),
			),
		);
	return getRunSensitiveDataLatch(db, params);
}

/** Clear the latch. Returns the latch that was cleared, or null when none was set. */
export async function clearRunSensitiveDataLatch(
	db: DbClient,
	params: RunSensitiveDataLatchParams,
): Promise<SensitiveDataLatch | null> {
	const current = await getRunSensitiveDataLatch(db, params);
	if (!current.latch) return null;
	const run = runTable(params.runRef);
	await db
		.update(run.table)
		.set({ sensitiveDataLatch: null })
		.where(
			and(
				eq(run.id, params.runRef.id),
				eq(run.organizationId, params.organizationId),
			),
		);
	return current.latch;
}

/**
 * A connection counts as sensitive when the organization's account for the
 * provider, or the provider's own default, is classified `restricted`. The
 * default `confidential` is ordinary business data and does not latch.
 */
export async function isConnectionProviderRestricted(
	db: DbClient,
	params: { organizationId: string; providerId: string },
): Promise<boolean> {
	const providerRows = await db
		.select({ providerDefault: connectionProviders.defaultDataSensitivity })
		.from(connectionProviders)
		.where(eq(connectionProviders.id, params.providerId))
		.limit(1);
	if (providerRows[0]?.providerDefault === "restricted") return true;
	const instanceRows = await db
		.select({ instanceId: connectionInstances.id })
		.from(connectionInstances)
		.where(
			and(
				eq(connectionInstances.providerId, params.providerId),
				eq(connectionInstances.organizationId, params.organizationId),
				eq(connectionInstances.dataSensitivity, "restricted"),
			),
		)
		.limit(1);
	return instanceRows.length > 0;
}
