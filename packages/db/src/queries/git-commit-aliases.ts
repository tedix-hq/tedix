import { and, eq, gte, lt, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
		// Four joins bound traversal, including cycles, without a recursive SQL statement.
		const requested = db
			.$with("alias_keys")
			.as(
				db
					.select({ key: sql<string>`value`.as("alias_key") })
					.from(sql`json_each(${JSON.stringify(missing)})`),
			);
		const first = alias(gitCommitAliases, "alias_first");
		const second = alias(gitCommitAliases, "alias_second");
		const third = alias(gitCommitAliases, "alias_third");
		const fourth = alias(gitCommitAliases, "alias_fourth");
		const neighbor = (
			oldSha: SQLWrapper,
			newSha: SQLWrapper,
			key: SQLWrapper,
		) =>
			sql<
				string | null
			>`case when ${oldSha} = ${key} then ${newSha} else ${oldSha} end`;
		const nextFirst = neighbor(first.oldSha, first.newSha, requested.key);
		const nextSecond = neighbor(second.oldSha, second.newSha, nextFirst);
		const nextThird = neighbor(third.oldSha, third.newSha, nextSecond);
		const matches = await db
			.with(requested)
			.select({
				key: requested.key,
				nextFirst: nextFirst.as("next_first"),
				nextSecond: nextSecond.as("next_second"),
				nextThird: nextThird.as("next_third"),
				oldFirst: sql<string | null>`${first.oldSha}`.as("old_first"),
				newFirst: sql<string | null>`${first.newSha}`.as("new_first"),
				oldSecond: sql<string | null>`${second.oldSha}`.as("old_second"),
				newSecond: sql<string | null>`${second.newSha}`.as("new_second"),
				oldThird: sql<string | null>`${third.oldSha}`.as("old_third"),
				newThird: sql<string | null>`${third.newSha}`.as("new_third"),
				oldFourth: sql<string | null>`${fourth.oldSha}`.as("old_fourth"),
				newFourth: sql<string | null>`${fourth.newSha}`.as("new_fourth"),
			})
			.from(requested)
			.leftJoin(
				first,
				or(eq(first.oldSha, requested.key), eq(first.newSha, requested.key)),
			)
			.leftJoin(
				second,
				or(eq(second.oldSha, nextFirst), eq(second.newSha, nextFirst)),
			)
			.leftJoin(
				third,
				or(eq(third.oldSha, nextSecond), eq(third.newSha, nextSecond)),
			)
			.leftJoin(
				fourth,
				or(eq(fourth.oldSha, nextThird), eq(fourth.newSha, nextThird)),
			);
		for (const row of matches) {
			loaded.add(row.key);
			for (const key of [row.nextFirst, row.nextSecond, row.nextThird])
				if (key !== null) loaded.add(key);
			for (const [oldSha, newSha] of [
				[row.oldFirst, row.newFirst],
				[row.oldSecond, row.newSecond],
				[row.oldThird, row.newThird],
				[row.oldFourth, row.newFourth],
			] as const) {
				if (oldSha !== null && newSha !== null) {
					forward.set(oldSha, newSha);
					backward.set(newSha, oldSha);
				}
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
