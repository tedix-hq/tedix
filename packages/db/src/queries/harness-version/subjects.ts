import type {
	HarnessSubjectKind,
	HarnessSubjectVersion,
} from "@tedix/api-contract/schemas/harness-version";
import { and, desc, eq, gte } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type HarnessSubjectVersionRow,
	harnessSubjectEvalResults,
	harnessSubjectVersions,
} from "../../schema/harness-versions";
import { effectiveKernelEvalRows } from "./effective-kernel-evals";
import { optionalJsonObject, safeJsonObject } from "./persistence-json";
import { harnessComponentsEqual, nextHarnessVersionString } from "./versions";

export interface HarnessSubjectRef {
	subjectKind: HarnessSubjectKind;
	subjectId: string;
}

export function kernelHarnessSubjectId(orgId: string): string {
	return `kernel:${orgId}`;
}

/**
 * Subject id for the kernel's per-TEDI delegation-outcome eval lane. Reuses the
 * fixed `subjectKind="kernel"` (the enum is closed — `["tedi","kernel"]`) and
 * disambiguates by an org-scoped subjectId PREFIX, exactly like
 * `kernelHarnessSubjectId`. Rows under this subject grade "was THIS tedi the
 * right pick for the delegation?" — distinct from the route-KIND lane keyed by
 * `kernelHarnessSubjectId`.
 */
export function tediSelectionSubjectId(orgId: string): string {
	return `tedi-selection:${orgId}`;
}

export interface TediSelectionPrior {
	passed: number;
	total: number;
	successRate: number;
}

export interface SummarizeTediSelectionPriorsOptions {
	orgId: string;
	/** Cap on rows read (newest-first). Bounded to keep the hot-path read cheap. */
	lookbackResults?: number;
}

/** Hard cap on the tedi-selection prior read, regardless of caller input. */
const TEDI_SELECTION_PRIOR_READ_CAP = 400;

export interface TediSelectionCapabilityEvidenceRow {
	tediId: string | null;
	passed: boolean;
	metadata: Record<string, unknown> | null;
}

/**
 * Bounded, org-scoped evidence read used by the capability-distillation loop.
 * Keeping the org predicate here prevents a subject-id convention from being
 * the only tenant boundary on this durable evaluation table.
 */
export async function listTediSelectionCapabilityEvidence(
	db: DbClient,
	input: {
		organizationId: string;
		createdSince: string;
		limit: number;
	},
): Promise<TediSelectionCapabilityEvidenceRow[]> {
	const limit = Math.min(input.limit, TEDI_SELECTION_PRIOR_READ_CAP);
	const rows = await db
		.select({
			id: harnessSubjectEvalResults.id,
			tediId: harnessSubjectEvalResults.tediId,
			passed: harnessSubjectEvalResults.passed,
			metadata: harnessSubjectEvalResults.metadata,
		})
		.from(harnessSubjectEvalResults)
		.where(
			and(
				eq(harnessSubjectEvalResults.orgId, input.organizationId),
				eq(harnessSubjectEvalResults.subjectKind, "kernel"),
				eq(
					harnessSubjectEvalResults.subjectId,
					tediSelectionSubjectId(input.organizationId),
				),
				gte(harnessSubjectEvalResults.createdAt, input.createdSince),
			),
		)
		.orderBy(
			desc(harnessSubjectEvalResults.createdAt),
			desc(harnessSubjectEvalResults.id),
		)
		.limit(limit * 2);
	return effectiveKernelEvalRows(rows, limit);
}

/**
 * Aggregate recent kernel tedi-selection eval results into a per-tedi success
 * prior. Reads up to `lookbackResults` (default + ceiling 400) rows under
 * `subjectKind="kernel"` AND `subjectId=tediSelectionSubjectId(orgId)`,
 * newest-first, groups by `metadata.delegatedTediId` (the tedi that was picked),
 * and returns counts + a derived `successRate` per tedi.
 *
 * PURE AGGREGATION — one bounded indexed read, no writes. FAIL-SOFT: any read or
 * shape error degrades to an empty Map so the caller (the kernel hot path) keeps
 * rendering the roster exactly as today.
 */
export async function summarizeTediSelectionPriors(
	db: DbClient,
	options: SummarizeTediSelectionPriorsOptions,
): Promise<Map<string, TediSelectionPrior>> {
	const out = new Map<string, TediSelectionPrior>();
	try {
		const limit = Math.min(
			options.lookbackResults ?? TEDI_SELECTION_PRIOR_READ_CAP,
			TEDI_SELECTION_PRIOR_READ_CAP,
		);
		const rows = await db
			.select({
				id: harnessSubjectEvalResults.id,
				passed: harnessSubjectEvalResults.passed,
				metadata: harnessSubjectEvalResults.metadata,
				tediId: harnessSubjectEvalResults.tediId,
			})
			.from(harnessSubjectEvalResults)
			.where(
				and(
					eq(harnessSubjectEvalResults.subjectKind, "kernel"),
					eq(
						harnessSubjectEvalResults.subjectId,
						tediSelectionSubjectId(options.orgId),
					),
					eq(harnessSubjectEvalResults.orgId, options.orgId),
				),
			)
			.orderBy(
				desc(harnessSubjectEvalResults.createdAt),
				desc(harnessSubjectEvalResults.id),
			)
			.limit(limit * 2);

		for (const row of effectiveKernelEvalRows(rows, limit)) {
			const metadata = safeJsonObject(row.metadata);
			const fromMeta =
				typeof metadata?.delegatedTediId === "string"
					? metadata.delegatedTediId
					: null;
			const delegatedTediId = fromMeta ?? row.tediId ?? null;
			if (!delegatedTediId) continue;
			const prior = out.get(delegatedTediId) ?? {
				passed: 0,
				total: 0,
				successRate: 0,
			};
			prior.total += 1;
			if (row.passed) prior.passed += 1;
			prior.successRate = prior.total > 0 ? prior.passed / prior.total : 0;
			out.set(delegatedTediId, prior);
		}
	} catch (error) {
		console.warn(
			"[harness] summarizeTediSelectionPriors read failed",
			error instanceof Error ? error.message : String(error),
		);
		return new Map();
	}
	return out;
}

