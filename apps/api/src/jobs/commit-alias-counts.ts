import {
	CommitAliasCountLocationSchema,
	type CommitAliasCountInput,
	type CommitAliasCountCursor,
} from "@tedix/api-contract/schemas/commit-alias-counts";
import { getLogStores, type DbClient } from "@tedix/db/client";
import {
	hasCommitAliases,
	readCommitAliasCountPage,
	findStoredOldCommits,
} from "@tedix/db/queries/commit-alias-counts";
import { withD1Ledger } from "@tedix/db/slow-query";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as ObjectValue)
		: {};
const array = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : [];

function commits(
	location: CommitAliasCountCursor["location"],
	value: unknown,
): string[] {
	const m = object(value);
	const s = object(m.settlement);
	let values: unknown[];
	switch (location) {
		case "work_attempts.metadata":
			values = [
				s.commitSha,
				s.runCommitSha,
				s.baseCommit,
				...array(s.commitShas),
				...array(m.commitShas),
				...array(m.commits).map((c) => object(c).sha),
				m.commitSha,
				m.sourceCommit,
				object(object(m.repositoryLifecycle).merge).commitSha,
				object(m.cliRelease).commitSha,
				object(m.laneResult).commitSha,
				...array(m.recoveredCommits).map((c) => object(c).commitSha),
			];
			break;
		case "work_items.metadata": {
			const event = object(m.event);
			values = [event.sha, event.beforeSha, ...array(event.commitShas)];
			break;
		}
		case "kernel_requests.snapshot":
			values = [
				...array(m.checks).flatMap((c) => [
					object(c).commitSha,
					object(c).baseSha,
				]),
				...array(m.observations).map((c) => object(c).observedVersion),
			];
			break;
		case "external_agent_attributions.target_id":
			values = [m.targetId];
			break;
		case "external_agent_review_evidence":
			values = [
				m.targetId,
				typeof m.repositoryVersion === "string"
					? m.repositoryVersion.replace(/^sha:/, "")
					: m.repositoryVersion,
			];
			break;
		case "learning_interaction_events.metadata":
			values = array(m.commitShas);
			break;
		case "work_interactions.metadata":
			values = [
				object(object(m.decisionDeck).effect).commitSha,
				...array(object(m.decisionDeck).options).map(
					(option) => object(object(option).effect).commitSha,
				),
			];
			break;
		case "work_interaction_card_revisions.proposal": {
			const leaves = (node: unknown): unknown[] =>
				Array.isArray(node)
					? node.flatMap(leaves)
					: node && typeof node === "object"
						? Object.values(node).flatMap(leaves)
						: [node];
			values = leaves(m);
			break;
		}
		case "work_item_comments.metadata":
			values = [m.commitSha, m.sourceCommit, m.liveCommitSha];
			break;
	}
	const pattern =
		location === "learning_interaction_events.metadata"
			? /^[a-f0-9]{7,40}$/i
			: /^[a-f0-9]{40}$/i;
	return [
		...new Set(
			values
				.filter((v): v is string => typeof v === "string" && pattern.test(v))
				.map((v) => v.toLowerCase()),
		),
	];
}

