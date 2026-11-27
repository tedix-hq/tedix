import { and, desc, eq, getColumns, sql, type SQL } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonWrite } from "../../core-store/dialect";
import {
	workItems,
	workItemComments,
	workItemStoredColumns,
	workAttempts,
} from "../../schema/work-items";

export function shipRunRepository(runUrl: string) {
	try {
		const url = new URL(runUrl);
		const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/\d+$/);
		return url.protocol === "https:" && url.hostname === "github.com"
			? match?.[1]
			: undefined;
	} catch {
		return undefined;
	}
}

export function shipStepScope(db: DbQueryClient, repository: string) {
	const items = coreTable(db, workItems);
	const prefix = `https://github.com/${repository}/actions/runs/`;
	return and(
		sql`${jsonRead(db, items.metadata, ["source"])} IN ('cloud-ops-ship', 'cloud-ops-postdeploy-smoke')`,
		sql`substr(${jsonRead(db, items.metadata, ["runUrl"])}, 1, ${prefix.length}) = ${prefix}`,
	);
}

function notAfter(db: DbQueryClient, time: SQL, cutoff: string) {
	return coreStore(db) === "d1"
		? sql`julianday(${time}) <= julianday(${cutoff})`
		: sql`(${time})::timestamptz <= ${cutoff}::timestamptz`;
}

/** A retry keeps the incident's owner, diagnosis and repair budget. */
export async function appendOpenShipAlert(
	db: DbQueryClient,
	p: {
		orgId: string;
		scope: SQL | undefined;
		sha: string;
		runUrl: string;
		now: string;
		metadata: Record<string, JsonValue>;
	},
) {
	const items = coreTable(db, workItems);
	const comments = coreTable(db, workItemComments);
	const attempts = coreTable(db, workAttempts);
	const [row] = await db
		.select(coreStore(db) === "d1" ? workItemStoredColumns : getColumns(items))
		.from(items)
		.where(
			and(
				eq(items.orgId, p.orgId),
				sql`${items.disposition} IN ('proposed','accepted')`,
				p.scope,
			),
		)
		.orderBy(desc(items.createdAt), desc(items.id))
		.limit(1);
	if (!row) return null;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${row.id}:${p.sha}:${p.runUrl}`),
	);
	const commentId = [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const occurredAt =
		typeof p.metadata.occurredAt === "string" ? p.metadata.occurredAt : p.now;
	await db.batch([
		db
			.insert(comments)
			.values({
				id: commentId,
				orgId: p.orgId,
				workItemId: row.id,
				authorType: "system",
				authorId: "ship",
				body: `Ship failed again at ${p.sha}.\nRun: ${p.runUrl}`,
				metadata: { source: "ship-failure", sha: p.sha, runUrl: p.runUrl },
				createdAt: p.now,
			})
			.onConflictDoNothing(),
		db
			.update(items)
			.set({
				metadata: jsonWrite(db, items.metadata, ["latestShipFailure"], {
					...p.metadata,
					sha: p.sha,
					runUrl: p.runUrl,
					occurredAt,
				}),
				updatedAt: p.now,
			})
			.where(
				and(
					eq(items.orgId, p.orgId),
					eq(items.id, row.id),
					sql`${items.disposition} IN ('proposed','accepted')`,
					notAfter(
						db,
						sql`coalesce(${jsonRead(db, items.metadata, ["latestShipFailure", "occurredAt"])}, ${occurredAt})`,
						occurredAt,
					),
				),
			),
		db
			.update(items)
			.set({
				disposition: "cancelled",
				cancelledAt: p.now,
				updatedAt: p.now,
				version: sql`${items.version} + 1`,
				metadata: jsonWrite(db, items.metadata, ["shipSupersededBy"], row.id),
			})
			.where(
				and(
					eq(items.orgId, p.orgId),
					p.scope,
					sql`${items.disposition} IN ('proposed','accepted')`,
					sql`(${items.createdAt} < ${row.createdAt} OR (${items.createdAt} = ${row.createdAt} AND ${items.id} < ${row.id}))`,
					notAfter(
						db,
						sql`coalesce(${jsonRead(db, items.metadata, ["latestShipFailure", "occurredAt"])}, ${jsonRead(db, items.metadata, ["event", "occurredAt"])}, ${items.createdAt})`,
						occurredAt,
					),
					sql`NOT EXISTS (SELECT 1 FROM ${attempts} active_attempt WHERE active_attempt.org_id = ${items.orgId} AND active_attempt.work_item_id = ${items.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${p.now}))`,
				),
			),
	]);
	return row;
}

export async function settleShipStepAlerts(
	db: DbQueryClient,
	p: {
		orgId: string;
		runUrl: string;
		steps?: string[];
		all: boolean;
		occurredAt?: string;
		now: string;
	},
) {
	const repository = shipRunRepository(p.runUrl);
	if (!repository || (!p.all && !p.steps?.length)) return;
	const items = coreTable(db, workItems);
	const attempts = coreTable(db, workAttempts);
	const step = jsonRead(db, items.metadata, ["failedJob"]);
	const recovered = p.all
		? sql`1 = 1`
		: sql`(${sql.join(
				(p.steps ?? []).map((s) =>
					s === "deploy" ? sql`${step} LIKE 'deploy:%'` : sql`${step} = ${s}`,
				),
				sql` OR `,
			)})`;
	return db
		.update(items)
		.set({
			disposition: "cancelled",
			cancelledAt: p.now,
			updatedAt: p.now,
			version: sql`${items.version} + 1`,
			metadata: jsonWrite(db, items.metadata, ["shipRecovery"], {
				runUrl: p.runUrl,
				occurredAt: p.occurredAt ?? p.now,
			}),
		})
		.where(
			and(
				eq(items.orgId, p.orgId),
				shipStepScope(db, repository),
				recovered,
				sql`${items.disposition} IN ('proposed','accepted')`,
				notAfter(
					db,
					sql`coalesce(${jsonRead(db, items.metadata, ["latestShipFailure", "occurredAt"])}, ${items.createdAt})`,
					p.occurredAt ?? p.now,
				),
				sql`NOT EXISTS (SELECT 1 FROM ${attempts} active_attempt WHERE active_attempt.org_id = ${items.orgId} AND active_attempt.work_item_id = ${items.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${p.now}))`,
			),
		)
		.returning({ id: items.id });
}
