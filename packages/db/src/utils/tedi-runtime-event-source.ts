import { getColumns, sql, type SQL } from "drizzle-orm";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";

/**
 * FROM source for a read of one run's `tedi_runtime_events`.
 *
 * Production `sqlite_stat1` rates `organization_id = ?` at the same ~515 rows
 * as the `(tedi_id, run_id)` prefix, so once a `kind IN (...)` predicate
 * multiplies the run-and-kind estimate the planner takes
 * `idx_tedi_runtime_events_org` and reads every event of the tenant (334k
 * rows per call on 23 Oct 2026, the top D1 query by total time). INDEXED BY
 * removes the choice; both indexes exist in the main and logs databases.
 */
export function tediRuntimeEventsRunSource(input: { byKind: boolean }): SQL {
	return input.byKind
		? sql`${tediRuntimeEvents} INDEXED BY idx_tedi_runtime_events_run_kind_created`
		: sql`${tediRuntimeEvents} INDEXED BY idx_tedi_runtime_events_run_created`;
}

type TediRuntimeEventColumns = typeof tediRuntimeEvents.$inferSelect;

/**
 * Full-row selection usable with {@link tediRuntimeEventsRunSource}: a bare
 * table column is rejected against an SQL source, so each column is wrapped
 * and keeps its own driver decoder (JSON payloads still parse).
 */
export function tediRuntimeEventColumns(): {
	[K in keyof TediRuntimeEventColumns]: SQL.Aliased<TediRuntimeEventColumns[K]>;
} {
	return Object.fromEntries(
		Object.entries(getColumns(tediRuntimeEvents)).map(([key, column]) => [
			key,
			sql`${column}`.mapWith(column).as(column.name),
		]),
	) as {
		[K in keyof TediRuntimeEventColumns]: SQL.Aliased<
			TediRuntimeEventColumns[K]
		>;
	};
}
