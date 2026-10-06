import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import type {
	HarnessSubjectTraceBundle,
	TraceBundle,
	TraceBundleWorkstation,
} from "@tedix/api-contract/schemas/harness-version";
import { TraceBundleWorkstationSchema } from "@tedix/api-contract/schemas/harness-version";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type HarnessSubjectTraceBundleRow,
	harnessSubjectTraceBundles,
	harnessVersions,
	type TraceBundleRow,
	traceBundles,
} from "../../schema/harness-versions";
import { tedis } from "../../schema/tedis";
import {
	type JsonObject,
	optionalJsonObject,
	safeJsonObject,
} from "./persistence-json";
import type { HarnessSubjectRef } from "./subjects";

export interface ListTraceBundlesOptions {
	tediId: string;
	runId?: string;
	harnessVersionId?: string;
	limit?: number;
}

export async function listTraceBundles(
	db: DbClient,
	options: ListTraceBundlesOptions,
): Promise<TraceBundleRow[]> {
	const conditions = [eq(traceBundles.tediId, options.tediId)];
	if (options.runId) {
		conditions.push(eq(traceBundles.runId, options.runId));
	}
	if (options.harnessVersionId) {
		conditions.push(
			eq(traceBundles.harnessVersionId, options.harnessVersionId),
		);
	}
	const rows = await db
		.select()
		.from(traceBundles)
		.where(and(...conditions))
		.orderBy(desc(traceBundles.createdAt))
		.limit(options.limit ?? 50);
	return rows;
}

export interface ListHarnessSubjectTraceBundlesOptions extends HarnessSubjectRef {
	runId?: string;
	harnessVersionId?: string;
	limit?: number;
}

export async function listHarnessSubjectTraceBundles(
	db: DbClient,
	options: ListHarnessSubjectTraceBundlesOptions,
): Promise<HarnessSubjectTraceBundleRow[]> {
	const conditions = [
		eq(harnessSubjectTraceBundles.subjectKind, options.subjectKind),
		eq(harnessSubjectTraceBundles.subjectId, options.subjectId),
	];
	if (options.runId) {
		conditions.push(eq(harnessSubjectTraceBundles.runId, options.runId));
	}
	if (options.harnessVersionId) {
		conditions.push(
			eq(harnessSubjectTraceBundles.harnessVersionId, options.harnessVersionId),
		);
	}
	const rows = await db
		.select()
		.from(harnessSubjectTraceBundles)
		.where(and(...conditions))
		.orderBy(desc(harnessSubjectTraceBundles.createdAt))
		.limit(options.limit ?? 50);
	return rows;
}

/** Clear a subject bundle's raw-evidence pointer after an audited retention deletion. */
export async function clearHarnessSubjectTraceBundleUri(
	db: DbClient,
	id: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await db
		.update(harnessSubjectTraceBundles)
		.set({ bundleUri: null, metadata: safeJsonObject(metadata) })
		.where(eq(harnessSubjectTraceBundles.id, id));
}

/**
 * Insert a trace bundle. Conflict-do-nothing on `id` so the per-run idempotent
 * emission (`${runId}:bundle`) survives queue retries.
 */
/**
 * Union two id lists, order-preserving + de-duped + null-safe. The trace bundle
 * is emitted from TWO independent queued steps (ledger-mirror has the event ids;
 * the brain-bridge re-emit has the rationale/artifact ids), so whichever lands
 * second must MERGE its ids into the existing row rather than no-op.
 */
export function unionTraceBundleIds(
	existing: readonly string[] | null | undefined,
	incoming: readonly string[] | null | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of [...(existing ?? []), ...(incoming ?? [])]) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function unionMetadataStringArray(
	existing: unknown,
	incoming: unknown,
): string[] | undefined {
	if (!Array.isArray(existing) && !Array.isArray(incoming)) return undefined;
	const merged = unionTraceBundleIds(
		Array.isArray(existing)
			? existing.filter((id) => typeof id === "string")
			: [],
		Array.isArray(incoming)
			? incoming.filter((id) => typeof id === "string")
			: [],
	);
	return merged;
}

