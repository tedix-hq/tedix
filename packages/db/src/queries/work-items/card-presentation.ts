import {
	and,
	eq,
	gt,
	inArray,
	isNull,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	jsonParameter,
	jsonRead,
	jsonType,
} from "../../core-store/dialect";
import { platformCronCheckpoints as checkpointsTable } from "../../schema/platform-cron-executions";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import {
	workInteractionCardPresentations as presentationsTable,
	workInteractions as interactionsTable,
	workInteractionStoredColumns,
} from "../../schema/work-factory";

/** Byte order on both stores; SQLite has no "C" collation and Postgres no BINARY. */
function binary(db: object, value: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`${value} COLLATE "C"`
		: sql`${value} COLLATE BINARY`;
}

/** The new display copy with `copyHistory` set to `history` (a JSON array). */
function withCopyHistory(
	db: object,
	presentation: DecisionCardPresentation,
	history: SQL,
): SQL {
	return coreStore(db) === "postgres"
		? sql`jsonb_set(${jsonParameter(db, presentation)}, '{copyHistory}', ${history}, true)`
		: sql`json_set(json(${JSON.stringify(presentation)}), '$.copyHistory', ${history})`;
}

/** Stored (non-generated) interaction columns of the selected store's table. */
function storedInteractionColumns(table: typeof interactionsTable) {
	return Object.fromEntries(
		Object.keys(workInteractionStoredColumns).map((key) => [
			key,
			table[key as keyof typeof workInteractionStoredColumns],
		]),
	) as typeof workInteractionStoredColumns;
}

function displayCopy(presentation: DecisionCardPresentation) {
	const { copyHistory: _, ...copy } =
		presentation as DecisionCardPresentation & { copyHistory?: unknown[] };
	return copy;
}

