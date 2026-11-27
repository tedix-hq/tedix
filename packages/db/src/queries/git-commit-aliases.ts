import { and, eq, gte, lt, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../core-store/client";
import { coreStore } from "../core-store/dialect";
import { WorkAttemptSettlementSchema } from "@tedix/api-contract/schemas/work-items";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";

/** Keep this resolver within one read invocation, never across requests. */
export function createCommitResolver(db: DbQueryClient) {
	const table = coreTable(db, gitCommitAliases);
	const alias =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)
			: sqliteAlias;
	const forward = new Map<string, string>();
	const backward = new Map<string, string>();
	const loaded = new Set<string>();
	const prefixes = new Map<string, string>();
	function requestedKeys(keys: string[]) {
		return db
			.$with("alias_keys")
			.as(
				db
					.select({ key: sql<string>`value`.as("alias_key") })
					.from(
						coreStore(db) === "postgres"
							? sql`jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb) AS candidate(value)`
							: sql`json_each(${JSON.stringify(keys)})`,
					),
			);
	}
	async function loadPrefixes(keys: string[]) {
		const missing = [...new Set(keys)].filter((key) => !prefixes.has(key));
		if (!missing.length) return;
		const requested = requestedKeys(missing);
		const matches = await db
			.with(requested)
			.select({
				key: requested.key,
				oldSha: table.oldSha,
				newSha: table.newSha,
			})
			.from(requested)
			.innerJoin(
				table,
				or(
					and(
						gte(table.oldSha, requested.key),
						lt(table.oldSha, sql`${requested.key} || 'g'`),
					),
					and(
						gte(table.newSha, requested.key),
						lt(table.newSha, sql`${requested.key} || 'g'`),
					),
				),
			);
		const ids = new Map(missing.map((key) => [key, new Set<string>()]));
		for (const row of matches)
			for (const id of [row.oldSha, row.newSha])
				if (id.startsWith(row.key)) ids.get(row.key)!.add(id);
		for (const [key, candidates] of ids) {
			if (candidates.size > 1) throw new Error("Ambiguous commit alias prefix");
			prefixes.set(key, candidates.values().next().value ?? key);
		}
	}
	async function loadChains(keys: string[]) {
		const missing = [...new Set(keys)].filter((key) => !loaded.has(key));
		if (!missing.length) return;
		// Four joins bound traversal, including cycles, without a recursive SQL statement.
		const requested = requestedKeys(missing);
		const first = alias(table, "alias_first");
		const second = alias(table, "alias_second");
		const third = alias(table, "alias_third");
		const fourth = alias(table, "alias_fourth");
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
		await resolveMany([sha]);
		const key = sha.toLowerCase();
		if (!/^[a-f0-9]{7,40}$/.test(key)) return [sha];
		return chainFor(prefixes.get(key) ?? key);
	}
	async function canonicalCommit(sha: string): Promise<string> {
		return (await resolveMany([sha]))[0]!;
	}
	async function resolveMany(shas: string[]): Promise<string[]> {
		const keys = shas.map((sha) => sha.toLowerCase());
		await loadPrefixes(keys.filter((key) => /^[a-f0-9]{7,39}$/.test(key)));
		await loadChains(
			keys
				.filter((key) => /^[a-f0-9]{7,40}$/.test(key))
				.map((key) => prefixes.get(key) ?? key),
		);
		return shas.map((sha, index) => {
			const key = keys[index]!;
			return /^[a-f0-9]{7,40}$/.test(key)
				? chainFor(prefixes.get(key) ?? key)[0]!
				: sha;
		});
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
