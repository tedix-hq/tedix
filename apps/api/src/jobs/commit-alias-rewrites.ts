import type { CommitAliasRewriteInput } from "@tedix/api-contract/schemas/commit-alias-counts";
import type { DbClient } from "@tedix/db/client";
import {
	readCommitAliasReplacements,
	rewriteCommitAliasBatch,
	type CommitAliasRewriteRecord,
	type RewriteLocation,
} from "@tedix/db/queries/commit-alias-rewrites";
import { withD1Ledger } from "@tedix/db/slow-query";
import { countCommitAliasPage } from "./commit-alias-counts";
import {
	isCommitAliasUnlocked,
	mutableCommitFields,
} from "./commit-alias-fields";

/** Counts and traverses exactly the inventory's pages. A refusal returns no cursor. */
export async function rewriteCommitAliasPage(
	db: DbClient,
	input: CommitAliasRewriteInput,
	actor: { actorId: string; actorType: string },
) {
	return withD1Ledger(
		"commit-alias-rewrite",
		async () => {
			const totals = { wouldChange: 0, changed: 0, dropped: 0 };
			const paced = async <T>(run: () => PromiseLike<T>) => {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				return await run();
			};
			const result = await countCommitAliasPage(
				db,
				input,
				async (cursor, rows) => {
					if (!isCommitAliasUnlocked(cursor.location, cursor.store, "running"))
						return;
					const records = rows
						.filter(
							(row) =>
								row.eligible &&
								row.value !== null &&
								isCommitAliasUnlocked(cursor.location, cursor.store, row.state),
						)
						.map((row) => ({ row, value: JSON.parse(row.value!) as unknown }));
					const candidates = [
						...new Set(
							records.flatMap(({ value }) =>
								mutableCommitFields(cursor.location, value)
									.map((slot) => slot.value)
									.filter(
										(v): v is string =>
											typeof v === "string" && /^[a-f0-9]{40}$/i.test(v),
									)
									.map((v) => v.toLowerCase()),
							),
						),
					];
					const aliases = new Map<string, string>();
					for (let i = 0; i < candidates.length; i += 200) {
						for (const alias of await paced(() =>
							readCommitAliasReplacements(
								db,
								input.repository,
								candidates.slice(i, i + 200),
							),
						))
							aliases.set(alias.oldSha, alias.newSha);
					}
					const writes: CommitAliasRewriteRecord[] = [];
					for (const { row, value } of records) {
						const changes = new Map<string, string>();
						let dropped = false;
						for (const slot of mutableCommitFields(cursor.location, value)) {
							if (typeof slot.value !== "string") continue;
							const to = aliases.get(slot.value.toLowerCase());
							if (!to) continue;
							if (/^0{40}$/.test(to)) {
								dropped = true;
								continue;
							}
							if (slot.value === to) continue;
							changes.set(slot.value, to);
							Reflect.set(slot.parent, slot.key, to);
						}
						if (dropped) totals.dropped++;
						if (changes.size)
							writes.push({
								id: row.id,
								before: row.value!,
								after: JSON.stringify(value),
								changes: [...changes].map(([from, to]) => ({ from, to })),
							});
					}
					totals.wouldChange = writes.length;
					if (!input.dryRun)
						for (let i = 0; i < writes.length; i += 4) {
							totals.changed += await paced(() =>
								rewriteCommitAliasBatch(db, {
									location: cursor.location as RewriteLocation,
									repository: input.repository,
									runId: cursor.runId,
									actor,
									records: writes.slice(i, i + 4),
								}),
							);
						}
				},
			);
			const output = {
				...result,
				...totals,
				dryRun: input.dryRun,
				cursor: result.cursor
					? { ...result.cursor, dryRun: input.dryRun }
					: null,
			};
			console.log(
				JSON.stringify({ event: "commit_alias_rewrite.page", ...output }),
			);
			return output;
		},
		{ maxInFlight: 4, alwaysLog: true },
	);
}