/** Display copy is a projection; the canonical request and its version stay immutable. */
export async function saveDecisionCardPresentation(
	db: DbQueryClient,
	input: {
		orgId: string;
		requestId: string;
		personId: string;
		expectedVersion: number;
		presentation: DecisionCardPresentation;
		onlyMissing?: boolean;
	},
) {
	const updatedAt = new Date().toISOString();
	const workInteractions = coreTable(db, interactionsTable);
	const workInteractionCardPresentations = coreTable(db, presentationsTable);
	const postgres = coreStore(db) === "postgres";
	const previous = jsonRead(
		db,
		workInteractions.metadata,
		["cardPresentation"],
		"json",
	);
	const stored = workInteractionCardPresentations.presentation;
	const [saved] = await db
		.insert(workInteractionCardPresentations)
		.select(
			db
				.select({
					orgId: workInteractions.orgId,
					interactionId: workInteractions.id,
					personId: sql<string>`${workInteractions.targetId}`.as("person_id"),
					requestVersion: workInteractions.version,
					presentation: sql<DecisionCardPresentation>`${withCopyHistory(
						db,
						input.presentation,
						sql`CASE WHEN ${jsonType(db, workInteractions.metadata, ["cardPresentation"])} = 'object'
 THEN ${postgres ? sql`jsonb_build_array(${previous})` : sql`json_array(${previous})`}
 ELSE ${postgres ? sql`'[]'::jsonb` : sql`json('[]')`} END`,
					)}`.as("presentation"),
					updatedAt: sql<string>`${updatedAt}`.as("updated_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, input.orgId),
						eq(workInteractions.id, input.requestId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.targetId, input.personId),
						eq(workInteractions.status, "open"),
						or(
							isNull(workInteractions.expiresAt),
							gt(workInteractions.expiresAt, updatedAt),
						),
						eq(workInteractions.version, input.expectedVersion),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				workInteractionCardPresentations.orgId,
				workInteractionCardPresentations.interactionId,
			],
			setWhere: input.onlyMissing
				? sql`${workInteractionCardPresentations.requestVersion}<>${input.expectedVersion}`
				: undefined,
			set: {
				personId: input.personId,
				requestVersion: input.expectedVersion,
				// Append the previous projection atomically with its replacement.
				presentation: sql<DecisionCardPresentation>`${withCopyHistory(
					db,
					input.presentation,
					postgres
						? sql`coalesce(${stored} -> 'copyHistory', '[]'::jsonb) || jsonb_build_array(${stored} - 'copyHistory')`
						: sql`json_insert(coalesce(json_extract(${stored}, '$.copyHistory'), json('[]')),
 '$[#]', json_remove(${stored}, '$.copyHistory'))`,
				)}`,
				updatedAt,
			},
		})
		.returning();
	return saved
		? { ...saved, presentation: displayCopy(saved.presentation) }
		: null;
}

export async function listDecisionCardPresentations(
	db: DbQueryClient,
	input: {
		orgId: string;
		personId: string | null;
		requests: Pick<
			typeof interactionsTable.$inferSelect,
			"id" | "version" | "targetType" | "targetId"
		>[];
	},
) {
	const requests = input.requests.filter(
		(r) => r.targetType === "user" && r.targetId === input.personId,
	);
	if (!input.personId || !requests.length) return [];
	const versions = new Map(requests.map((r) => [r.id, r.version]));
	const result: (typeof presentationsTable.$inferSelect)[] = [];
	const workInteractionCardPresentations = coreTable(db, presentationsTable);
	for (const ids of chunkForBoundParams(
		requests.map((r) => r.id),
		50,
	)) {
		const rows = await db
			.select()
			.from(workInteractionCardPresentations)
			.where(
				and(
					eq(workInteractionCardPresentations.orgId, input.orgId),
					eq(workInteractionCardPresentations.personId, input.personId),
					inArray(workInteractionCardPresentations.interactionId, ids),
				),
			);
		result.push(
			...rows
				.filter((row) => versions.get(row.interactionId) === row.requestVersion)
				.map((row) => ({
					...row,
					presentation: displayCopy(row.presentation),
				})),
		);
	}
	return result;
}

const SUMMARY_BACKFILL = "decision-card-summary-backfill:v1";

/** Platform maintenance scans at most five missing projections across tenants per tick. */
export async function listMissingCardSummaries(db: DbQueryClient, now: string) {
	const platformCronCheckpoints = coreTable(db, checkpointsTable);
	const workInteractions = coreTable(db, interactionsTable);
	const [checkpoint] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, SUMMARY_BACKFILL))
		.limit(1);
	const previous = checkpoint?.through ?? null;
	const rows = await db
		.select(storedInteractionColumns(workInteractions))
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				or(
					isNull(workInteractions.expiresAt),
					gt(workInteractions.expiresAt, now),
				),
				sql`${binary(db, sql`(${workInteractions.orgId} || ':' || ${workInteractions.id})`)} > ${previous ?? ""}`,
				sql`coalesce(${jsonType(db, workInteractions.metadata, ["cardPresentation"])}, '') <> 'object'`,
				sql`NOT EXISTS (SELECT 1 FROM work_interaction_card_presentations face
   WHERE face.org_id=${workInteractions.orgId} AND face.interaction_id=${workInteractions.id}
   AND face.person_id=${workInteractions.targetId} AND face.request_version=${workInteractions.version})`,
			),
		)
		.orderBy(
			binary(db, workInteractions.orgId),
			binary(db, workInteractions.id),
		)
		.limit(5);
	return { rows, previous };
}

/** CAS cursor keeps overlapping maintenance ticks from rewinding progress. Empty pages restart a pass. */
export async function advanceCardSummaryBackfill(
	db: DbQueryClient,
	previous: string | null,
	next: string,
) {
	const platformCronCheckpoints = coreTable(db, checkpointsTable);
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: SUMMARY_BACKFILL, through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? sql`FALSE`
					: eq(platformCronCheckpoints.through, previous),
		});
}
