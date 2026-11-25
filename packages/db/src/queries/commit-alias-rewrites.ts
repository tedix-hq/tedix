import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";
import { workAttempts, workItems } from "../schema/work-items";
import { kernelRequests } from "../schema/kernel-requests";
import { auditEvents } from "../schema/audit-events";

export async function readCommitAliasReplacements(
	db: DbQueryClient,
	repository: string,
	candidates: string[],
) {
	const edges = new Map<string, string>();
	let frontier = [...new Set(candidates)];
	for (let hop = 0; hop < 4 && frontier.length; hop++) {
		const query = db
			.select({
				oldSha: gitCommitAliases.oldSha,
				newSha: gitCommitAliases.newSha,
			})
			.from(gitCommitAliases)
			.where(
				and(
					eq(gitCommitAliases.repository, repository),
					sql`${gitCommitAliases.oldSha} IN (SELECT value FROM json_each(${JSON.stringify(frontier)}))`,
				),
			);
		await db.all(sql`EXPLAIN QUERY PLAN ${query.getSQL()}`);
		const rows = await query;
		for (const row of rows) edges.set(row.oldSha, row.newSha);
		frontier = [...new Set(rows.map((row) => row.newSha))].filter(
			(sha) => !edges.has(sha) && !/^0{40}$/.test(sha),
		);
	}
	return [...new Set(candidates)]
		.filter((sha) => edges.has(sha))
		.map((oldSha) => {
			let newSha = oldSha;
			const seen = new Set([oldSha]);
			for (let hop = 0; hop < 4; hop++) {
				const next = edges.get(newSha);
				if (!next) break;
				if (seen.has(next)) throw new Error("Cyclic commit alias chain");
				seen.add(next);
				newSha = next;
			}
			return { oldSha, newSha };
		});
}

export type RewriteLocation =
	| "work_attempts.metadata"
	| "work_items.metadata"
	| "kernel_requests.snapshot";
export interface CommitAliasRewriteRecord {
	id: string;
	before: string;
	after: string;
	changes: Array<{ from: string; to: string }>;
}

/** Audit and CAS update share the same D1 transaction; no audit for a lost CAS. */
export async function rewriteCommitAliasBatch(
	db: DbQueryClient,
	input: {
		location: RewriteLocation;
		runId: string;
		repository: string;
		actor: { actorId: string; actorType: string };
		records: CommitAliasRewriteRecord[];
	},
) {
	if (!input.records.length || input.records.length > 4)
		throw new Error("Rewrite batches require 1–4 records");
	const table =
		input.location === "work_attempts.metadata"
			? workAttempts
			: input.location === "work_items.metadata"
				? workItems
				: kernelRequests;
	const value =
		input.location === "kernel_requests.snapshot"
			? kernelRequests.snapshot
			: input.location === "work_items.metadata"
				? workItems.metadata
				: workAttempts.metadata;
	const org =
		input.location === "kernel_requests.snapshot"
			? kernelRequests.organizationId
			: input.location === "work_items.metadata"
				? workItems.orgId
				: workAttempts.orgId;
	const statements = input.records.flatMap((row) => {
		const predicate = and(
			eq(table.id, row.id),
			sql`${value} = ${row.before}`,
			table === workAttempts
				? inArray(workAttempts.runtimeState, [
						"queued",
						"running",
						"waiting",
						"retrying",
					])
				: table === workItems
					? eq(workItems.repositoryObserver, 1)
					: undefined,
		);
		const audit = db.insert(auditEvents).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					organizationId: sql<string>`${org}`.as("organization_id"),
					actorId: sql<string>`${input.actor.actorId}`.as("actor_id"),
					actorType: sql<string>`${input.actor.actorType}`.as("actor_type"),
					action: sql<string>`'commit_alias.rewritten'`.as("action"),
					resourceType: sql<string>`${input.location}`.as("resource_type"),
					resourceId: sql<string>`${table.id}`.as("resource_id"),
					metadata: sql<
						Record<string, unknown>
					>`${JSON.stringify({ runId: input.runId, repository: input.repository, changes: row.changes })}`.as(
						"metadata",
					),
					ipAddress: sql<string | null>`NULL`.as("ip_address"),
					userAgent: sql<string | null>`NULL`.as("user_agent"),
					timestamp: sql<Date>`unixepoch()`.as("timestamp"),
				})
				.from(table)
				.where(predicate),
		);
		const update =
			table === kernelRequests
				? db
						.update(kernelRequests)
						.set({
							snapshot: sql`${row.after}`,
							version: sql`${kernelRequests.version} + 1`,
						})
						.where(predicate)
						.returning({ id: kernelRequests.id })
				: table === workItems
					? db
							.update(workItems)
							.set({
								metadata: sql`${row.after}`,
								version: sql`${workItems.version} + 1`,
							})
							.where(predicate)
							.returning({ id: workItems.id })
					: db
							.update(workAttempts)
							.set({
								metadata: sql`${row.after}`,
								version: sql`${workAttempts.version} + 1`,
							})
							.where(predicate)
							.returning({ id: workAttempts.id });
		return [audit, update];
	});
	// Explain every statement before execution, including the audit's SELECT.
	for (const statement of statements as SQLWrapper[])
		await db.all(sql`EXPLAIN QUERY PLAN ${statement.getSQL()}`);
	const results = await db.batch(
		statements as [
			(typeof statements)[number],
			...(typeof statements)[number][],
		],
	);
	const changed = results
		.filter((_, index) => index % 2 === 1)
		.reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
	if (changed !== input.records.length)
		throw new Error(
			"Commit alias rewrite CAS conflict; stop and resume from the last returned cursor",
		);
	return changed;
}