function mergeTraceBundleWorkstation(
	existing: JsonValue | undefined,
	incoming: JsonValue | undefined,
): TraceBundleWorkstation | undefined {
	const existingWorkstation = TraceBundleWorkstationSchema.safeParse(existing);
	const incomingWorkstation = TraceBundleWorkstationSchema.safeParse(incoming);
	const existingData = existingWorkstation.success
		? existingWorkstation.data
		: null;
	const incomingData = incomingWorkstation.success
		? incomingWorkstation.data
		: null;
	if (!existingData && !incomingData) return undefined;
	const preferred = incomingData ?? existingData;
	if (!preferred) return undefined;
	return {
		profileId: preferred.profileId,
		workstationId: preferred.workstationId,
		leaseId: incomingData?.leaseId ?? existingData?.leaseId ?? null,
		sessionIds: unionTraceBundleIds(
			existingData?.sessionIds,
			incomingData?.sessionIds,
		),
		participantIds: unionTraceBundleIds(
			existingData?.participantIds,
			incomingData?.participantIds,
		),
	};
}

function traceBundleMetadata(
	metadata: Record<string, unknown> | null | undefined,
	workstation: TraceBundleWorkstation | null | undefined,
): JsonObject | null {
	const next = mergeTraceBundleMetadata(
		metadata,
		workstation ? { workstation } : null,
	);
	return next && Object.keys(next).length > 0 ? next : null;
}

/**
 * Merge trace metadata from the two independent isolate emitters. Incoming keys
 * can fill/refresh the envelope, but id arrays inside `bodyExecutionResult`
 * merge like top-level trace ids so a later ids-only emission cannot erase
 * artifact/rationale evidence from the bridge path.
 */
export function mergeTraceBundleMetadata(
	existing: Record<string, unknown> | null | undefined,
	incoming: Record<string, unknown> | null | undefined,
): JsonObject | null {
	const existingObject = optionalJsonObject(
		existing,
		"existing trace bundle metadata",
	);
	const incomingObject = optionalJsonObject(
		incoming,
		"incoming trace bundle metadata",
	);
	if (!existingObject && !incomingObject) return null;

	const merged: JsonObject = {
		...existingObject,
		...incomingObject,
	};
	const existingResult = safeJsonObject(existingObject?.bodyExecutionResult);
	const incomingResult = safeJsonObject(incomingObject?.bodyExecutionResult);

	if (existingResult || incomingResult) {
		const bodyExecutionResult: JsonObject = {
			...existingResult,
			...incomingResult,
		};
		for (const key of ["approvalIds", "artifactIds", "runtimeServices"]) {
			const unioned = unionMetadataStringArray(
				existingResult?.[key],
				incomingResult?.[key],
			);
			if (unioned) bodyExecutionResult[key] = unioned;
		}
		merged.bodyExecutionResult = bodyExecutionResult;
	}

	const workstation = mergeTraceBundleWorkstation(
		existingObject?.workstation,
		incomingObject?.workstation,
	);
	if (workstation) {
		merged.workstation = JsonValueSchema.parse(workstation);
	}

	return Object.keys(merged).length > 0 ? merged : null;
}

