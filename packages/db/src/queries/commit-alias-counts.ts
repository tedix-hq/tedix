import {
	and,
	eq,
	exists,
	gt,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { coreStore, pgTextArray } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import { gitCommitAliases } from "../schema/git-commit-aliases";
import {
	workAttempts,
	workItems,
	workItemComments,
} from "../schema/work-items";
import { kernelRequests } from "../schema/kernel-requests";
import {
	externalAgentAttributions,
	externalAgentReviewEvidence,
} from "../schema/external-agent-identity";
import { learningInteractionEvents } from "../schema/learning-feedback";
import {
	workInteractions,
	workInteractionCardRevisions,
} from "../schema/work-factory";

/** Documents read back as JSON text on both stores; Postgres holds them as jsonb. */
function sources(db: DbQueryClient) {
	const postgres = coreStore(db) === "postgres";
	const text = (column: SQLWrapper) =>
		postgres
			? sql<string | null>`${column}::text`
			: sql<string | null>`${column}`;
	const object = (pairs: SQL) =>
		postgres
			? sql<string | null>`jsonb_build_object(${pairs})::text`
			: sql<string | null>`json_object(${pairs})`;
	return {
		"work_attempts.metadata": {
			table: workAttempts,
			value: text(workAttempts.metadata),
			state: sql<string | null>`${workAttempts.runtimeState}`,
			eligible: sql<number>`1`,
		},
		"work_items.metadata": {
			table: workItems,
			value: text(workItems.metadata),
			state: sql<string | null>`${workItems.disposition}`,
			eligible: sql<number>`${workItems.repositoryObserver} = 1`,
		},
		"kernel_requests.snapshot": {
			table: kernelRequests,
			value: text(kernelRequests.snapshot),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`1`,
		},
		"external_agent_attributions.target_id": {
			table: externalAgentAttributions,
			value: object(sql`'targetId', ${externalAgentAttributions.targetId}`),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`${externalAgentAttributions.targetType} = 'commit'`,
		},
		external_agent_review_evidence: {
			table: externalAgentReviewEvidence,
			value: object(
				sql`'targetId', ${externalAgentReviewEvidence.targetId}, 'repositoryVersion', ${externalAgentReviewEvidence.repositoryVersion}`,
			),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`1`,
		},
		"learning_interaction_events.metadata": {
			table: learningInteractionEvents,
			value: text(learningInteractionEvents.metadata),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`1`,
		},
		"work_interactions.metadata": {
			table: workInteractions,
			value: text(workInteractions.metadata),
			state: sql<string | null>`${workInteractions.status}`,
			eligible: sql<number>`1`,
		},
		"work_item_comments.metadata": {
			table: workItemComments,
			value: text(workItemComments.metadata),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`1`,
		},
		"work_interaction_card_revisions.proposal": {
			table: workInteractionCardRevisions,
			value: text(workInteractionCardRevisions.proposal),
			state: sql<string | null>`NULL`,
			eligible: sql<number>`1`,
		},
	} as const;
}
export type CountLocation = keyof ReturnType<typeof sources>;

async function read<T>(
	db: DbQueryClient,
	statement: SQLWrapper & PromiseLike<T>,
): Promise<T> {
	if (coreStore(db) === "d1")
		await db.all(sql`EXPLAIN QUERY PLAN ${statement.getSQL()}`);
	return await statement;
}

export function hasCommitAliases(db: DbQueryClient, repository: string) {
	return read(
		db,
		db
			.select({ present: sql<number>`1`.as("present") })
			.from(gitCommitAliases)
			.where(eq(gitCommitAliases.repository, repository))
			.limit(1),
	);
}

export function readCommitAliasCountPage(
	db: DbQueryClient,
	location: CountLocation,
	after: string,
) {
	const source = sources(db)[location];
	// Filter after paging so sparse locations cannot turn a page into a table scan.
	return read(
		db,
		db
			.select({
				id: source.table.id,
				value: source.value.as("value"),
				state: source.state.as("state"),
				eligible: source.eligible.as("eligible"),
			})
			.from(source.table)
			.where(gt(source.table.id, after))
			.orderBy(source.table.id)
			.limit(200),
	);
}

export function findStoredOldCommits(
	db: DbQueryClient,
	repository: string,
	candidates: string[],
	shortIds: boolean,
) {
	const candidate = sql<string>`candidate.value`;
	// EXISTS counts an ambiguous short prefix once without resolving it to a new id.
	const match = db
		.select({ present: sql<number>`1` })
		.from(gitCommitAliases)
		.where(
			and(
				eq(gitCommitAliases.repository, repository),
				shortIds
					? sql`${gitCommitAliases.oldSha} >= ${candidate} AND ${gitCommitAliases.oldSha} < ${candidate} || 'g'`
					: eq(gitCommitAliases.oldSha, candidate),
			),
		);
	return read(
		db,
		db
			.select({ sha: candidate.as("sha") })
			.from(
				coreStore(db) === "postgres"
					? sql`unnest(${pgTextArray(candidates)}::text[]) AS candidate(value)`
					: sql`json_each(${JSON.stringify(candidates)}) AS candidate`,
			)
			.where(exists(match))
			.limit(200),
	);
}