/**
 * The active harness version for one explicit harness subject. This is the
 * non-tedi path used by the Home Kernel; tedi body callers continue to use
 * `getActiveHarnessVersion` until the fleet migrates onto subject-keyed rows.
 */
export async function getActiveHarnessSubjectVersion(
	db: DbClient,
	subject: HarnessSubjectRef,
): Promise<HarnessSubjectVersionRow | null> {
	const rows = await db
		.select()
		.from(harnessSubjectVersions)
		.where(
			and(
				eq(harnessSubjectVersions.subjectKind, subject.subjectKind),
				eq(harnessSubjectVersions.subjectId, subject.subjectId),
				eq(harnessSubjectVersions.promotionStatus, "active"),
			),
		)
		.orderBy(desc(harnessSubjectVersions.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

/** Fetch one harness version by id (used for promotion + access control). */
export async function recordHarnessSubjectVersion(
	db: DbClient,
	version: HarnessSubjectVersion | HarnessSubjectVersionRow,
): Promise<void> {
	await db
		.insert(harnessSubjectVersions)
		.values({
			id: version.id,
			subjectKind: version.subjectKind,
			subjectId: version.subjectId,
			tediId: version.tediId ?? null,
			orgId: version.orgId ?? null,
			version: version.version,
			runtimeKind: version.runtimeKind ?? null,
			components: version.components ?? {},
			parentVersionId: version.parentVersionId ?? null,
			reason: version.reason ?? null,
			artifactCommitSha: version.artifactCommitSha ?? null,
			traceSafetyPolicyId: version.traceSafetyPolicyId ?? null,
			promotionStatus: version.promotionStatus ?? "proposed",
			metadata:
				optionalJsonObject(
					version.metadata,
					"harness_subject_versions.metadata",
				) ?? null,
			createdAt: version.createdAt,
		})
		.onConflictDoNothing({ target: harnessSubjectVersions.id });
}

export interface EnsureActiveHarnessSubjectVersionInput extends HarnessSubjectRef {
	orgId?: string;
	tediId?: string | null;
	runtimeKind?: string;
	components: Record<string, string>;
	reason?: string;
	metadata?: Record<string, unknown>;
	createdAt?: string;
}

export async function ensureActiveHarnessSubjectVersion(
	db: DbClient,
	input: EnsureActiveHarnessSubjectVersionInput,
): Promise<{ version: HarnessSubjectVersionRow; bumped: boolean }> {
	const active = await getActiveHarnessSubjectVersion(db, input);
	if (active && harnessComponentsEqual(active.components, input.components)) {
		return { version: active, bumped: false };
	}

	const version: HarnessSubjectVersionRow = {
		id: crypto.randomUUID(),
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		tediId: input.tediId ?? null,
		orgId: input.orgId ?? null,
		version: nextHarnessVersionString(active?.version),
		runtimeKind: input.runtimeKind ?? null,
		components: input.components,
		parentVersionId: active?.id ?? null,
		reason:
			input.reason ??
			(active ? "harness components changed" : "initial baseline harness"),
		promotionStatus: "active",
		artifactCommitSha: null,
		traceSafetyPolicyId: null,
		createdAt: input.createdAt ?? new Date().toISOString(),
		metadata:
			optionalJsonObject(input.metadata, "harness_subject_versions.metadata") ??
			null,
	};

	if (active) {
		await db
			.update(harnessSubjectVersions)
			.set({ promotionStatus: "promoted" })
			.where(
				and(
					eq(harnessSubjectVersions.subjectKind, input.subjectKind),
					eq(harnessSubjectVersions.subjectId, input.subjectId),
					eq(harnessSubjectVersions.promotionStatus, "active"),
				),
			);
	}

	await recordHarnessSubjectVersion(db, version);
	return { version, bumped: true };
}

export async function ensureActiveKernelHarnessVersion(
	db: DbClient,
	input: {
		orgId: string;
		components: Record<string, string>;
		reason?: string;
		metadata?: Record<string, unknown>;
		createdAt?: string;
	},
): Promise<{ version: HarnessSubjectVersionRow; bumped: boolean }> {
	return ensureActiveHarnessSubjectVersion(db, {
		subjectKind: "kernel",
		subjectId: kernelHarnessSubjectId(input.orgId),
		orgId: input.orgId,
		runtimeKind: "kernel",
		components: input.components,
		reason: input.reason,
		metadata: input.metadata,
		createdAt: input.createdAt,
	});
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