/** One read-only page per call. The caller retains the cursor and page evidence. */
export async function countCommitAliasPage(
	db: DbClient,
	input: CommitAliasCountInput,
) {
	return withD1Ledger(
		"commit-alias-count",
		async () => {
			// Pace reads (each includes EXPLAIN), including the first page on resume.
			const paced = async <T>(read: () => PromiseLike<T>) => {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				return await read();
			};
			const cursor: CommitAliasCountCursor = input.cursor ?? {
				runId: crypto.randomUUID(),
				repository: input.repository,
				location: "work_attempts.metadata",
				store: "main",
				after: "",
				scanned: 0,
				locked: 0,
				unlocked: 0,
			};
			const stores = [
				{ binding: "main", db },
				...(getLogStores(db)?.partitions ?? []),
			];
			const store = stores.find((s) => s.binding === cursor.store);
			if (!store) throw new Error("Count cursor store is unavailable");
			if (
				cursor.store !== "main" &&
				cursor.location !== "external_agent_attributions.target_id"
			)
				throw new Error("Invalid logs count cursor");
			const result = {
				location: cursor.location,
				store: cursor.store,
				locationComplete: false,
				scanned: cursor.scanned,
				locked: cursor.locked,
				unlocked: cursor.unlocked,
				inFlightAttemptIds: [] as string[],
				openObserverWorkItemIds: [] as string[],
			};
			if (!(await paced(() => hasCommitAliases(db, input.repository))).length) {
				console.log(
					JSON.stringify({
						event: "commit_alias_count.no_aliases",
						runId: cursor.runId,
						aliases: 0,
					}),
				);
				return { ...result, status: "no_aliases" as const, cursor: null };
			}
			const rows = await paced(() =>
				readCommitAliasCountPage(store.db, cursor.location, cursor.after),
			);
			const candidates = rows.map((row) =>
				row.eligible
					? commits(
							cursor.location,
							row.value === null ? {} : JSON.parse(row.value),
						)
					: [],
			);
			const unique = [...new Set(candidates.flat())];
			const matched = new Set<string>();
			for (let i = 0; i < unique.length; i += 200) {
				for (const row of await paced(() =>
					findStoredOldCommits(
						db,
						input.repository,
						unique.slice(i, i + 200),
						cursor.location === "learning_interaction_events.metadata",
					),
				))
					matched.add(row.sha);
			}
			rows.forEach((row, index) => {
				if (!candidates[index]!.some((sha) => matched.has(sha))) return;
				const active = ["queued", "running", "waiting", "retrying"].includes(
					row.state ?? "",
				);
				// Decision effects are immutable too: the interaction trigger only permits named metadata changes.
				const locked =
					cursor.store !== "main" ||
					![
						"work_attempts.metadata",
						"work_items.metadata",
						"kernel_requests.snapshot",
					].includes(cursor.location) ||
					(cursor.location === "work_attempts.metadata" && !active);
				result[locked ? "locked" : "unlocked"]++;
				if (cursor.location === "work_attempts.metadata" && active)
					result.inFlightAttemptIds.push(row.id);
				if (
					cursor.location === "work_items.metadata" &&
					!["completed", "cancelled"].includes(row.state ?? "")
				)
					result.openObserverWorkItemIds.push(row.id);
			});
			result.scanned += rows.length;
			result.locationComplete = rows.length < 200;
			let next: CommitAliasCountCursor | null = {
				...cursor,
				after: rows.at(-1)?.id ?? cursor.after,
				scanned: result.scanned,
				locked: result.locked,
				unlocked: result.unlocked,
			};
			if (result.locationComplete) {
				const locations = CommitAliasCountLocationSchema.options;
				const nextLocation = locations[locations.indexOf(cursor.location) + 1];
				const nextStore =
					cursor.location === "external_agent_attributions.target_id"
						? stores[stores.indexOf(store) + 1]
						: undefined;
				next = nextStore
					? {
							...cursor,
							store: nextStore.binding,
							after: "",
							scanned: 0,
							locked: 0,
							unlocked: 0,
						}
					: nextLocation
						? {
								...cursor,
								location: nextLocation,
								store: "main",
								after: "",
								scanned: 0,
								locked: 0,
								unlocked: 0,
							}
						: null;
			}
			console.log(
				JSON.stringify({
					event: result.locationComplete
						? "commit_alias_count.location"
						: "commit_alias_count.page",
					runId: cursor.runId,
					after: cursor.after,
					...result,
				}),
			);
			return {
				...result,
				status: next ? ("continue" as const) : ("complete" as const),
				cursor: next,
			};
		},
		{ maxInFlight: 4, alwaysLog: true },
	);
}
