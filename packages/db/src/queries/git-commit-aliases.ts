import { and, eq, gte, lt, or } from "drizzle-orm";
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
	return { canonicalCommit, aliasesFor };
}

export function canonicalCommit(db: DbQueryClient, sha: string) {
	return createCommitResolver(db).canonicalCommit(sha);
}

export function aliasesFor(db: DbQueryClient, sha: string) {
	return createCommitResolver(db).aliasesFor(sha);
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
		result.commitShas = await Promise.all(
			result.commitShas.map(resolver.canonicalCommit),
		);
	if ("commitSha" in result)
		result.commitSha = await resolver.canonicalCommit(result.commitSha);
	if ("runCommitSha" in result)
		result.runCommitSha = await resolver.canonicalCommit(result.runCommitSha);
	if ("baseCommit" in result)
		result.baseCommit = await resolver.canonicalCommit(result.baseCommit);
	return { ...metadata, settlement: result };
}
