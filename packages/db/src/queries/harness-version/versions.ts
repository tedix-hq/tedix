import type {
	HarnessPromotionStatus,
	HarnessVersion,
} from "@tedix/api-contract/schemas/harness-version";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type HarnessVersionRow,
	harnessVersions,
} from "../../schema/harness-versions";
import { optionalJsonObject } from "./persistence-json";

export function serializeHarnessComponents(
	components: Record<string, string>,
): string {
	const keys = Object.keys(components).sort();
	return JSON.stringify(keys.map((key) => [key, components[key]]));
}

export function harnessComponentsEqual(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	return serializeHarnessComponents(a) === serializeHarnessComponents(b);
}

export function nextHarnessVersionString(
	current: string | null | undefined,
): string {
	if (!current) return "1";
	const n = Number.parseInt(current, 10);
	return Number.isFinite(n) ? String(n + 1) : "1";
}

export async function demoteActiveHarnessVersions(
	db: DbClient,
	tediId: string,
): Promise<void> {
	await db
		.update(harnessVersions)
		.set({ promotionStatus: "promoted" })
		.where(
			and(
				eq(harnessVersions.tediId, tediId),
				eq(harnessVersions.promotionStatus, "active"),
			),
		);
}

// ============================================================================
// Read
// ============================================================================

/**
 * The currently-active harness version for a tedi (`promotion_status = active`).
 * Most recent by `created_at` wins if more than one is somehow active.
 */
export async function getActiveHarnessVersion(
	db: DbClient,
	tediId: string,
): Promise<HarnessVersionRow | null> {
	const rows = await db
		.select()
		.from(harnessVersions)
		.where(
			and(
				eq(harnessVersions.tediId, tediId),
				eq(harnessVersions.promotionStatus, "active"),
			),
		)
		.orderBy(desc(harnessVersions.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

export async function getHarnessVersionById(
	db: DbClient,
	harnessVersionId: string,
): Promise<HarnessVersionRow | null> {
	const row = (
		await db
			.select()
			.from(harnessVersions)
			.where(eq(harnessVersions.id, harnessVersionId))
			.limit(1)
	)[0];
	return row ?? null;
}

export interface ListHarnessVersionsOptions {
	tediId: string;
	promotionStatus?: HarnessPromotionStatus;
	runtimeKind?: string;
	limit?: number;
}

/** Harness versions for one tedi, newest first, optionally filtered. */
export async function listHarnessVersions(
	db: DbClient,
	options: ListHarnessVersionsOptions,
): Promise<HarnessVersionRow[]> {
	const conditions = [eq(harnessVersions.tediId, options.tediId)];
	if (options.promotionStatus) {
		conditions.push(
			eq(harnessVersions.promotionStatus, options.promotionStatus),
		);
	}
	if (options.runtimeKind) {
		conditions.push(eq(harnessVersions.runtimeKind, options.runtimeKind));
	}
	const rows = await db
		.select()
		.from(harnessVersions)
		.where(and(...conditions))
		.orderBy(desc(harnessVersions.createdAt))
		.limit(options.limit ?? 50);
	return rows;
}

// ============================================================================
// Write (idempotent — conflict-do-nothing on PK)
// ============================================================================

/**
 * Insert a harness version. Conflict-do-nothing on `id` so re-emission (e.g. a
 * retried version-ensure) does not throw or duplicate. Callers pass a stable
 * `id` (content-derived or `hv_{tediId}_{version}`) to make this safe.
 */
export async function recordHarnessVersion(
	db: DbClient,
	version: HarnessVersion,
): Promise<void> {
	await db
		.insert(harnessVersions)
		.values({
			id: version.id,
			tediId: version.tediId,
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
				optionalJsonObject(version.metadata, "harness_versions.metadata") ??
				null,
			createdAt: version.createdAt,
		})
		.onConflictDoNothing({ target: harnessVersions.id });
}
