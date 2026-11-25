import { and, gte, lt, or, sql } from "drizzle-orm";
import { WorkAttemptSettlementSchema } from "@tedix/api-contract/schemas/work-items";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";

/** Keep this resolver within one read invocation, never across requests. */
export function createCommitResolver(db: DbQueryClient) {
	const forward = new Map<string, string>();
	const backward = new Map<string, string>();
	const loaded = new Set<string>();
	const prefixes = new Map<string, string>();
	async function loadChains(keys: string[]) {
		const missing = [...new Set(keys)].filter((key) => !loaded.has(key));
		if (!missing.length) return;
		// Seek both indexed endpoints through at most four hops in one page read.
		// LEFT JOIN also caches missing aliases and terminal endpoints.
		const matches = await db.all<{
			key: string;
			oldSha: string | null;
			newSha: string | null;
		}>(sql`
			WITH RECURSIVE alias_keys(sha, hop) AS (
				SELECT value, 0 FROM json_each(${JSON.stringify(missing)})
				UNION
				SELECT CASE WHEN a.old_sha = k.sha THEN a.new_sha ELSE a.old_sha END, k.hop + 1
				FROM alias_keys k
				JOIN ${gitCommitAliases} a ON a.old_sha = k.sha OR a.new_sha = k.sha
				WHERE k.hop < 3
			)
			SELECT k.sha AS key, a.old_sha AS oldSha, a.new_sha AS newSha
			FROM alias_keys k
			LEFT JOIN ${gitCommitAliases} a ON a.old_sha = k.sha OR a.new_sha = k.sha
		`);
		for (const row of matches) {
			loaded.add(row.key);
			if (row.oldSha !== null && row.newSha !== null) {
				forward.set(row.oldSha, row.newSha);
				backward.set(row.newSha, row.oldSha);
			}
		}
	}
	function chainFor(key: string) {
		const aliases = [key];
		const seen = new Set(aliases);
		for (const direction of [forward, backward]) {
			let current = key;
			for (let hop = 0; hop < 4; hop++) {
				const next = direction.get(current);
				if (!next) break;
				if (seen.has(next)) throw new Error("Cyclic commit alias chain");
				seen.add(next);
				if (direction === forward) aliases.unshift(next);
				else aliases.push(next);
				current = next;
			}
		}
		return aliases;
	}
	async function aliasesFor(sha: string): Promise<string[]> {
		let key = sha.toLowerCase();
		if (!/^[a-f0-9]{7,40}$/.test(key)) return [sha];
		if (key.length < 40) {
			const cached = prefixes.get(key);
			if (cached) key = cached;
			else {
				const matches = await db
					.select({
						oldSha: gitCommitAliases.oldSha,
						newSha: gitCommitAliases.newSha,
					})
					.from(gitCommitAliases)
					.where(
						or(
							and(
								gte(gitCommitAliases.oldSha, key),
								lt(gitCommitAliases.oldSha, `${key}g`),
							),
							and(
								gte(gitCommitAliases.newSha, key),
								lt(gitCommitAliases.newSha, `${key}g`),
							),
						),
					)
					.limit(3);
				// An intermediate id occurs in two rows, but is still one full id.
				const ids = [
					...new Set(
						matches
							.flatMap((row) => [row.oldSha, row.newSha])
							.filter((id) => id.startsWith(key)),
					),
				];
				if (ids.length > 1) throw new Error("Ambiguous commit alias prefix");
				if (!ids.length) return [key];
				prefixes.set(key, ids[0]!);
				key = ids[0]!;
			}
		}
		await loadChains([key]);
		return chainFor(key);
	}
	async function canonicalCommit(sha: string): Promise<string> {
		return (await aliasesFor(sha))[0]!;
	}
	async function resolveMany(shas: string[]): Promise<string[]> {
		const keys = shas
			.map((sha) => sha.toLowerCase())
			.filter((key) => /^[a-f0-9]{40}$/.test(key));
		await loadChains(keys);
		const result: string[] = [];
		for (const sha of shas) {
			result.push(
				/^[a-f0-9]{40}$/i.test(sha)
					? chainFor(sha.toLowerCase())[0]!
					: await canonicalCommit(sha),
			);
		}
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
