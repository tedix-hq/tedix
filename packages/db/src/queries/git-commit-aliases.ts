import { and, eq, gte, inArray, lt, or } from "drizzle-orm";
import { WorkAttemptSettlementSchema } from "@tedix/api-contract/schemas/work-items";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";

/** Keep this resolver within one read invocation, never across requests. */
export function createCommitResolver(db: DbQueryClient) {
	const cache = new Map<string, Promise<string[]>>();
	function aliasesFor(sha: string): Promise<string[]> {
		const key = sha.toLowerCase();
		if (!/^[a-f0-9]{7,40}$/.test(key)) return Promise.resolve([sha]);
		let result = cache.get(key);
		if (!result) {
			result = (async () => {
				const matches = await db
					.select({
						oldSha: gitCommitAliases.oldSha,
						newSha: gitCommitAliases.newSha,
					})
					.from(gitCommitAliases)
					.where(
						or(
							key.length === 40
								? eq(gitCommitAliases.oldSha, key)
								: and(
										gte(gitCommitAliases.oldSha, key),
										lt(gitCommitAliases.oldSha, `${key}g`),
									),
							key.length === 40
								? eq(gitCommitAliases.newSha, key)
								: and(
										gte(gitCommitAliases.newSha, key),
										lt(gitCommitAliases.newSha, `${key}g`),
									),
						),
					)
					.limit(2);
				if (matches.length > 1)
					throw new Error("Ambiguous commit alias prefix");
				const row = matches[0];
				if (!row) return [key];
				const aliases = [...new Set([row.newSha, row.oldSha])];
				for (const alias of aliases) cache.set(alias, Promise.resolve(aliases));
				return aliases;
			})();
			cache.set(key, result);
		}
		return result;
	}
	async function canonicalCommit(sha: string): Promise<string> {
		return (await aliasesFor(sha))[0]!;
	}
	async function resolveMany(shas: string[]): Promise<string[]> {
		const keys = [...new Set(shas.map((sha) => sha.toLowerCase()))].filter(
			(key) => /^[a-f0-9]{40}$/.test(key) && !cache.has(key),
		);
		// Each id binds twice; keep each statement within D1's 100 parameters.
		for (let offset = 0; offset < keys.length; offset += 50) {
			const chunk = keys.slice(offset, offset + 50);
			const matches = await db
				.select({
					oldSha: gitCommitAliases.oldSha,
					newSha: gitCommitAliases.newSha,
				})
				.from(gitCommitAliases)
				.where(
					or(
						inArray(gitCommitAliases.oldSha, chunk), // bound-params: at most 50 ids, used twice.
						inArray(gitCommitAliases.newSha, chunk), // bound-params: at most 50 ids, used twice.
					),
				);
			for (const key of chunk) {
				const rows = matches.filter(
					(row) => row.oldSha === key || row.newSha === key,
				);
				if (rows.length > 1) throw new Error("Ambiguous commit alias prefix");
				const row = rows[0];
				// No alias also includes commits dropped from history. Without a
				// repository history check we cannot distinguish them from unchanged ids;
				// preserve the id so ancestry, push and live-surface checks still apply.
				cache.set(
					key,
					Promise.resolve(row ? [...new Set([row.newSha, row.oldSha])] : [key]),
				);
			}
		}
		const result: string[] = [];
		// Prefix lookups retain ambiguity checks and never fan out over a page.
		for (const sha of shas) result.push(await canonicalCommit(sha));
		return result;
	}
	return { canonicalCommit, aliasesFor, resolveMany };
}

export function canonicalCommit(db: DbQueryClient, sha: string) {
	return createCommitResolver(db).canonicalCommit(sha);
}

export function aliasesFor(db: DbQueryClient, sha: string) {
	return createCommitResolver(db).aliasesFor(sha);
}

export function settlementCommitShas(
	metadata: Record<string, JsonValue>,
): string[] {
	const settlement = WorkAttemptSettlementSchema.safeParse(
		metadata.settlement,
	).data;
	if (!settlement) return [];
	return [
		...("commitShas" in settlement ? settlement.commitShas : []),
		...("commitSha" in settlement ? [settlement.commitSha] : []),
		...("runCommitSha" in settlement ? [settlement.runCommitSha] : []),
		...("baseCommit" in settlement ? [settlement.baseCommit] : []),
	];
}

/** Project typed settlement fields only; persisted metadata remains untouched. */
export async function canonicalSettlementMetadata(
	resolver: ReturnType<typeof createCommitResolver>,
	metadata: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
	const settlement = WorkAttemptSettlementSchema.safeParse(
		metadata.settlement,
	).data;
	if (!settlement) return metadata;
	const result = { ...settlement };
	if ("commitShas" in result)
		result.commitShas = await resolver.resolveMany(result.commitShas);
	if ("commitSha" in result)
		result.commitSha = await resolver.canonicalCommit(result.commitSha);
	if ("runCommitSha" in result)
		result.runCommitSha = await resolver.canonicalCommit(result.runCommitSha);
	if ("baseCommit" in result)
		result.baseCommit = await resolver.canonicalCommit(result.baseCommit);
	return { ...metadata, settlement: result };
}
