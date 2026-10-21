import * as algoQueries from "./queries/algorithms";
import { createQueryRunner, runQuery, type HttpClient } from "./neo4j-http";

/**
 * A tenant refresh owns only a bounded amount of stale GDS catalog cleanup.
 * Listing one extra row detects overflow while each retry still makes progress.
 */
const MAX_STALE_GDS_PROJECTIONS_PER_REFRESH = 32;

export function createNeo4jMaintenance(http: HttpClient) {
	const run = createQueryRunner(http);
	return {
		/** Controlled maintenance mutation: refresh persisted GDS-derived properties. */
		async refreshStructuralEmbeddings(
			orgId: string,
			options?: {
				epoch?: string;
				sourceWatermark?: number;
				/** Unique to one lease-owning maintenance attempt. */
				attemptKey?: string;
				beforeStep?: () => Promise<void>;
			},
		): Promise<void> {
			const sanitizeGraphComponent = (value: string) =>
				value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96);
			const attemptKey = sanitizeGraphComponent(
				options?.attemptKey ??
					`${options?.epoch ?? "unstamped"}-${options?.sourceWatermark ?? 0}`,
			);
			const graphPrefix = `fact-refresh-${sanitizeGraphComponent(orgId)}-`;
			const graphName = `${graphPrefix}${attemptKey}`;

			// The tenant lease is asserted before catalog inspection and every
			// stale drop. The query is prefix-scoped, and the returned names are
			// checked again before use so an unexpected catalog response cannot
			// turn into cross-tenant mutation.
			await options?.beforeStep?.();
			const staleGraphNames = await run(
				algoQueries.listProjectionsByPrefix(
					graphPrefix,
					graphName,
					MAX_STALE_GDS_PROJECTIONS_PER_REFRESH + 1,
				),
				(records) => records.map((record) => record.graphName),
			);
			for (const staleGraphName of staleGraphNames) {
				if (
					typeof staleGraphName !== "string" ||
					!staleGraphName.startsWith(graphPrefix) ||
					staleGraphName === graphName
				) {
					throw new Error(
						`Neo4j GDS catalog returned an unsafe stale projection for tenant prefix ${graphPrefix}`,
					);
				}
			}
			for (const staleGraphName of staleGraphNames.slice(
				0,
				MAX_STALE_GDS_PROJECTIONS_PER_REFRESH,
			)) {
				await options?.beforeStep?.();
				await run(
					algoQueries.dropProjection(staleGraphName as string),
					() => {},
				);
			}
			if (staleGraphNames.length > MAX_STALE_GDS_PROJECTIONS_PER_REFRESH) {
				throw new Error(
					`Neo4j GDS stale projection cleanup removed ${MAX_STALE_GDS_PROJECTIONS_PER_REFRESH} graphs for tenant prefix ${graphPrefix}; retry required before refresh`,
				);
			}

			const pipeline = algoQueries.getRefreshPipeline(orgId, {
				...options,
				graphName,
			});
			const cleanup = pipeline.at(-1);
			const mutationSteps = pipeline.slice(0, -1);
			let primaryError: unknown;
			try {
				for (const step of mutationSteps) {
					// Lease/assertion failures must never be treated like an
					// ignorable stale-projection cleanup. dropProjection(...,
					// false) already handles the genuinely absent-graph case.
					await options?.beforeStep?.();
					await run({ query: step.query, params: step.params }, () => {});
				}
			} catch (error) {
				primaryError = error;
			}

			let cleanupError: unknown;
			if (cleanup) {
				try {
					await run({ query: cleanup.query, params: cleanup.params }, () => {});
				} catch (error) {
					cleanupError = error;
				}
			}
			if (primaryError !== undefined) {
				if (cleanupError !== undefined) {
					console.warn(
						`[GraphDB] Failed to drop GDS projection ${graphName}:`,
						cleanupError,
					);
				}
				throw primaryError;
			}
			if (cleanupError !== undefined) throw cleanupError;
		},

		async refreshCommunities(_orgId: string): Promise<void> {
			// Community persistence is part of the combined controlled refresh
			// run by refreshStructuralEmbeddings().
		},
		async isHealthy(): Promise<boolean> {
			try {
				await runQuery(http, "RETURN 1 AS ok");
				return true;
			} catch {
				return false;
			}
		},

		async close(): Promise<void> {
			// No persistent connections with HTTP transport — nothing to close
		},
	};
}