export async function recordTraceBundle(
	db: DbClient,
	bundle: TraceBundle,
): Promise<boolean> {
	const version = (
		await db
			.select({ tediId: harnessVersions.tediId, orgId: harnessVersions.orgId })
			.from(harnessVersions)
			.where(eq(harnessVersions.id, bundle.harnessVersionId))
			.limit(1)
	)[0];
	const tedi = (
		await db
			.select({ organizationId: tedis.organizationId })
			.from(tedis)
			.where(eq(tedis.id, bundle.tediId))
			.limit(1)
	)[0];
	if (
		!version ||
		!tedi ||
		tedi.organizationId !== (bundle.orgId ?? null) ||
		version.tediId !== bundle.tediId ||
		(version.orgId !== null && version.orgId !== (bundle.orgId ?? null))
	) {
		return false;
	}
	const existingRows = await db
		.select()
		.from(traceBundles)
		.where(eq(traceBundles.id, bundle.id))
		.limit(1);
	const existing = existingRows[0];
	if (
		existing &&
		(existing.tediId !== bundle.tediId ||
			existing.orgId !== (bundle.orgId ?? null) ||
			existing.harnessVersionId !== bundle.harnessVersionId)
	) {
		return false;
	}

	if (!existing) {
		await db
			.insert(traceBundles)
			.values({
				id: bundle.id,
				tediId: bundle.tediId,
				orgId: bundle.orgId ?? null,
				conversationId: bundle.conversationId ?? null,
				runId: bundle.runId,
				harnessVersionId: bundle.harnessVersionId,
				eventIds: bundle.eventIds ?? [],
				rationaleRecordIds: bundle.rationaleRecordIds ?? [],
				artifactIds: bundle.artifactIds ?? [],
				evalResultId: bundle.evalResultId ?? null,
				bundleUri: bundle.bundleUri ?? null,
				summary: bundle.summary ?? null,
				outcome: bundle.outcome ?? null,
				metadata: traceBundleMetadata(bundle.metadata, bundle.workstation),
				createdAt: bundle.createdAt,
			})
			// Guard the read→write race: if a concurrent emission inserted the row
			// between our SELECT and INSERT, do nothing — its arrays land first and
			// our ids arrive on the next (retried) emission's merge path.
			.onConflictDoNothing({ target: traceBundles.id });
		const persisted = (
			await db
				.select({
					tediId: traceBundles.tediId,
					orgId: traceBundles.orgId,
					harnessVersionId: traceBundles.harnessVersionId,
				})
				.from(traceBundles)
				.where(eq(traceBundles.id, bundle.id))
				.limit(1)
		)[0];
		return (
			persisted?.tediId === bundle.tediId &&
			persisted.orgId === (bundle.orgId ?? null) &&
			persisted.harnessVersionId === bundle.harnessVersionId
		);
	}

	await db
		.update(traceBundles)
		.set({
			eventIds: unionTraceBundleIds(existing.eventIds, bundle.eventIds),
			rationaleRecordIds: unionTraceBundleIds(
				existing.rationaleRecordIds,
				bundle.rationaleRecordIds,
			),
			artifactIds: unionTraceBundleIds(
				existing.artifactIds,
				bundle.artifactIds,
			),
			harnessVersionId: existing.harnessVersionId || bundle.harnessVersionId,
			evalResultId: existing.evalResultId ?? bundle.evalResultId ?? null,
			bundleUri: existing.bundleUri ?? bundle.bundleUri ?? null,
			summary: existing.summary ?? bundle.summary ?? null,
			outcome: existing.outcome ?? bundle.outcome ?? null,
			metadata: mergeTraceBundleMetadata(
				existing.metadata,
				traceBundleMetadata(bundle.metadata, bundle.workstation),
			),
		})
		.where(
			and(
				eq(traceBundles.id, bundle.id),
				eq(traceBundles.tediId, bundle.tediId),
				eq(traceBundles.harnessVersionId, bundle.harnessVersionId),
				bundle.orgId
					? eq(traceBundles.orgId, bundle.orgId)
					: isNull(traceBundles.orgId),
			),
		);
	return true;
}

export async function recordHarnessSubjectTraceBundle(
	db: DbClient,
	bundle: HarnessSubjectTraceBundle,
): Promise<void> {
	const existingRows = await db
		.select()
		.from(harnessSubjectTraceBundles)
		.where(eq(harnessSubjectTraceBundles.id, bundle.id))
		.limit(1);
	const existing = existingRows[0];

	if (!existing) {
		await db
			.insert(harnessSubjectTraceBundles)
			.values({
				id: bundle.id,
				subjectKind: bundle.subjectKind,
				subjectId: bundle.subjectId,
				tediId: bundle.tediId ?? null,
				orgId: bundle.orgId ?? null,
				conversationId: bundle.conversationId ?? null,
				runId: bundle.runId,
				harnessVersionId: bundle.harnessVersionId,
				eventIds: bundle.eventIds ?? [],
				rationaleRecordIds: bundle.rationaleRecordIds ?? [],
				artifactIds: bundle.artifactIds ?? [],
				evalResultId: bundle.evalResultId ?? null,
				bundleUri: bundle.bundleUri ?? null,
				summary: bundle.summary ?? null,
				outcome: bundle.outcome ?? null,
				metadata: traceBundleMetadata(bundle.metadata, bundle.workstation),
				createdAt: bundle.createdAt,
			})
			.onConflictDoNothing({ target: harnessSubjectTraceBundles.id });
		return;
	}

	await db
		.update(harnessSubjectTraceBundles)
		.set({
			eventIds: unionTraceBundleIds(existing.eventIds, bundle.eventIds),
			rationaleRecordIds: unionTraceBundleIds(
				existing.rationaleRecordIds,
				bundle.rationaleRecordIds,
			),
			artifactIds: unionTraceBundleIds(
				existing.artifactIds,
				bundle.artifactIds,
			),
			harnessVersionId: existing.harnessVersionId || bundle.harnessVersionId,
			evalResultId: existing.evalResultId ?? bundle.evalResultId ?? null,
			bundleUri: existing.bundleUri ?? bundle.bundleUri ?? null,
			summary: existing.summary ?? bundle.summary ?? null,
			outcome: existing.outcome ?? bundle.outcome ?? null,
			metadata: mergeTraceBundleMetadata(
				existing.metadata,
				traceBundleMetadata(bundle.metadata, bundle.workstation),
			),
		})
		.where(eq(harnessSubjectTraceBundles.id, bundle.id));
}
