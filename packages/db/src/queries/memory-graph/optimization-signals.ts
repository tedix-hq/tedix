import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type NewTediOptimizationSignal,
	type OptimizationSignalStatus,
	type TediOptimizationSignal,
	tediOptimizationSignals,
} from "../../schema/memory-graph";

export type { OptimizationSignalStatus };

export async function findOpenOptimizationSignal(
	db: DbClient,
	params: {
		organizationId: string;
		tediId: string;
		type: TediOptimizationSignal["type"];
		domain: string;
		evidenceIncludes?: string[];
	},
): Promise<TediOptimizationSignal | undefined> {
	const candidates = await db
		.select()
		.from(tediOptimizationSignals)
		.where(
			and(
				eq(tediOptimizationSignals.organizationId, params.organizationId),
				eq(tediOptimizationSignals.tediId, params.tediId),
				eq(tediOptimizationSignals.type, params.type),
				eq(tediOptimizationSignals.domain, params.domain),
				sql`${tediOptimizationSignals.status} NOT IN ('completed', 'dismissed')`,
			),
		)
		.orderBy(desc(tediOptimizationSignals.createdAt))
		.limit(25);

	if (!params.evidenceIncludes?.length) {
		return candidates[0];
	}

	return candidates.find((candidate) =>
		params.evidenceIncludes?.every((needle) =>
			candidate.evidence.includes(needle),
		),
	);
}

export async function createOptimizationSignal(
	db: DbClient,
	signal: NewTediOptimizationSignal,
): Promise<TediOptimizationSignal> {
	const id = signal.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(tediOptimizationSignals)
		.values({ ...signal, id })
		.returning();
	if (!created) throw new Error(`Failed to create optimization signal: ${id}`);
	return created;
}

export async function listOptimizationSignals(
	db: DbClient,
	orgId: string,
	options?: {
		tediId?: string;
		status?: OptimizationSignalStatus;
		limit?: number;
	},
): Promise<TediOptimizationSignal[]> {
	const conditions = [eq(tediOptimizationSignals.organizationId, orgId)];

	if (options?.tediId) {
		conditions.push(eq(tediOptimizationSignals.tediId, options.tediId));
	}
	if (options?.status) {
		conditions.push(eq(tediOptimizationSignals.status, options.status));
	}

	return db
		.select()
		.from(tediOptimizationSignals)
		.where(and(...conditions))
		.orderBy(
			desc(tediOptimizationSignals.roi),
			desc(tediOptimizationSignals.createdAt),
		)
		.limit(options?.limit ?? 50);
}

export async function updateSignalStatus(
	db: DbClient,
	id: string,
	status: OptimizationSignalStatus,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(tediOptimizationSignals)
		.set({
			status,
			...(status === "completed" || status === "dismissed"
				? { resolvedAt: now }
				: {}),
			updatedAt: now,
		})
		.where(eq(tediOptimizationSignals.id, id));
}

/**
 * Get compiled pattern directives for a tedi — Atlas-style compiled memory.
 * Returns suggestedAction from open/acknowledged compiled_pattern signals.
 */
export async function getCompiledPatterns(
	db: DbClient,
	tediId: string,
): Promise<string[]> {
	const signals = await db
		.select({ suggestedAction: tediOptimizationSignals.suggestedAction })
		.from(tediOptimizationSignals)
		.where(
			and(
				eq(tediOptimizationSignals.tediId, tediId),
				eq(tediOptimizationSignals.type, "compiled_pattern"),
				sql`${tediOptimizationSignals.status} NOT IN ('completed', 'dismissed')`,
			),
		)
		.orderBy(
			desc(tediOptimizationSignals.roi),
			desc(tediOptimizationSignals.createdAt),
		)
		.limit(10);
	const actions = signals
		.map((s) => s.suggestedAction)
		.filter((a): a is string => typeof a === "string" && a.length > 0);
	return [...new Set(actions)];
}

export async function getOptimizationBacklog(
	db: DbClient,
	orgId: string,
	options?: { tediId?: string; limit?: number },
): Promise<TediOptimizationSignal[]> {
	const conditions = [
		eq(tediOptimizationSignals.organizationId, orgId),
		sql`${tediOptimizationSignals.status} NOT IN ('completed', 'dismissed')`,
	];

	if (options?.tediId) {
		conditions.push(eq(tediOptimizationSignals.tediId, options.tediId));
	}

	return db
		.select()
		.from(tediOptimizationSignals)
		.where(and(...conditions))
		.orderBy(
			desc(tediOptimizationSignals.roi),
			desc(tediOptimizationSignals.createdAt),
		)
		.limit(options?.limit ?? 50);
}
